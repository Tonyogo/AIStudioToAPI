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
     */
    constructor(authSource, connectionRegistry, logger = console, browserManager = null) {
        this.authSource = authSource;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.currentIndex = 0;
        this.accountStatusMap = new Map();
        this.lastSystemActivityAt = 0;
        this.idleTimeoutMs = 300000;
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
     * Select next available authIndex using Round-Robin scheduling
     * @returns {Promise<number>} The selected authIndex
     * @throws {Error} If no connected authIndex is available
     */
    async getNextAuthIndex() {
        this.lastSystemActivityAt = Date.now();
        const indices = this._getAccountIndices();
        if (indices.length === 0) {
            const err = new Error("No authentication accounts configured");
            err.statusCode = 503;
            throw err;
        }

        const total = indices.length;
        // 1. Try to find an ACTIVATED account first
        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this._hasConnection(candidateIdx) && this.getAccountStatus(candidateIdx) === "ACTIVATED") {
                this.currentIndex = (this.currentIndex + i + 1) % total;
                if (this.logger && typeof this.logger.debug === "function") {
                    this.logger.debug(`[AccountScheduler] Selected ACTIVATED authIndex #${candidateIdx}`);
                }
                return candidateIdx;
            }
        }

        // 2. Fallback: Find first online INACTIVE account and activate it synchronously
        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this._hasConnection(candidateIdx)) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(`[AccountScheduler] No ACTIVATED accounts available, synchronously activating authIndex #${candidateIdx}...`);
                }
                const activated = await this.activateAccount(candidateIdx);
                if (activated) {
                    this.currentIndex = (this.currentIndex + i + 1) % total;
                    return candidateIdx;
                }
            }
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
                this.logger.warn(`[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`);
            }
            return false;
        }

        this.setAccountStatus(authIndex, "ACTIVATING");
        try {
            await this.browserManager.launchOrSwitchContext(authIndex);
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
