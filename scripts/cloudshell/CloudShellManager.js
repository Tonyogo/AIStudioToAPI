/**
 * File: scripts/cloudshell/CloudShellManager.js
 * Description: Multi-account BrowserContext manager and rotation/keep-alive loop for Google Cloud Shell
 */

const fs = require("fs");
const path = require("path");
const { CloudShellController } = require("./CloudShellController");
const { createBrowserContext, loadAuthStorageState } = require("./browserSetup");
const { parseProxyFromEnv } = require("../../src/utils/ProxyUtils");

class CloudShellManager {
    constructor(browser, options = {}) {
        this.browser = browser;
        this.options = options;
        this.contexts = new Map();
        this._running = false;
        this.logPrefix = "[CloudShellManager]";

        if (options.all) {
            this.authIndices = CloudShellManager.discoverAvailableAuthIndices();
        } else {
            this.authIndices = options.authIndices && options.authIndices.length > 0 ? [...options.authIndices] : [0];
        }

        this.currentAuthIndex = this.authIndices[0] ?? 0;
        this.switchIntervalMinutes = options.switchIntervalMinutes || 10;
        this.keepAliveMinutes = options.keepAliveMinutes !== undefined ? options.keepAliveMinutes : -1;
        this.heartbeatIntervalSeconds = options.heartbeatIntervalSeconds || 120;
        this.proxy = options.proxy || null;
        this.debug = Boolean(options.debug);

        if (this.proxy) {
            this.proxyConfig = { server: this.proxy };
        } else {
            this.proxyConfig = parseProxyFromEnv();
        }
    }

    validateAuthFiles() {
        for (const authIndex of this.authIndices) {
            loadAuthStorageState(authIndex);
        }
    }

    log(msg) {
        console.log(`${this.logPrefix} ${msg}`);
    }

    warn(msg) {
        console.warn(`${this.logPrefix} ⚠️ ${msg}`);
    }

    error(msg) {
        console.error(`${this.logPrefix} ❌ ${msg}`);
    }

    static discoverAvailableAuthIndices(authDir = path.resolve(process.cwd(), "configs", "auth")) {
        if (!fs.existsSync(authDir)) {
            throw new Error(`Auth directory ${authDir} does not exist.`);
        }
        const files = fs.readdirSync(authDir);
        const indices = [];
        for (const file of files) {
            const match = file.match(/^auth-(\d+)\.json$/);
            if (match) {
                indices.push(parseInt(match[1], 10));
            }
        }
        if (indices.length === 0) {
            throw new Error(`No auth files found in ${authDir} matching auth-N.json. Please run 'npm run save-auth' first.`);
        }
        return Array.from(new Set(indices)).sort((a, b) => a - b);
    }

    async createContextForAuth(authIndex) {
        if (typeof this.options.createContextFn === "function") {
            return await this.options.createContextFn(this.browser, authIndex);
        }
        return await createBrowserContext(this.browser, authIndex, this.proxyConfig);
    }

    async init() {
        this.log(`🚀 Initializing Cloud Shell contexts for account(s): [${this.authIndices.join(", ")}]...`);
        for (const authIndex of this.authIndices) {
            this.log(`Initializing account #${authIndex}...`);
            const context = await this.createContextForAuth(authIndex);
            const page = await context.newPage();
            const controller = new CloudShellController(page, {
                ...this.options,
                authIndex,
            });

            await controller.navigate();
            await controller.waitForTerminalReady();

            this.contexts.set(authIndex, {
                context,
                controller,
                page,
            });
            this.log(`✅ Account #${authIndex} initialized successfully.`);
        }

        if (this.authIndices.length > 0) {
            await this.switchActiveContext(this.authIndices[0]);
        }
    }

    getNextAuthIndex() {
        if (!this.authIndices || this.authIndices.length === 0) return 0;
        const currentIndex = this.authIndices.indexOf(this.currentAuthIndex);
        if (currentIndex === -1) {
            return this.authIndices[0];
        }
        const nextIndex = (currentIndex + 1) % this.authIndices.length;
        return this.authIndices[nextIndex];
    }

    async switchActiveContext(targetAuthIndex) {
        if (!this.contexts.has(targetAuthIndex)) {
            this.warn(`Context for auth #${targetAuthIndex} not found. Cannot switch.`);
            return;
        }
        this.currentAuthIndex = targetAuthIndex;
        const entry = this.contexts.get(targetAuthIndex);
        if (!entry || !entry.page || (typeof entry.page.isClosed === "function" && entry.page.isClosed())) {
            this.warn(`Page for auth #${targetAuthIndex} is closed or invalid.`);
            return;
        }

        this.log(`🔄 Switching active context to Account #${targetAuthIndex}...`);
        try {
            if (typeof entry.page.bringToFront === "function") {
                await entry.page.bringToFront();
            }
            if (typeof entry.page.evaluate === "function") {
                await entry.page.evaluate(() => window.focus()).catch(() => {});
            }
            if (entry.controller) {
                const vp = (typeof entry.page.viewportSize === "function" && entry.page.viewportSize()) || {
                    height: 1080,
                    width: 1920,
                };
                const startX = Math.floor(Math.random() * (vp.width * 0.5));
                const startY = Math.floor(Math.random() * (vp.height * 0.5));
                await entry.controller.simulateHumanMovement(startX, startY);
            }
            this.log(`✨ Active context is now Account #${targetAuthIndex}`);
        } catch (err) {
            this.warn(`Failed to switch active context to Account #${targetAuthIndex}: ${err.message}`);
        }
    }

    async rotateActiveContext() {
        const nextAuthIndex = this.getNextAuthIndex();
        await this.switchActiveContext(nextAuthIndex);
    }

    async startRotationAndKeepAliveLoop() {
        if (this.keepAliveMinutes === 0) {
            this.log("Keep-alive duration is 0. Exiting without loop.");
            return;
        }

        const isInfinite = this.keepAliveMinutes === -1;
        this.log(
            `🛡️ Starting multi-context keep-alive loop: ${
                isInfinite ? "infinite" : `${this.keepAliveMinutes} min`
            }, rotation every ${this.switchIntervalMinutes} min, heartbeat every ${this.heartbeatIntervalSeconds}s... Press Ctrl+C to terminate.`
        );

        this._running = true;
        const startTime = Date.now();
        const maxDurationMs = isInfinite ? Infinity : this.keepAliveMinutes * 60 * 1000;

        const tickIntervalMs = 4000;
        const tickSeconds = tickIntervalMs / 1000;
        const heartbeatTicks = Math.max(1, Math.round(this.heartbeatIntervalSeconds / tickSeconds));
        const switchTicks = Math.max(1, Math.round((this.switchIntervalMinutes * 60) / tickSeconds));

        let tickCount = 0;

        while (this._running && Date.now() - startTime < maxDurationMs) {
            // Check if all pages are closed
            let anyAlive = false;
            for (const [, entry] of this.contexts) {
                if (entry.page && typeof entry.page.isClosed === "function" && !entry.page.isClosed()) {
                    anyAlive = true;
                    break;
                }
            }

            if (!anyAlive && this.contexts.size > 0) {
                this.warn("All Cloud Shell contexts/pages are closed. Terminating keep-alive loop.");
                break;
            }

            tickCount++;

            // 1. Micro-actions on active context
            const activeEntry = this.contexts.get(this.currentAuthIndex);
            if (activeEntry && activeEntry.controller && activeEntry.page && !activeEntry.page.isClosed()) {
                try {
                    await activeEntry.controller.performActiveMicroActions(tickCount);
                } catch (err) {
                    this.warn(`Active micro-actions error on Account #${this.currentAuthIndex}: ${err.message}`);
                }
            }

            // 2. Periodic anti-idle heartbeat and modal bypass on all contexts
            if (tickCount % heartbeatTicks === 0) {
                for (const [authIndex, entry] of this.contexts) {
                    if (entry.page && !entry.page.isClosed() && entry.controller) {
                        try {
                            await entry.controller.sendHeartbeat();
                            await entry.controller.bypassModalsOnce();
                        } catch (err) {
                            this.warn(`Heartbeat/modal bypass error on Account #${authIndex}: ${err.message}`);
                        }
                    }
                }
            }

            // 3. Periodic active context rotation if multiple accounts exist
            if (this.authIndices.length > 1 && tickCount % switchTicks === 0) {
                await this.rotateActiveContext();
            }

            // Sleep 4s responsive to this._running
            const sleepChunk = 500;
            const chunks = tickIntervalMs / sleepChunk;
            for (let c = 0; c < chunks; c++) {
                if (!this._running) break;
                await new Promise(r => setTimeout(r, sleepChunk));
            }
        }

        this.log("🏁 CloudShellManager keep-alive loop completed.");
        await this.stop();
    }

    async stop() {
        this._running = false;
        for (const [, entry] of this.contexts) {
            try {
                if (entry.controller) {
                    entry.controller.stopKeepAliveLoop();
                }
                if (entry.context && typeof entry.context.close === "function") {
                    await entry.context.close().catch(() => {});
                }
            } catch {
                // ignore
            }
        }
        this.contexts.clear();
    }
}

module.exports = {
    CloudShellManager,
};
