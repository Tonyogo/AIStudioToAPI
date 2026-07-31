/**
 * File: index.js
 * Description: Facade entrypoint for the concurrent multi-account subsystem
 */

const AccountScheduler = require("./AccountScheduler");
const ConcurrentRequestHandler = require("./ConcurrentRequestHandler");

/**
 * Initialize concurrent mode components and attach routes to Express app
 * @param {Object} app - Express application instance
 * @param {Object} dependencies - Core system dependencies
 * @param {Object} dependencies.authSource - AuthSource instance
 * @param {Object} dependencies.connectionRegistry - ConnectionRegistry instance
 * @param {Object} [dependencies.formatConverter] - FormatConverter instance
 * @param {Object} [dependencies.logger] - Logger instance
 * @param {Array} [dependencies.modelList] - Model configuration list
 * @returns {Object} Initialized concurrent components
 */
function initConcurrentMode(app, dependencies) {
    const { authSource, connectionRegistry, formatConverter, logger = console, modelList = [] } = dependencies;

    if (logger && typeof logger.info === "function") {
        logger.info("[Concurrent] Initializing concurrent multi-account forwarding subsystem...");
    }

    const scheduler = new AccountScheduler(authSource, connectionRegistry, logger);
    const concurrentRequestHandler = new ConcurrentRequestHandler(
        connectionRegistry,
        scheduler,
        formatConverter,
        logger,
        modelList
    );

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
