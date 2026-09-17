/**
 * File: src/core/AuthStateTracker.js
 * Description: Persists and resolves active auth index state across server restarts
 */

const fs = require("fs");
const path = require("path");

class AuthStateTracker {
    /**
     * @param {Object} [logger] - Logger instance
     * @param {string} [filePath] - Custom JSON file path for testing
     */
    constructor(logger = console, filePath = null) {
        this.logger = logger;
        this.filePath = filePath || path.join(process.cwd(), "data", "auth-state.json");
    }

    /**
     * Get the last recorded active auth index
     * @returns {number|null}
     */
    getLastAuthIndex() {
        try {
            if (!fs.existsSync(this.filePath)) {
                return null;
            }
            const rawContent = fs.readFileSync(this.filePath, "utf-8");
            const data = JSON.parse(rawContent);
            if (data && Number.isInteger(data.lastActiveAuthIndex) && data.lastActiveAuthIndex >= 0) {
                return data.lastActiveAuthIndex;
            }
            return null;
        } catch (error) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AuthStateTracker] Failed to read auth state from ${this.filePath}: ${error.message}`
                );
            }
            return null;
        }
    }

    /**
     * Save active auth index to persistent file
     * @param {number} authIndex
     * @returns {boolean}
     */
    saveLastAuthIndex(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return false;
        }
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = {
                lastActiveAuthIndex: authIndex,
                updatedAt: new Date().toISOString(),
            };
            const tempFile = `${this.filePath}.tmp.${Date.now()}`;
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
            fs.renameSync(tempFile, this.filePath);
            return true;
        } catch (error) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AuthStateTracker] Failed to save auth state to ${this.filePath}: ${error.message}`);
            }
            return false;
        }
    }

    /**
     * Resolve startup index and order based on persisted index, envInitialIndex, and available accounts
     * @param {Object} params
     * @param {number[]} params.availableIndices
     * @param {number[]} params.rotationIndices
     * @param {Function} [params.canonicalIndexGetter]
     * @param {number|null} [params.envInitialIndex]
     * @returns {{ chosenIndex: number, startupOrder: number[], source: "persisted" | "persisted_fallback" | "env" | "default" }}
     */
    resolveStartupIndex({
        availableIndices = [],
        rotationIndices = [],
        canonicalIndexGetter = idx => idx,
        envInitialIndex = null,
    }) {
        const pool = rotationIndices.length > 0 ? [...rotationIndices] : [...availableIndices];
        if (pool.length === 0) {
            return { chosenIndex: null, source: "default", startupOrder: [] };
        }

        const sortedPool = [...pool].sort((a, b) => a - b);
        const persisted = this.getLastAuthIndex();

        // 1. Try persisted index
        if (persisted !== null) {
            const canonicalPersisted =
                typeof canonicalIndexGetter === "function" ? canonicalIndexGetter(persisted) : persisted;
            const targetPersisted = canonicalPersisted !== null ? canonicalPersisted : persisted;

            if (pool.includes(targetPersisted)) {
                const startupOrder = [targetPersisted, ...pool.filter(i => i !== targetPersisted)];
                return { chosenIndex: targetPersisted, source: "persisted", startupOrder };
            }

            // Persisted account unavailable -> Fallback to next available in rotation pool
            const nextCandidate = sortedPool.find(idx => idx > persisted);
            const chosenIndex = nextCandidate !== undefined ? nextCandidate : sortedPool[0];
            const startupOrder = [chosenIndex, ...pool.filter(i => i !== chosenIndex)];
            return { chosenIndex, source: "persisted_fallback", startupOrder };
        }

        // 2. Try envInitialIndex
        if (Number.isInteger(envInitialIndex)) {
            const canonicalEnv =
                typeof canonicalIndexGetter === "function" ? canonicalIndexGetter(envInitialIndex) : envInitialIndex;
            const targetEnv = canonicalEnv !== null ? canonicalEnv : envInitialIndex;

            if (pool.includes(targetEnv)) {
                const startupOrder = [targetEnv, ...pool.filter(i => i !== targetEnv)];
                return { chosenIndex: targetEnv, source: "env", startupOrder };
            }
        }

        // 3. Default to first in pool
        const chosenIndex = pool[0];
        const startupOrder = [...pool];
        return { chosenIndex, source: "default", startupOrder };
    }
}

module.exports = AuthStateTracker;
