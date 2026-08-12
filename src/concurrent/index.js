/**
 * File: index.js
 * Description: Facade entrypoint for the concurrent multi-account subsystem
 */

const AccountScheduler = require("./AccountScheduler");
const ConcurrentRequestHandler = require("./ConcurrentRequestHandler");
const ModelUsageTracker = require("./ModelUsageTracker");

/**
 * Initialize concurrent mode components and attach routes to Express app
 * @param {Object} app - Express application instance
 * @param {Object} system - ProxyServerSystem instance
 * @returns {Object} Initialized concurrent components
 */
function initConcurrentMode(app, system) {
    const isConcurrentMode = process.env.ENABLE_CONCURRENT === "true";
    if (!isConcurrentMode) {
        return null;
    }

    if (!system) {
        throw new Error("[Concurrent] ProxyServerSystem instance is required to initialize concurrent mode");
    }

    const authSource = system.authSource;
    const connectionRegistry = system.connectionRegistry;
    const logger = system.logger || console;
    const modelList = system.config ? system.config.modelList : [];
    const browserManager = system.browserManager || null;

    if (logger && typeof logger.info === "function") {
        logger.info("[Concurrent] Initializing concurrent multi-account forwarding subsystem...");
    }

    const modelUsageTracker = new ModelUsageTracker(logger);
    const config = system.config || {};
    const scheduler = new AccountScheduler(
        authSource,
        connectionRegistry,
        logger,
        browserManager,
        modelUsageTracker,
        modelList,
        config
    );

    if (browserManager && typeof browserManager.setAccountScheduler === "function") {
        browserManager.setAccountScheduler(scheduler);
    }

    const usageStatsService = system.usageStatsService || null;
    const concurrentRequestHandler = new ConcurrentRequestHandler(
        connectionRegistry,
        scheduler,
        logger,
        modelList,
        usageStatsService
    );

    concurrentRequestHandler.registerRoutes(app);

    return {
        concurrentRequestHandler,
        modelUsageTracker,
        scheduler,
    };
}

module.exports = {
    AccountScheduler,
    ConcurrentRequestHandler,
    initConcurrentMode,
};
