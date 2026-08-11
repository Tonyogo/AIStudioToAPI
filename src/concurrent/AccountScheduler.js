/**
 * File: AccountScheduler.js
 * Description: Round-Robin account scheduler for concurrent multi-account request routing
 */

const { selectCandidate } = require("./strategies");
const ModelUsageTracker = require("./ModelUsageTracker");

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
        this.activeQueue = null;
        this.accountStatusMap = new Map();
        this.inFlightMap = new Map();
        this.failureCountMap = new Map();
        this.maxInFlightPerAccount = 2;
        this.activatedLifespanMs = 120000;
        this.lastGlobalActivationAt = 0;
        this.activationCooldownMs = 30000;
        this.isActivatingAny = false;
        this.immediateSwitchStatusCodes =
            Array.isArray(config?.immediateSwitchStatusCodes) && config.immediateSwitchStatusCodes.length > 0
                ? config.immediateSwitchStatusCodes
                : [429, 503];
        this.lastStatusCodeMap = new Map();
        this.currentCycleKey = this.getBeijingCycleKey();
    }

    /**
     * Calculate Beijing 15:00 cycle key by delegating to ModelUsageTracker
     * @param {Date} [nowDate]
     * @returns {string}
     */
    getBeijingCycleKey(nowDate = new Date()) {
        if (this.modelUsageTracker && typeof this.modelUsageTracker.getBeijingCycleKey === "function") {
            return this.modelUsageTracker.getBeijingCycleKey(nowDate);
        }
        return ModelUsageTracker.getBeijingCycleKey(nowDate);
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
            this.lastStatusCodeMap.clear();
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
     * Resolve scheduling strategy name for a given model
     * Priority: 1. Model override in models.json -> 2. Global config/env -> 3. "round-robin"
     * @param {string} modelName
     * @returns {string} Strategy name ("weighted" | "round-robin" | "least-used")
     */
    getSchedulingStrategy(modelName) {
        if (modelName && Array.isArray(this.modelList)) {
            const match = this.modelList.find(m => {
                if (!m || !m.name) return false;
                const cleanName = m.name.replace("models/", "");
                return cleanName === modelName || m.name === modelName;
            });
            if (match && typeof match.schedulingStrategy === "string" && match.schedulingStrategy.trim() !== "") {
                return match.schedulingStrategy.trim().toLowerCase();
            }
        }

        const globalStrategy = this.config?.concurrentSchedulingStrategy || process.env.CONCURRENT_SCHEDULING_STRATEGY;
        if (typeof globalStrategy === "string" && globalStrategy.trim() !== "") {
            return globalStrategy.trim().toLowerCase();
        }

        return "round-robin";
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
     * Record failure for an account
     * @param {number} authIndex
     * @param {number} statusCode
     */
    recordFailure(authIndex, statusCode) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        if (this.getAccountStatus(authIndex) === "RETIRED") return;
        if (typeof statusCode === "number") {
            this.lastStatusCodeMap.set(authIndex, statusCode);
        }

        // Always increment consecutive failure count
        const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
        this.failureCountMap.set(authIndex, currentFailures);
    }

    /**
     * Record success for an account, resetting its consecutive failure counter
     * @param {number} authIndex
     */
    recordSuccess(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        this.failureCountMap.set(authIndex, 0);
        this.lastStatusCodeMap.delete(authIndex);
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
     * Move authIndex to the front of activeQueue (LRU Most Recently Used)
     * @private
     * @param {number} authIndex
     */
    _moveToFront(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        this._refreshActiveQueue();
        this.activeQueue = this.activeQueue.filter(idx => idx !== authIndex);
        this.activeQueue.unshift(authIndex);
    }

    /**
     * Move authIndex to the back of activeQueue (LRU Least Recently Used / Retired)
     * @private
     * @param {number} authIndex
     */
    _moveToBack(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        this._refreshActiveQueue();
        this.activeQueue = this.activeQueue.filter(idx => idx !== authIndex);
        this.activeQueue.push(authIndex);
    }

    /**
     * Synchronize and refresh the LRU active queue with current auth source indices
     * @private
     */
    _refreshActiveQueue() {
        const indices = this._getAccountIndices();
        if (!this.activeQueue) {
            this.activeQueue = [...indices];
            return;
        }

        const currentSet = new Set(this.activeQueue);
        const incomingSet = new Set(indices);

        // Filter out removed accounts
        this.activeQueue = this.activeQueue.filter(idx => incomingSet.has(idx));

        // Append new accounts to the end
        for (const idx of indices) {
            if (!currentSet.has(idx)) {
                this.activeQueue.push(idx);
            }
        }
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
     * Check if account should be retired based on failure threshold or immediate switch status codes
     * @param {number} authIndex
     * @returns {Promise<boolean>}
     */
    async checkAndRetireAccount(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return false;
        if (this.getAccountStatus(authIndex) === "RETIRED") return false;

        const failureThreshold = this.config?.failureThreshold || 3;
        const consecutiveFailures = this.failureCountMap.get(authIndex) || 0;
        const lastStatusCode = this.lastStatusCodeMap.get(authIndex);

        let shouldRetire = false;
        let reason = "";

        const isImmediateSwitch =
            typeof lastStatusCode === "number" && this.immediateSwitchStatusCodes.includes(lastStatusCode);

        if (isImmediateSwitch) {
            shouldRetire = true;
            reason = `received immediate switch status code ${lastStatusCode}`;
        } else if (consecutiveFailures >= failureThreshold) {
            shouldRetire = true;
            reason = `reached ${consecutiveFailures} consecutive failures (threshold: ${failureThreshold})`;
        }

        if (shouldRetire) {
            this.lastStatusCodeMap.delete(authIndex);
            await this.retireAndReplaceAccount(authIndex, reason);
            return true;
        }
        return false;
    }

    /**
     * Rebalance concurrent context pool based on dynamic priorities and state restoration
     */
    async rebalanceConcurrentPool() {
        if (this.logger && typeof this.logger.info === "function") {
            this.logger.info("[ConcurrentPool] Triggering concurrent context pool rebalance...");
        }
        if (!this.browserManager) return;

        const maxContexts = this.getMaxContexts();
        const isUnlimited = maxContexts === Infinity || maxContexts === 0;

        this._refreshActiveQueue();

        const healthy = [];
        const retired = [];

        for (const idx of this.activeQueue) {
            const isExpired =
                this.authSource && typeof this.authSource.isExpired === "function"
                    ? this.authSource.isExpired(idx)
                    : false;
            if (isExpired) continue;

            const status = this.getAccountStatus(idx);
            if (status === "RETIRED") {
                retired.push(idx);
            } else {
                healthy.push(idx);
            }
        }

        // Implicitly maintains LRU queue order: healthy first (recently used), RETIRED last (earliest retired first)
        const priorityQueue = [...healthy, ...retired];

        const targetIndices = isUnlimited ? priorityQueue : priorityQueue.slice(0, maxContexts);
        const targets = new Set(targetIndices);

        // Restore state for target candidates if currently RETIRED
        for (const targetIdx of targetIndices) {
            if (this.getAccountStatus(targetIdx) === "RETIRED") {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[ConcurrentPool] Re-activating retired account #${targetIdx} back to INACTIVE as target candidate`
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
                    if (this.logger && typeof this.logger.info === "function") {
                        this.logger.info(
                            `[ConcurrentPool] Closing excess active context #${activeIdx} (not in targets=[${[...targets]}])`
                        );
                    }
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
                    `[ConcurrentPool] Rebalancing concurrent pool: targets=[${[...targets]}], preloading candidates=[${candidates}]`
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

        // Move retired index to end of activeQueue (LRU Update)
        this._moveToBack(authIndex);

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

        const activatedFree = []; // inFlight === 0
        const activatedBusy = []; // inFlight === 1
        const inactiveCandidates = []; // INACTIVE & inFlight < 2

        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this.getAccountStatus(candidateIdx) === "RETIRED") {
                continue;
            }
            if (this._hasConnection(candidateIdx)) {
                onlineAccountCount++;
                const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
                const inFlight = this.getInFlightCount(candidateIdx);
                if (inFlight >= this.maxInFlightPerAccount) {
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

        const totalActivated = activatedFree.length + activatedBusy.length;
        const canCooldown =
            this.lastGlobalActivationAt === 0 || Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs;
        const maxContexts = this.getMaxContexts();
        const strategyName = this.getSchedulingStrategy(modelName);
        const strategyContext = { limit, modelName };

        // Baseline Check: If activated count < maxContexts and inactive candidates exist and 30s cooldown met, trigger background baseline activation
        if (totalActivated < maxContexts && inactiveCandidates.length > 0 && canCooldown) {
            const baselineCandidate = selectCandidate(strategyName, inactiveCandidates, strategyContext);
            const baselineIndex = inactiveCandidates.indexOf(baselineCandidate);
            if (baselineIndex > -1) {
                inactiveCandidates.splice(baselineIndex, 1);
            }
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
            const selectedCandidate = selectCandidate(strategyName, activatedFree, strategyContext);
            const selectedIdx = selectedCandidate.idx;
            const selectedOrder = selectedCandidate.order;
            const weight = Math.max(1, limit - selectedCandidate.usage);
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 1: Free Activated, strategy="${strategyName}", inFlight=0, usage=${selectedCandidate.usage}/${limit}, weight=${weight})`
                );
            }

            // Move selected index to front of activeQueue (LRU Update)
            this._moveToFront(selectedIdx);

            return selectedIdx;
        }

        // Phase 2: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
        if (activatedBusy.length > 0) {
            const selectedCandidate = selectCandidate(strategyName, activatedBusy, strategyContext);
            const selectedIdx = selectedCandidate.idx;
            const selectedOrder = selectedCandidate.order;
            const weight = Math.max(1, limit - selectedCandidate.usage);
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 2: Lightly Busy, strategy="${strategyName}", inFlight=1, usage=${selectedCandidate.usage}/${limit}, weight=${weight})`
                );
            }

            // Move selected index to front of activeQueue (LRU Update)
            this._moveToFront(selectedIdx);

            return selectedIdx;
        }

        // Error classification: If online connected accounts exist, any dispatch failure means all accounts are busy
        if (onlineAccountCount > 0) {
            const error = new Error("All available accounts are busy");
            error.statusCode = 503;
            error.statusText = "UNAVAILABLE";
            throw error;
        }

        const error = new Error("No active context connection available");
        error.statusCode = 503;
        error.statusText = "UNAVAILABLE";
        throw error;
    }

    /**
     * Select a candidate using configured strategy
     * @param {Array<Object>} candidates - List of candidates { idx, inFlight, order, usage }
     * @param {number} limit - Daily limit for current model
     * @param {string} [modelName=null] - Model name
     * @returns {Object|null} Selected candidate
     */
    selectWeightedCandidate(candidates, limit, modelName = null) {
        return selectCandidate("weighted", candidates, { limit, modelName });
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

    /**
     * Sleep helper supporting AbortSignal
     * @private
     */
    _sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                const err = new Error("Client request aborted during wait");
                err.name = "AbortError";
                return reject(err);
            }

            let timer = null;
            let onAbort = null;

            if (signal) {
                onAbort = () => {
                    if (timer) clearTimeout(timer);
                    const err = new Error("Client request aborted during wait");
                    err.name = "AbortError";
                    reject(err);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }

            timer = setTimeout(() => {
                if (signal && onAbort) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve();
            }, ms);
        });
    }

    /**
     * Acquire next available auth index with polling wait and timeout handling
     * @param {string} modelName
     * @param {Object} [options]
     * @param {number} [options.timeoutMs]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<number>} Selected authIndex
     */
    async acquireNextAuthIndex(modelName, options = {}) {
        const timeoutMs = options.timeoutMs || this.config?.concurrentWaitTimeoutMs || 60000;
        const signal = options.signal || null;
        const POLL_INTERVAL_MS = 3000;
        const start = Date.now();

        for (;;) {
            if (signal?.aborted) {
                const err = new Error("Client request aborted during wait");
                err.name = "AbortError";
                throw err;
            }

            try {
                const authIndex = await this.getNextAuthIndex(modelName);
                this.acquireInFlight(authIndex);
                return authIndex;
            } catch (err) {
                const elapsed = Date.now() - start;
                const remaining = timeoutMs - elapsed;

                if (remaining <= 0) {
                    const timeoutErr = new Error(
                        `All available accounts are busy (waited ${Math.round(elapsed / 1000)}s)`
                    );
                    timeoutErr.statusCode = 503;
                    timeoutErr.statusText = "UNAVAILABLE";
                    throw timeoutErr;
                }

                const sleepDuration = Math.min(POLL_INTERVAL_MS, remaining);
                await this._sleep(sleepDuration, signal);
            }
        }
    }
}

module.exports = AccountScheduler;
