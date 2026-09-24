#!/usr/bin/env node
/**
 * File: scripts/cloudshell/runCloudShell.js
 * Description: Standalone CLI entrypoint for Google Cloud Shell automation
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { parseCliArgs, printHelp } = require("./options");
const { launchCloudShellBrowser } = require("./browserSetup");
const { CloudShellController } = require("./CloudShellController");

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

    let commandsToExecute = [];
    if (options.cmd) {
        commandsToExecute.push(...options.cmd.split(/\r?\n/));
    }
    if (options.filePath) {
        const fullScriptPath = path.resolve(process.cwd(), options.filePath);
        if (!fs.existsSync(fullScriptPath)) {
            console.error(`[CloudShell] ❌ Script file not found: ${fullScriptPath}`);
            process.exit(1);
        }
        const fileContent = fs.readFileSync(fullScriptPath, "utf-8");
        const lines = fileContent.split(/\r?\n/);
        commandsToExecute = commandsToExecute.concat(lines);
    }

    console.log("==================================================");
    console.log(`🚀 [CloudShell] Starting runner for Account #${options.authIndex}`);
    console.log(`   Mode: ${options.headless ? "Headless" : "Headed"}`);
    if (options.proxy) console.log(`   Proxy: ${options.proxy}`);
    console.log(`   Keep-alive: ${options.keepAliveMinutes === -1 ? "Infinite" : `${options.keepAliveMinutes} min`}`);
    console.log("==================================================");

    let browser = null;
    let context = null;
    let controller = null;

    const cleanup = async () => {
        if (controller) {
            controller.stopKeepAliveLoop();
        }
        if (context) {
            try {
                await context.close();
            } catch {
                // ignore context close error
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch {
                // ignore browser close error
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
        const launched = await launchCloudShellBrowser(options);
        browser = launched.browser;
        context = launched.context;

        const page = await context.newPage();
        controller = new CloudShellController(page, options);

        await controller.navigate();
        await controller.waitForTerminalReady();

        if (commandsToExecute.length > 0) {
            console.log(`[CloudShell] 📋 Executing ${commandsToExecute.length} command(s)...`);
            await controller.executeCommands(commandsToExecute);
        } else {
            console.log("[CloudShell] ℹ️ No command provided to execute (--cmd or --file).");
        }

        if (options.debug) {
            await controller.saveDebugArtifacts("completed");
        }

        if (options.keepAliveMinutes !== 0) {
            await controller.startKeepAliveLoop(options.keepAliveMinutes, options.heartbeatIntervalSeconds);
        }

        console.log("[CloudShell] ✅ All operations completed successfully.");
        await cleanup();
        process.exit(0);
    } catch (err) {
        console.error(`[CloudShell] ❌ Fatal error: ${err.message}`);
        if (controller && options.debug) {
            await controller.saveDebugArtifacts("fatal_error");
        }
        await cleanup();
        process.exit(1);
    }
};

if (require.main === module) {
    main();
}

module.exports = { main };
