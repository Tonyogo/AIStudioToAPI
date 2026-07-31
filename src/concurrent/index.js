/**
 * File: index.js
 * Description: Facade entrypoint for the concurrent multi-account subsystem
 */

const AccountScheduler = require("./AccountScheduler");
const ConcurrentRequestHandler = require("./ConcurrentRequestHandler");

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

    if (logger && typeof logger.info === "function") {
        logger.info("[Concurrent] Initializing concurrent multi-account forwarding subsystem...");
    }

    const scheduler = new AccountScheduler(authSource, connectionRegistry, logger);
    const concurrentRequestHandler = new ConcurrentRequestHandler(connectionRegistry, scheduler, logger, modelList);

    concurrentRequestHandler.registerRoutes(app);

    return {
        concurrentRequestHandler,
        scheduler,
    };
}

module.exports = {
    AccountScheduler,
    ConcurrentRequestHandler,
    initConcurrentMode,
};
