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

        const limit = this.getModelDailyLimit(modelName);
        const total = indices.length;

        let onlineAccountCount = 0;
        let cappedOnlineAccountCount = 0;
        let busyOnlineAccountCount = 0;

        const activatedFree = [];  // inFlight === 0
        const activatedBusy = [];  // inFlight === 1
        const inactiveCandidates = []; // INACTIVE & inFlight < 2

        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this._hasConnection(candidateIdx)) {
                onlineAccountCount++;
                const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
                if (usage >= limit) {
                    cappedOnlineAccountCount++;
                    continue;
                }
                const inFlight = this.getInFlightCount(candidateIdx);
                if (inFlight >= this.maxInFlightPerAccount) {
                    busyOnlineAccountCount++;
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

        // Phase 1: Use an absolutely free ACTIVATED account (inFlight === 0)
        if (activatedFree.length > 0) {
            activatedFree.sort(usageSort);
            const selectedIdx = activatedFree[0].idx;
            const selectedOrder = activatedFree[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Selected free ACTIVATED authIndex #${selectedIdx} for model="${modelName}" (usage=${activatedFree[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Phase 2: Proactive Scale-Out: If all ACTIVATED accounts have inFlight > 0 and INACTIVE accounts exist, try activating one if 30s cooldown met
        const canCooldown = this.lastGlobalActivationAt === 0 || (Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs);
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

            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Selected busy ACTIVATED authIndex #${selectedIdx} for model="${modelName}" (inFlight=1, usage=${activatedBusy[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Phase 4: Forced fallback activation (when no ACTIVATED accounts exist or all are capped at inFlight >= 2)
        if (inactiveCandidates.length > 0) {
            inactiveCandidates.sort(usageSort);
            for (const candidate of inactiveCandidates) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[AccountScheduler] Synchronously activating authIndex #${candidate.idx}...`
                    );
                }
                const activated = await this.activateAccount(candidate.idx);
                if (activated) {
                    this.currentIndex = (this.currentIndex + candidate.order + 1) % total;
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
     * Activate a specific account by authIndex
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
            const page = this.browserManager.page;
            if (typeof this.browserManager._sendActiveTrigger === "function") {
                this.browserManager._sendActiveTrigger("[AccountScheduler]", page);
            }
            this.setAccountStatus(authIndex, "ACTIVATED");
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[AccountScheduler] Account #${authIndex} successfully activated`);
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
