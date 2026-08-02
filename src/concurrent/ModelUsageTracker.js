/**
 * File: ModelUsageTracker.js
 * Description: Tracks model request counts per account reset daily at Beijing 15:00:00 (UTC+8)
 */

const fs = require("fs");
const path = require("path");

class ModelUsageTracker {
    /**
     * @param {Object} [logger] - Logger instance
     * @param {string} [filePath] - Custom JSON file path
     */
    constructor(logger = console, filePath = null) {
        this.logger = logger;
        this.filePath = filePath || path.join(process.cwd(), "data", "concurrent-model-usage.json");
        this.currentCycleKey = this.getBeijingCycleKey();
        this.stats = {}; // authIndex -> { modelName -> count }
        this.saveTimeout = null;

        this.loadSync();
    }

    /**
     * Calculate Beijing 15:00 cycle key (YYYY-MM-DD_15:00)
     * @param {Date} [nowDate]
     * @returns {string}
     */
    getBeijingCycleKey(nowDate = new Date()) {
        const beijingTime = new Date(nowDate.getTime() + 8 * 3600 * 1000);
        const year = beijingTime.getUTCFullYear();
        const month = String(beijingTime.getUTCMonth() + 1).padStart(2, "0");
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
     * Check if cycle key changed and reset stats if needed
     */
    _checkAndResetCycle() {
        const newKey = this.getBeijingCycleKey();
        if (newKey !== this.currentCycleKey) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[ModelUsageTracker] Resetting model usage cycle from ${this.currentCycleKey} to ${newKey}`);
            }
            this.currentCycleKey = newKey;
            this.stats = {};
            this.saveSync();
        }
    }

    /**
     * Get usage count for given authIndex and modelName
     * @param {number} authIndex
     * @param {string} modelName
     * @returns {number}
     */
    getUsage(authIndex, modelName) {
        this._checkAndResetCycle();
        if (!this.stats[authIndex] || !modelName) {
            return 0;
        }
        return this.stats[authIndex][modelName] || 0;
    }

    /**
     * Record usage for given authIndex and modelName
     * @param {number} authIndex
     * @param {string} modelName
     */
    recordUsage(authIndex, modelName) {
        if (authIndex === undefined || authIndex < 0 || !modelName) return;

        this._checkAndResetCycle();
        if (!this.stats[authIndex]) {
            this.stats[authIndex] = {};
        }
        this.stats[authIndex][modelName] = (this.stats[authIndex][modelName] || 0) + 1;

        this.scheduleDebouncedSave();
    }

    /**
     * Schedule debounced save to file (500ms)
     */
    scheduleDebouncedSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            this.saveSync();
        }, 500);
    }

    /**
     * Synchronously load stats from JSON file
     */
    loadSync() {
        try {
            if (fs.existsSync(this.filePath)) {
                const content = fs.readFileSync(this.filePath, "utf-8");
                const data = JSON.parse(content);
                const currentKey = this.getBeijingCycleKey();
                if (data && data.cycleKey === currentKey && data.stats) {
                    this.currentCycleKey = data.cycleKey;
                    this.stats = data.stats;
                } else {
                    this.currentCycleKey = currentKey;
                    this.stats = {};
                }
            }
        } catch (e) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[ModelUsageTracker] Failed to load stats from file: ${e.message}`);
            }
            this.stats = {};
        }
    }

    /**
     * Synchronously save stats to JSON file
     */
    saveSync() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = {
                cycleKey: this.currentCycleKey,
                stats: this.stats,
            };
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
        } catch (e) {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[ModelUsageTracker] Failed to save stats to file: ${e.message}`);
            }
        }
    }
}

module.exports = ModelUsageTracker;
