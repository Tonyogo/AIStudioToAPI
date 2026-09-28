#!/usr/bin/env node
/**
 * File: scripts/cloudshell/runCloudShell.js
 * Description: Standalone CLI entrypoint for Google Cloud Shell multi-context runner
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { parseCliArgs, printHelp } = require("./options");
const { launchBrowser } = require("./browserSetup");
const { CloudShellManager } = require("./CloudShellManager");

const main = async () => {
    let options;
    try {
        options = parseCliArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`[CloudShell] ❌ CLI argument error: ${err.message}`);
        printHelp();
        process.exit(1);
    }

    if (options.help) {
        printHelp();
        process.exit(0);
    }

    let browser = null;
    let manager = null;

    const cleanup = async () => {
        if (manager) {
            try {
                await manager.stop();
            } catch {
                // ignore
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch {
                // ignore
            }
        }
    };

    process.on("SIGINT", async () => {
        console.log("\n[CloudShell] 🛑 Received SIGINT (Ctrl+C). Cleaning up and exiting...");
        await cleanup();
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        console.log("\n[CloudShell] 🛑 Received SIGTERM. Cleaning up and exiting...");
        await cleanup();
        process.exit(0);
    });

    try {
        manager = new CloudShellManager(null, options);
        manager.validateAuthFiles();

        browser = await launchBrowser(options);
        manager.browser = browser;

        console.log("==================================================");
        console.log(`🚀 [CloudShell] Starting runner for Account(s): [${manager.authIndices.join(", ")}]`);
        console.log(`   Mode: ${options.headless ? "Headless" : "Headed"}`);
        if (options.proxy) console.log(`   Proxy: ${options.proxy}`);
        console.log(
            `   Keep-alive: ${options.keepAliveMinutes === -1 ? "Infinite" : `${options.keepAliveMinutes} min`}`
        );
        if (manager.authIndices.length > 1) {
            console.log(`   Rotation interval: every ${options.switchIntervalMinutes} min`);
        }
        console.log("==================================================");

        await manager.init();

        if (options.keepAliveMinutes !== 0) {
            await manager.startRotationAndKeepAliveLoop();
        }

        console.log("[CloudShell] ✅ All operations completed successfully.");
        await cleanup();
        process.exit(0);
    } catch (err) {
        console.error(`[CloudShell] ❌ Fatal error: ${err.message}`);
        await cleanup();
        process.exit(1);
    }
};

if (require.main === module) {
    main();
}

module.exports = { main };
