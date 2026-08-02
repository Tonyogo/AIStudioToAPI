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

        // Check if online accounts exist and if all online accounts are capped
        let onlineAccountCount = 0;
        let cappedOnlineAccountCount = 0;

        const candidateList = [];
        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this._hasConnection(candidateIdx)) {
                onlineAccountCount++;
                const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
                if (usage >= limit) {
                    cappedOnlineAccountCount++;
                    continue; // Exclude accounts that reached limit
                }
                if (this.getAccountStatus(candidateIdx) === "ACTIVATED") {
                    candidateList.push({ idx: candidateIdx, order: i, usage });
                }
            }
        }

        if (candidateList.length > 0) {
            // Sort primary by usage ascending, secondary by Round-Robin relative order
            candidateList.sort((a, b) => {
                if (a.usage !== b.usage) {
                    return a.usage - b.usage;
                }
                return a.order - b.order;
            });

            const selectedIdx = candidateList[0].idx;
            const selectedOrder = candidateList[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Selected least-used authIndex #${selectedIdx} for model="${modelName}" (usage=${candidateList[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Fallback: Find first online INACTIVE account that is NOT capped, and activate it synchronously
        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this._hasConnection(candidateIdx)) {
                const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
                if (usage >= limit) {
                    continue;
                }
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[AccountScheduler] No ACTIVATED accounts available, synchronously activating authIndex #${candidateIdx}...`
                    );
                }
                const activated = await this.activateAccount(candidateIdx);
                if (activated) {
                    this.currentIndex = (this.currentIndex + i + 1) % total;
                    return candidateIdx;
                }
            }
        }

        // If online accounts exist but ALL are capped by dailyLimit, throw 429
        if (onlineAccountCount > 0 && cappedOnlineAccountCount >= onlineAccountCount) {
            const error = new Error(`All accounts reached daily limit of ${limit} requests for model "${modelName}"`);
            error.statusCode = 429;
            error.statusText = "RESOURCE_EXHAUSTED";
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
