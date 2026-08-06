/**
 * File: AccountScheduler.js
 * Description: Round-Robin account scheduler for concurrent multi-account request routing
 */

class AccountScheduler {
    /**
     * @param {Object} authSource - AuthSource instance containing available accounts
     * @param {Object} connectionRegistry - ConnectionRegistry instance managing WebSocket connections
     * @param {Object} [logger] - Logger instance
     * @param {Object} [browserManager] - BrowserManager instance
     * @param {Object} [modelUsageTracker] - ModelUsageTracker instance
     * @param {Array} [modelList=[]] - List of configured models and their limits
     * @param {Object} [config={}] - Configuration options including failureThreshold and exhaustedModelsThreshold
     */
    constructor(
        authSource,
        connectionRegistry,
        logger = console,
        browserManager = null,
        modelUsageTracker = null,
        modelList = [],
        config = {}
    ) {
        this.authSource = authSource;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.modelUsageTracker = modelUsageTracker;
        this.modelList = modelList;
        this.config = config;
        this.currentIndex = 0;
        this.accountStatusMap = new Map();
        this.inFlightMap = new Map();
        this.failureCountMap = new Map();
        this.suspendedUntilMap = new Map();
        this.maxInFlightPerAccount = 2;
        this.lastSystemActivityAt = 0;
        this.idleTimeoutMs = 300000;
        this.activatedLifespanMs = 120000;
        this.lastGlobalActivationAt = 0;
        this.activationCooldownMs = 30000;
        this.isActivatingAny = false;
        this.suspensionDurationMs =
            typeof config?.concurrentSuspensionDurationMs === "number" && config.concurrentSuspensionDurationMs >= 0
                ? config.concurrentSuspensionDurationMs
                : 20000;
        this.currentCycleKey = this.getBeijingCycleKey();
    }

    /**
     * Calculate Beijing 15:00 cycle key (YYYY-MM-DD_15:00)
     * @param {Date} [nowDate]
     * @returns {string}
     */
    getBeijingCycleKey(nowDate = new Date()) {
        const beijingTime = new Date(nowDate.getTime() + 8 * 3600 * 1000);
        const year = beijingTime.getUTCFullYear();
        const day = beijingTime.getUTCDate();
        const hours = beijingTime.getUTCHours();

        const cycleDate = new Date(Date.UTC(year, beijingTime.getUTCMonth(), day));
        if (hours < 15) {
            cycleDate.setUTCDate(cycleDate.getUTCDate() - 1);
        }

        const cYear = cycleDate.getUTCFullYear();
        const cMonth = String(cycleDate.getUTCMonth() + 1).padStart(2, "0");
        const cDay = String(cycleDate.getUTCDate()).padStart(2, "0");

        return `${cYear}-${cMonth}-${cDay}_15:00`;
    }

    /**
     * Check if cycle key changed and reset account statuses and failure counts if needed
     */
    _checkAndResetCycle() {
        const newKey = this.getBeijingCycleKey();
        if (newKey !== this.currentCycleKey) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Resetting account retirement cycle from ${this.currentCycleKey} to ${newKey}`
                );
            }
            this.currentCycleKey = newKey;

            for (const [authIndex, entry] of this.accountStatusMap.entries()) {
                if (entry && entry.status === "RETIRED") {
                    this.accountStatusMap.set(authIndex, {
                        ...entry,
                        status: "INACTIVE",
                    });
                }
            }
            this.failureCountMap.clear();
            this.suspendedUntilMap.clear();
        }
    }

    /**
     * Get maximum contexts limit from config (0 means unlimited)
     * @returns {number}
     */
    getMaxContexts() {
        const mc = this.config?.maxContexts;
        if (typeof mc === "number" && mc >= 0) {
            return mc === 0 ? Infinity : mc;
        }
        return 1;
    }

    /**
     * Get the configured daily limit for a specific model
     * @param {string} modelName - Model name
     * @returns {number} Daily limit or Infinity
     */
    getModelDailyLimit(modelName) {
        if (!Array.isArray(this.modelList) || this.modelList.length === 0) return 1000;
        if (!modelName) return 1000;
        const match = this.modelList.find(m => {
            if (!m || !m.name) return false;
            const cleanName = m.name.replace("models/", "");
            return cleanName === modelName || m.name === modelName;
        });
        if (match && typeof match.dailyLimit === "number" && match.dailyLimit > 0) {
            return match.dailyLimit;
        }
        return 1000;
    }

    /**
     * Check if system is active (received request within idleTimeoutMs)
     * @returns {boolean}
     */
    isSystemActive() {
        return Date.now() - this.lastSystemActivityAt < this.idleTimeoutMs;
    }

    /**
     * Start background activation loop
     * @param {number} [intervalMs=30000]
     */
    startActivationLoop(intervalMs = 30000) {
        if (this._activationTimer) return;
        this._activationTimer = setInterval(async () => {
            if (!this.isSystemActive()) {
                if (this.logger && typeof this.logger.debug === "function") {
                    this.logger.debug("[AccountScheduler] System is idle, skipping background account activation");
                }
                return;
            }

            const indices = this._getAccountIndices();
            for (const idx of indices) {
                if (this.getAccountStatus(idx) === "RETIRED") continue;
                if (this._hasConnection(idx) && this.getAccountStatus(idx) === "INACTIVE") {
                    if (this.logger && typeof this.logger.info === "function") {
                        this.logger.info(
                            `[AccountScheduler] Lazy loading activation loop activating authIndex #${idx}...`
                        );
                    }
                    await this.activateAccount(idx);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }, intervalMs);
    }

    /**
     * Stop background activation loop
     */
    stopActivationLoop() {
        if (this._activationTimer) {
            clearInterval(this._activationTimer);
            this._activationTimer = null;
        }
    }

    /**
     * Automatically refresh all account statuses, expiring ACTIVATED accounts whose lifespan exceeded 2 mins
     */
    _refreshAccountStatuses() {
        this._checkAndResetCycle();
        const now = Date.now();
        for (const [authIndex, entry] of this.accountStatusMap.entries()) {
            if (entry && entry.status === "ACTIVATED") {
                const elapsed = now - (entry.lastActivatedAt || 0);
                if (elapsed >= this.activatedLifespanMs) {
                    const inFlight = this.getInFlightCount(authIndex);
                    if (inFlight === 0) {
                        if (this.logger && typeof this.logger.info === "function") {
                            this.logger.info(
                                `[AccountScheduler] AuthIndex #${authIndex} activation expired back to INACTIVE (lifespan: ${Math.round(elapsed / 1000)}s)`
                            );
                        }
                        this.setAccountStatus(authIndex, "INACTIVE");
                    }
                }
            }
        }
    }

    /**
     * Get account status for given auth index
     * @param {number} authIndex
     * @returns {string}
     */
    getAccountStatus(authIndex) {
        this._checkAndResetCycle();
        const entry = this.accountStatusMap.get(authIndex);
        return entry ? entry.status : "INACTIVE";
    }

    /**
     * Set account status for given auth index
     * @param {number} authIndex
     * @param {string} status
     */
    setAccountStatus(authIndex, status) {
        this._checkAndResetCycle();
        const existing = this.accountStatusMap.get(authIndex) || { lastActivatedAt: null, lastRequestAt: null };
        this.accountStatusMap.set(authIndex, {
            ...existing,
            lastActivatedAt: status === "ACTIVATED" ? Date.now() : existing.lastActivatedAt,
            status,
        });
    }

    /**
     * Check if account is currently suspended
     * @param {number} authIndex
     * @returns {boolean}
     */
    isAccountSuspended(authIndex) {
        const suspendedUntil = this.suspendedUntilMap.get(authIndex) || 0;
        return Date.now() < suspendedUntil;
    }

    /**
     * Record failure for an account and trigger suspension if threshold reached
     * @param {number} authIndex
     * @param {number} statusCode
     */
    recordFailure(authIndex, statusCode) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        if (this.getAccountStatus(authIndex) === "RETIRED") return;
        const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
        this.failureCountMap.set(authIndex, currentFailures);

        const secondsStr = `${Math.round(this.suspensionDurationMs / 1000)} seconds`;
        if (statusCode === 429) {
            this.suspendedUntilMap.set(authIndex, Date.now() + this.suspensionDurationMs);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] AuthIndex #${authIndex} suspended for ${secondsStr} due to HTTP 429 rate limit`
                );
            }
        } else if (currentFailures >= 2) {
            this.suspendedUntilMap.set(authIndex, Date.now() + this.suspensionDurationMs);
            this.failureCountMap.set(authIndex, 0);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] AuthIndex #${authIndex} suspended for ${secondsStr} due to 2 consecutive failures`
                );
            }
        }
    }

    /**
     * Record success for an account, resetting its consecutive failure counter
     * @param {number} authIndex
     */
    recordSuccess(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        this.failureCountMap.set(authIndex, 0);
    }

    /**
     * Get current in-flight request count for given authIndex
     * @param {number} authIndex
     * @returns {number}
     */
    getInFlightCount(authIndex) {
        return this.inFlightMap.get(authIndex) || 0;
    }

    /**
     * Increment in-flight count for given authIndex
     * @param {number} authIndex
     */
    acquireInFlight(authIndex) {
        if (authIndex === undefined || authIndex < 0) return;
        const current = this.getInFlightCount(authIndex);
        this.inFlightMap.set(authIndex, current + 1);
    }

    /**
     * Decrement in-flight count for given authIndex
     * @param {number} authIndex
     */
    releaseInFlight(authIndex) {
        if (authIndex === undefined || authIndex < 0) return;
        const current = this.getInFlightCount(authIndex);
        this.inFlightMap.set(authIndex, Math.max(0, current - 1));
    }

    /**
     * Get all candidate auth indices from authSource
     * @returns {number[]}
     */
    _getAccountIndices() {
        if (!this.authSource) {
            return [];
        }
        return this.authSource.availableIndices || [];
    }

    /**
     * Check if connection registry has active connection for given auth index
     * @param {number} authIndex
     * @returns {boolean}
     */
    _hasConnection(authIndex) {
        if (!this.connectionRegistry) {
            return false;
        }
        if (this.connectionRegistry.connectionsByAuth) {
            return this.connectionRegistry.connectionsByAuth.has(authIndex);
        }
        if (typeof this.connectionRegistry.hasConnection === "function") {
            return this.connectionRegistry.hasConnection(authIndex);
        }
        return false;
    }

    /**
     * Record usage for a specific account and model
     * @param {number} authIndex
     * @param {string} modelName
     */
    recordUsage(authIndex, modelName) {
        if (this.modelUsageTracker && typeof this.modelUsageTracker.recordUsage === "function") {
            this.modelUsageTracker.recordUsage(authIndex, modelName);
        }
    }

    /**
     * Check if account should be retired based on model daily limits or failure threshold
     * @param {number} authIndex
     * @returns {Promise<boolean>}
     */
    async checkAndRetireAccount(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return false;
        if (this.getAccountStatus(authIndex) === "RETIRED") return false;

        let exhaustedCount = 0;
        const modelList =
            Array.isArray(this.modelList) && this.modelList.length > 0
                ? this.modelList
                : [{ name: "models/gemini-2.5-flash" }];
        for (const modelConfig of modelList) {
            if (!modelConfig || !modelConfig.name) continue;
            const cleanName = modelConfig.name.replace("models/", "");
            const limit = this.getModelDailyLimit(cleanName);
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(authIndex, cleanName) : 0;
            if (usage >= limit) {
                exhaustedCount++;
            }
        }

        const maxExhausted = this.config?.exhaustedModelsThreshold || 1;
        const failureThreshold = this.config?.failureThreshold || 3;
        const consecutiveFailures = this.failureCountMap.get(authIndex) || 0;

        let shouldRetire = false;
        let reason = "";

        if (exhaustedCount >= maxExhausted) {
            shouldRetire = true;
            reason = `reached daily usage limit on ${exhaustedCount} model(s) (threshold: ${maxExhausted})`;
        } else if (consecutiveFailures >= failureThreshold) {
            shouldRetire = true;
            reason = `reached ${consecutiveFailures} consecutive failures (threshold: ${failureThreshold})`;
        }

        if (shouldRetire) {
            await this.retireAndReplaceAccount(authIndex, reason);
            return true;
        }
        return false;
    }

    /**
     * Rebalance concurrent context pool based on dynamic priorities and state restoration
     */
    async rebalanceConcurrentPool() {
        if (!this.browserManager) return;

        const maxContexts = this.getMaxContexts();
        const isUnlimited = maxContexts === Infinity || maxContexts === 0;

        const indices = this._getAccountIndices();

        // 1. Filter out expired auth sources
        const validIndices = indices.filter(idx => {
            const isExpired =
                this.authSource && typeof this.authSource.isExpired === "function"
                    ? this.authSource.isExpired(idx)
                    : false;
            return !isExpired;
        });

        const healthy = [];
        const retired = [];

        for (const idx of validIndices) {
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(idx) : 0;
            const status = this.getAccountStatus(idx);
            if (status === "RETIRED") {
                retired.push({ idx, usage });
            } else {
                healthy.push({ idx, usage });
            }
        }

        healthy.sort((a, b) => a.usage - b.usage);
        retired.sort((a, b) => a.usage - b.usage);

        // Dynamic priority queue: healthy first (least-used), RETIRED last (least-used)
        const priorityQueue = [...healthy.map(h => h.idx), ...retired.map(r => r.idx)];

        const targetIndices = isUnlimited ? priorityQueue : priorityQueue.slice(0, maxContexts);
        const targets = new Set(targetIndices);

        // Restore state for target candidates if currently RETIRED
        for (const targetIdx of targetIndices) {
            if (this.getAccountStatus(targetIdx) === "RETIRED") {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[AccountScheduler] Re-activating retired account #${targetIdx} back to INACTIVE as target candidate`
                    );
                }
                this.setAccountStatus(targetIdx, "INACTIVE");
                this.failureCountMap.set(targetIdx, 0);
            }
        }

        // Close excess contexts not in targets
        if (this.browserManager.contexts && typeof this.browserManager.contexts.keys === "function") {
            for (const activeIdx of this.browserManager.contexts.keys()) {
                if (!targets.has(activeIdx)) {
                    if (typeof this.browserManager._closeContextForPoolIfPossible === "function") {
                        this.browserManager._closeContextForPoolIfPossible(activeIdx, "rebalance_retired");
                    }
                }
            }
        }

        // Candidates: target indices not yet initialized in contexts Map
        const activeContexts =
            this.browserManager.contexts && typeof this.browserManager.contexts.keys === "function"
                ? new Set(this.browserManager.contexts.keys())
                : new Set();
        const candidates = targetIndices.filter(idx => !activeContexts.has(idx));

        if (candidates.length > 0) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Rebalancing concurrent pool: targets=[${[...targets]}], preloading candidates=[${candidates}]`
                );
            }
            if (typeof this.browserManager._preloadBackgroundContexts === "function") {
                this.browserManager._preloadBackgroundContexts(candidates, isUnlimited ? 0 : maxContexts);
            }
        }
    }

    /**
     * Deprioritize an account to RETIRED status and trigger dynamic concurrent pool rebalance
     * @param {number} authIndex
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async retireAndReplaceAccount(authIndex, reason) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] Deprioritizing account #${authIndex} as RETIRED: ${reason}`);
        }

        this.setAccountStatus(authIndex, "RETIRED");

        this.rebalanceConcurrentPool().catch(err => {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[AccountScheduler] Background rebalance failed after retirement: ${err.message}`);
            }
        });
    }

    /**
     * Select next available authIndex using Round-Robin scheduling and model usage tracking
     * @param {string} [modelName=null] - Optional model name for least-used scheduling
     * @returns {Promise<number>} The selected authIndex
     * @throws {Error} If no connected authIndex is available
     */
    async getNextAuthIndex(modelName = null) {
        this._refreshAccountStatuses();
        this.lastSystemActivityAt = Date.now();
        const indices = this._getAccountIndices();
        if (indices.length === 0) {
            const err = new Error("No authentication accounts configured");
            err.statusCode = 503;
            throw err;
        }

        // Auto-sync browserManager.currentAuthIndex as ACTIVATED if online and currently INACTIVE
        if (this.browserManager && typeof this.browserManager._currentAuthIndex === "number") {
            const currentIdx = this.browserManager._currentAuthIndex;
            if (
                currentIdx >= 0 &&
                this.getAccountStatus(currentIdx) !== "RETIRED" &&
                this._hasConnection(currentIdx) &&
                this.getAccountStatus(currentIdx) === "INACTIVE"
            ) {
                this.setAccountStatus(currentIdx, "ACTIVATED");
            }
        }

        const limit = this.getModelDailyLimit(modelName);
        const total = indices.length;

        let onlineAccountCount = 0;
        let busyOnlineAccountCount = 0;

        const activatedFree = []; // inFlight === 0
        const activatedBusy = []; // inFlight === 1
        const inactiveCandidates = []; // INACTIVE & inFlight < 2

        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this.getAccountStatus(candidateIdx) === "RETIRED") {
                continue;
            }
            if (this._hasConnection(candidateIdx)) {
                if (this.isAccountSuspended(candidateIdx)) {
                    if (this.logger && typeof this.logger.debug === "function") {
                        this.logger.debug(
                            `[AccountScheduler] AuthIndex #${candidateIdx} skipped: account is suspended`
                        );
                    }
                    continue;
                }
                onlineAccountCount++;
                const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
                const inFlight = this.getInFlightCount(candidateIdx);
                if (inFlight >= this.maxInFlightPerAccount) {
                    busyOnlineAccountCount++;
                    if (this.logger && typeof this.logger.debug === "function") {
                        this.logger.debug(
                            `[AccountScheduler] AuthIndex #${candidateIdx} skipped: max in-flight limit reached (${inFlight}/${this.maxInFlightPerAccount})`
                        );
                    }
                    continue;
                }

                const status = this.getAccountStatus(candidateIdx);
                if (status === "ACTIVATED") {
                    if (inFlight === 0) {
                        activatedFree.push({ idx: candidateIdx, inFlight, order: i, usage });
                    } else {
                        activatedBusy.push({ idx: candidateIdx, inFlight, order: i, usage });
                    }
                } else if (status === "INACTIVE") {
                    inactiveCandidates.push({ idx: candidateIdx, inFlight, order: i, usage });
                }
            }
        }

        // Sort function: primary by usage ascending, secondary by Round-Robin order
        const usageSort = (a, b) => {
            if (a.usage !== b.usage) {
                return a.usage - b.usage;
            }
            return a.order - b.order;
        };

        const totalActivated = activatedFree.length + activatedBusy.length;
        const canCooldown =
            this.lastGlobalActivationAt === 0 || Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs;
        const maxContexts = this.getMaxContexts();

        // Baseline Check: If activated count < maxContexts and inactive candidates exist and 30s cooldown met, trigger background baseline activation
        if (totalActivated < maxContexts && inactiveCandidates.length > 0 && canCooldown) {
            inactiveCandidates.sort(usageSort);
            const baselineCandidate = inactiveCandidates.shift();
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Activated accounts count (${totalActivated}) < maxContexts (${maxContexts}), activating authIndex #${baselineCandidate.idx} for baseline...`
                );
            }
            const activated = await this.activateAccount(baselineCandidate.idx);
            if (activated) {
                activatedFree.push(baselineCandidate);
            }
        }

        // Phase 1: Use an absolutely free ACTIVATED account (inFlight === 0)
        if (activatedFree.length > 0) {
            activatedFree.sort(usageSort);
            const selectedIdx = activatedFree[0].idx;
            const selectedOrder = activatedFree[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 1: Free Activated, inFlight=0, usage=${activatedFree[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Phase 2: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
        if (activatedBusy.length > 0) {
            activatedBusy.sort(usageSort);
            const selectedIdx = activatedBusy[0].idx;
            const selectedOrder = activatedBusy[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 2: Lightly Busy, inFlight=1, usage=${activatedBusy[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Phase 3: Forced fallback activation (when no ACTIVATED accounts exist or activated count < maxContexts)
        if (inactiveCandidates.length > 0 && totalActivated < maxContexts) {
            inactiveCandidates.sort(usageSort);
            for (const candidate of inactiveCandidates) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(`[AccountScheduler] Synchronously activating authIndex #${candidate.idx}...`);
                }
                const activated = await this.activateAccount(candidate.idx);
                if (activated) {
                    this.currentIndex = (this.currentIndex + candidate.order + 1) % total;
                    if (this.logger && typeof this.logger.info === "function") {
                        this.logger.info(
                            `[AccountScheduler] Selected authIndex #${candidate.idx} for model="${modelName}" (Phase 3: Fallback Activated, inFlight=0, usage=${candidate.usage}/${limit})`
                        );
                    }
                    return candidate.idx;
                }
            }
        }

        // Error classification
        if (onlineAccountCount > 0 && busyOnlineAccountCount >= onlineAccountCount) {
            const error = new Error(
                `All available accounts are busy at maximum concurrency limit (${this.maxInFlightPerAccount}/${this.maxInFlightPerAccount})`
            );
            error.statusCode = 503;
            error.statusText = "UNAVAILABLE";
            throw error;
        }

        const error = new Error("No active context connection available");
        error.statusCode = 503;
        throw error;
    }

    /**
     * Mark an account as ACTIVATED
     * @param {number} authIndex
     */
    markAccountActivated(authIndex) {
        if (this.getAccountStatus(authIndex) === "RETIRED") return;
        this.setAccountStatus(authIndex, "ACTIVATED");
    }

    /**
     * Mark an account as INACTIVE
     * @param {number} authIndex
     */
    markAccountInactive(authIndex) {
        if (this.getAccountStatus(authIndex) === "RETIRED") return;
        this.setAccountStatus(authIndex, "INACTIVE");
    }

    /**
     * Activate a specific account by authIndex using BrowserManager native switch
     * @param {number} authIndex
     * @returns {Promise<boolean>}
     */
    async activateAccount(authIndex) {
        if (this.getAccountStatus(authIndex) === "RETIRED") return false;
        if (!this.browserManager) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`
                );
            }
            return false;
        }

        if (this.isActivatingAny) {
            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Skipping activation for account #${authIndex}: another account activation is currently in progress`
                );
            }
            return false;
        }

        const elapsed = Date.now() - this.lastGlobalActivationAt;
        if (this.lastGlobalActivationAt > 0 && elapsed < this.activationCooldownMs) {
            const remaining = Math.ceil((this.activationCooldownMs - elapsed) / 1000);
            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Skipping activation for account #${authIndex}: 30s global cooldown active (${remaining}s remaining)`
                );
            }
            return false;
        }

        this.isActivatingAny = true;
        this.lastGlobalActivationAt = Date.now();
        this.setAccountStatus(authIndex, "ACTIVATING");
        try {
            await this.browserManager.launchOrSwitchContext(authIndex);
            this.setAccountStatus(authIndex, "ACTIVATED");
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[AccountScheduler] Account #${authIndex} successfully activated via BrowserManager`);
            }
            return true;
        } catch (error) {
            this.setAccountStatus(authIndex, "INACTIVE");
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[AccountScheduler] Failed to activate account #${authIndex}: ${error.message}`);
            }
            return false;
        } finally {
            this.isActivatingAny = false;
        }
    }
}

module.exports = AccountScheduler;
