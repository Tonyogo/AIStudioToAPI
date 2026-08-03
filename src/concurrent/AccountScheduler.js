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
     */
    constructor(
        authSource,
        connectionRegistry,
        logger = console,
        browserManager = null,
        modelUsageTracker = null,
        modelList = []
    ) {
        this.authSource = authSource;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.modelUsageTracker = modelUsageTracker;
        this.modelList = modelList;
        this.currentIndex = 0;
        this.accountStatusMap = new Map();
        this.inFlightMap = new Map();
        this.failureCountMap = new Map();
        this.suspendedUntilMap = new Map();
        this.maxInFlightPerAccount = 2;
        this.lastSystemActivityAt = 0;
        this.idleTimeoutMs = 300000;
        this.lastGlobalActivationAt = 0;
        this.activationCooldownMs = 30000;
    }

    /**
     * Get the configured daily limit for a specific model
     * @param {string} modelName - Model name
     * @returns {number} Daily limit or Infinity
     */
    getModelDailyLimit(modelName) {
        if (!modelName || !Array.isArray(this.modelList)) return Infinity;
        const match = this.modelList.find(m => {
            if (!m || !m.name) return false;
            const cleanName = m.name.replace("models/", "");
            return cleanName === modelName || m.name === modelName;
        });
        if (match && typeof match.dailyLimit === "number" && match.dailyLimit > 0) {
            return match.dailyLimit;
        }
        return Infinity;
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
     * Get account status for given auth index
     * @param {number} authIndex
     * @returns {string}
     */
    getAccountStatus(authIndex) {
        const entry = this.accountStatusMap.get(authIndex);
        return entry ? entry.status : "INACTIVE";
    }

    /**
     * Set account status for given auth index
     * @param {number} authIndex
     * @param {string} status
     */
    setAccountStatus(authIndex, status) {
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
        if (authIndex === undefined || authIndex < 0) return;
        const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
        this.failureCountMap.set(authIndex, currentFailures);

        if (statusCode === 429) {
            this.suspendedUntilMap.set(authIndex, Date.now() + 60000);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AccountScheduler] AuthIndex #${authIndex} suspended for 1 minute due to HTTP 429 rate limit`);
            }
        } else if (currentFailures >= 2) {
            this.suspendedUntilMap.set(authIndex, Date.now() + 60000);
            this.failureCountMap.set(authIndex, 0);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AccountScheduler] AuthIndex #${authIndex} suspended for 1 minute due to 2 consecutive failures`);
            }
        }
    }

    /**
     * Record success for an account, resetting its consecutive failure counter
     * @param {number} authIndex
     */
    recordSuccess(authIndex) {
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
     * Select next available authIndex using Round-Robin scheduling and model usage tracking
     * @param {string} [modelName=null] - Optional model name for least-used scheduling
     * @returns {Promise<number>} The selected authIndex
     * @throws {Error} If no connected authIndex is available
     */
    async getNextAuthIndex(modelName = null) {
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
                this._hasConnection(currentIdx) &&
                this.getAccountStatus(currentIdx) === "INACTIVE"
            ) {
                this.setAccountStatus(currentIdx, "ACTIVATED");
            }
        }

        const limit = this.getModelDailyLimit(modelName);
        const total = indices.length;

        let onlineAccountCount = 0;
        let cappedOnlineAccountCount = 0;
        let busyOnlineAccountCount = 0;

        const activatedFree = []; // inFlight === 0
        const activatedBusy = []; // inFlight === 1
        const inactiveCandidates = []; // INACTIVE & inFlight < 2

        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
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
                if (usage >= limit) {
                    cappedOnlineAccountCount++;
                    if (this.logger && typeof this.logger.debug === "function") {
                        this.logger.debug(
                            `[AccountScheduler] AuthIndex #${candidateIdx} skipped: daily limit reached (${usage}/${limit}) for model="${modelName}"`
                        );
                    }
                    continue;
                }
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

        // Baseline = 2 Check: If activated count < 2 and inactive candidates exist and 30s cooldown met, trigger background baseline activation
        if (totalActivated < 2 && inactiveCandidates.length > 0 && canCooldown) {
            inactiveCandidates.sort(usageSort);
            const baselineCandidate = inactiveCandidates.shift();
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Activated accounts count (${totalActivated}) < 2, activating authIndex #${baselineCandidate.idx} for baseline...`
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

        // Phase 2: Proactive Scale-Out: If all ACTIVATED accounts have inFlight > 0 and INACTIVE accounts exist, try activating one if 30s cooldown met
        if (inactiveCandidates.length > 0 && canCooldown) {
            inactiveCandidates.sort(usageSort);
            for (const candidate of inactiveCandidates) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[AccountScheduler] Proactively activating INACTIVE authIndex #${candidate.idx} to spread concurrent load...`
                    );
                }
                const activated = await this.activateAccount(candidate.idx);
                if (activated) {
                    this.currentIndex = (this.currentIndex + candidate.order + 1) % total;
                    if (this.logger && typeof this.logger.info === "function") {
                        this.logger.info(
                            `[AccountScheduler] Selected authIndex #${candidate.idx} for model="${modelName}" (Phase 2: Proactive Activated, inFlight=0, usage=${candidate.usage}/${limit})`
                        );
                    }
                    return candidate.idx;
                }
            }
        }

        // Phase 3: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
        if (activatedBusy.length > 0) {
            activatedBusy.sort(usageSort);
            const selectedIdx = activatedBusy[0].idx;
            const selectedOrder = activatedBusy[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 3: Lightly Busy, inFlight=1, usage=${activatedBusy[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Phase 4: Forced fallback activation (when no ACTIVATED accounts exist or all are capped at inFlight >= 2)
        if (inactiveCandidates.length > 0) {
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
                            `[AccountScheduler] Selected authIndex #${candidate.idx} for model="${modelName}" (Phase 4: Fallback Activated, inFlight=0, usage=${candidate.usage}/${limit})`
                        );
                    }
                    return candidate.idx;
                }
            }
        }

        // Error classification
        if (onlineAccountCount > 0 && cappedOnlineAccountCount >= onlineAccountCount) {
            const error = new Error(`All accounts reached daily limit of ${limit} requests for model "${modelName}"`);
            error.statusCode = 429;
            error.statusText = "RESOURCE_EXHAUSTED";
            throw error;
        }

        if (onlineAccountCount > 0 && busyOnlineAccountCount + cappedOnlineAccountCount >= onlineAccountCount) {
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
        this.setAccountStatus(authIndex, "ACTIVATED");
    }

    /**
     * Mark an account as INACTIVE
     * @param {number} authIndex
     */
    markAccountInactive(authIndex) {
        this.setAccountStatus(authIndex, "INACTIVE");
    }

    /**
     * Activate a specific account by authIndex using BrowserManager native switch
     * @param {number} authIndex
     * @returns {Promise<boolean>}
     */
    async activateAccount(authIndex) {
        if (!this.browserManager) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`
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

        this.setAccountStatus(authIndex, "ACTIVATING");
        try {
            await this.browserManager.launchOrSwitchContext(authIndex);
            this.lastGlobalActivationAt = Date.now();
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
        }
    }
}

module.exports = AccountScheduler;
