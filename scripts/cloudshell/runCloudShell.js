#!/usr/bin/env node
/**
 * File: scripts/cloudshell/runCloudShell.js
 * Description: Management CLI entrypoint for Google Cloud Shell (start, status, stop, restart, logs)
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

const { parseCliArgs, printHelp } = require("./options");
const { launchBrowser } = require("./browserSetup");
const { CloudShellManager } = require("./CloudShellManager");
const { StateTracker } = require("./stateTracker");
const { DaemonManager } = require("./daemonManager");

const handleStatus = (options, stateTracker, daemonManager) => {
    const pid = daemonManager.getPid();
    const isAlive = pid ? daemonManager.isProcessAlive(pid) : false;
    const state = stateTracker.loadState();
    console.log(stateTracker.formatStatusOutput(state, isAlive));

    const rawArgs = process.argv.slice(2);
    const hasExplicitCommand = rawArgs.length > 0 && !rawArgs[0].startsWith("-");
    if (!hasExplicitCommand) {
        console.log("");
        printHelp();
    }
};

const handleStop = async (options, daemonManager) => {
    const result = await daemonManager.stopDaemon(options.force);
    console.log(result.message);
    process.exit(0);
};

const handleLogs = (options, daemonManager) => {
    const watcher = daemonManager.tailLogs(options.follow);
    if (!options.follow) {
        process.exit(0);
    }
    process.on("SIGINT", () => {
        if (watcher && typeof watcher.close === "function") {
            watcher.close();
        }
        process.exit(0);
    });
};

const handlePause = (stateTracker, daemonManager) => {
    const pid = daemonManager.getPid();
    const isAlive = pid ? daemonManager.isProcessAlive(pid) : false;
    if (!isAlive) {
        console.log("CloudShell is not running. Nothing to pause.");
        return;
    }
    stateTracker.setPaused(true);
    console.log("⏸️ [CloudShell] Anti-detection mouse movements & auto-rotation have been PAUSED.");
    console.log("   You can now safely perform manual operations without mouse interruption.");
    console.log("   Run 'npm run cloudshell -- resume' when you are finished.");
};

const handleResume = (stateTracker, daemonManager) => {
    const pid = daemonManager.getPid();
    const isAlive = pid ? daemonManager.isProcessAlive(pid) : false;
    if (!isAlive) {
        console.log("CloudShell is not running.");
        return;
    }
    stateTracker.setPaused(false);
    console.log("▶️ [CloudShell] Anti-detection mouse movements & auto-rotation have been RESUMED.");
};

const handleStart = async (options, stateTracker, daemonManager) => {
    const manager = new CloudShellManager(null, { ...options, stateTracker });
    manager.validateAuthFiles();

    if (!options.foreground) {
        const result = daemonManager.startDaemon(options);
        console.log(`🚀 [CloudShell] Daemon started in background (PID: ${result.pid}).`);
        console.log(`   Log file: ${daemonManager.logFile}`);
        console.log(`   Run 'npm run cloudshell -- status' to check status.`);
        console.log(`   Run 'npm run cloudshell -- logs -f' to view logs.`);
        process.exit(0);
        return;
    }

    daemonManager.writePid(process.pid);

    let browser = null;
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
        daemonManager.removePid();
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

const handleRestart = async (options, stateTracker, daemonManager) => {
    const stopResult = await daemonManager.stopDaemon(options.force);
    console.log(`[CloudShell] ${stopResult.message}`);
    await handleStart(options, stateTracker, daemonManager);
};

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

    const stateTracker = new StateTracker();
    const daemonManager = new DaemonManager({ stateTracker });

    try {
        switch (options.command) {
            case "status":
                handleStatus(options, stateTracker, daemonManager);
                process.exit(0);
                break;
            case "stop":
                await handleStop(options, daemonManager);
                break;
            case "restart":
                await handleRestart(options, stateTracker, daemonManager);
                break;
            case "logs":
                handleLogs(options, daemonManager);
                break;
            case "pause":
                handlePause(stateTracker, daemonManager);
                process.exit(0);
                break;
            case "resume":
                handleResume(stateTracker, daemonManager);
                process.exit(0);
                break;
            case "start":
                await handleStart(options, stateTracker, daemonManager);
                break;
            default:
                console.error(`[CloudShell] ❌ Unknown command: ${options.command}`);
                printHelp();
                process.exit(1);
        }
    } catch (err) {
        console.error(`[CloudShell] ❌ Fatal error: ${err.message}`);
        process.exit(1);
    }
};

if (require.main === module) {
    main();
}

module.exports = { handlePause, handleResume, handleStart, main };
