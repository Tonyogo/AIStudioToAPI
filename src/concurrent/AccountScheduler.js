/**
 * File: AccountScheduler.js
 * Description: Round-Robin account scheduler for concurrent multi-account request routing
 */

class AccountScheduler {
    /**
     * @param {Object} authSource - AuthSource instance containing available accounts
     * @param {Object} connectionRegistry - ConnectionRegistry instance managing WebSocket connections
     * @param {Object} [logger] - Logger instance
     */
    constructor(authSource, connectionRegistry, logger = console) {
        this.authSource = authSource;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.currentIndex = 0;
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
     * @returns {number} The selected authIndex
     * @throws {Error} If no connected authIndex is available
     */
    getNextAuthIndex() {
        const indices = this._getAccountIndices();
        if (indices.length === 0) {
            const err = new Error("No authentication accounts configured");
            err.statusCode = 503;
            throw err;
        }

        const total = indices.length;
        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this._hasConnection(candidateIdx)) {
                this.currentIndex = (this.currentIndex + i + 1) % total;
                if (this.logger && typeof this.logger.debug === "function") {
                    this.logger.debug(`[AccountScheduler] Selected authIndex #${candidateIdx}`);
                }
                return candidateIdx;
            }
        }

        const error = new Error("No active context connection available");
        error.statusCode = 503;
        throw error;
    }
}

module.exports = AccountScheduler;
