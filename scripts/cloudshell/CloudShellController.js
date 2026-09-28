/**
 * File: scripts/cloudshell/CloudShellController.js
 * Description: Controller for Google Cloud Shell page lifecycle, dialog bypass, and terminal interactions
 */

const fs = require("fs");
const path = require("path");

class AuthExpiredError extends Error {
    constructor(message = "Google authentication has expired. Please run 'npm run save-auth' to re-authenticate.") {
        super(message);
        this.name = "AuthExpiredError";
    }
}

class RegionBlockedError extends Error {
    constructor(message = "Google Cloud Shell is not available in the current region/IP. Please check your proxy.") {
        super(message);
        this.name = "RegionBlockedError";
    }
}

class CloudShellController {
    constructor(page, options = {}) {
        this.page = page;
        this.options = options;
        this.targetUrl = options.targetUrl || "https://shell.cloud.google.com/?show=terminal";
        this.logPrefix = `[CloudShell#${options.authIndex || 0}]`;
        this.sleep = options.sleepFn || (ms => new Promise(r => setTimeout(r, ms)));
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

    async navigate() {
        this.log(`Navigating to ${this.targetUrl}...`);
        await this.page.goto(this.targetUrl, {
            timeout: 180000,
            waitUntil: "domcontentloaded",
        });
        await this.checkPageStatus();
        this.log("DOM content loaded. Checking page status...");
    }

    async checkPageStatus() {
        const url = this.page.url();
        let title = "";
        try {
            title = await this.page.title();
        } catch {
            // ignore title read failure
        }

        if (
            url.includes("accounts.google.com") ||
            url.includes("ServiceLogin") ||
            title.includes("Sign in") ||
            title.includes("登录")
        ) {
            throw new AuthExpiredError();
        }

        if (
            title.includes("Available regions") ||
            title.includes("not available") ||
            title.includes("403") ||
            title.includes("Forbidden")
        ) {
            throw new RegionBlockedError();
        }
    }

    async clickElementSimulated(targetLocator, label = "button") {
        let box = null;
        try {
            if (typeof targetLocator.boundingBox === "function") {
                box = await targetLocator.boundingBox().catch(() => null);
            }
        } catch {
            box = null;
        }

        if (box && this.page && this.page.mouse) {
            try {
                const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
                const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);

                await this.simulateHumanMovement(targetX, targetY);
                await this.sleep(150 + Math.random() * 150);
                await this.page.mouse.down();
                await this.sleep(150 + Math.random() * 200);
                await this.page.mouse.up();
                this.log(`🖱️ Physical click executed on "${label}". Verifying...`);

                await this.sleep(800);
                const stillVisible =
                    typeof targetLocator.isVisible === "function"
                        ? await targetLocator.isVisible({ timeout: 500 }).catch(() => false)
                        : false;

                if (!stillVisible) {
                    return true;
                }
            } catch (err) {
                this.warn(`Physical click error on "${label}": ${err.message}`);
            }
        }

        this.warn(
            `⚠️ Physical click ineffective or boundingBox unavailable for "${label}", falling back to JS force click...`
        );
        await targetLocator.click({ force: true, timeout: 3000 });
        return true;
    }

    async bypassModalsOnce() {
        const frames = this.page.frames();
        const buttonSelectors = [
            // Authorize dialog
            'button:has-text("Authorize")',
            'button:has-text("授权")',
            'button[aria-label*="Authorize"]',
            // Reconnect dialog
            'button:has-text("Reconnect")',
            'button:has-text("重新连接")',
            'button:has-text("Restart")',
            // Terms of service / confirmation
            'button:has-text("Agree and continue")',
            'button:has-text("同意并继续")',
            'button:has-text("Confirm")',
            'button:has-text("确认")',
        ];

        for (const frame of frames) {
            for (const selector of buttonSelectors) {
                try {
                    const btn = frame.locator(selector);
                    if ((await btn.count()) > 0) {
                        const target = btn.first();
                        if (await target.isVisible({ timeout: 300 })) {
                            this.log(`Detected dialog button: "${selector}". Clicking to bypass...`);
                            await this.clickElementSimulated(target, selector);
                            return true;
                        }
                    }
                } catch {
                    // ignore and try next selector/frame
                }
            }
        }
        return false;
    }

    async saveDebugArtifacts(reason = "diagnostic") {
        const logsDir = path.join(process.cwd(), "logs", "cloudshell");
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const screenshotPath = path.join(logsDir, `debug_${reason}_${timestamp}.png`);
        const htmlPath = path.join(logsDir, `debug_${reason}_${timestamp}.html`);

        try {
            await this.page.screenshot({
                fullPage: true,
                path: screenshotPath,
            });
            const content = await this.page.content();
            fs.writeFileSync(htmlPath, content, "utf-8");
            this.log(`Saved screenshot: ${screenshotPath}`);
            this.log(`Saved page source: ${htmlPath}`);
            return { htmlPath, screenshotPath };
        } catch (e) {
            this.warn(`Failed to save debug artifacts: ${e.message}`);
            return null;
        }
    }

    async findTerminalTarget() {
        for (const frame of this.page.frames()) {
            try {
                const textareaLocator = frame.locator("textarea.xterm-helper-textarea");
                const screenLocator = frame.locator(".xterm-screen, .terminal, [role='terminal']");

                const screen = typeof screenLocator.first === "function" ? screenLocator.first() : screenLocator;
                const textarea =
                    typeof textareaLocator.first === "function" ? textareaLocator.first() : textareaLocator;

                const hasScreen = (await screenLocator.count()) > 0 && (await screen.isVisible().catch(() => false));
                if (hasScreen) {
                    const hasTextarea =
                        (await textareaLocator.count()) > 0 && (await textarea.isVisible().catch(() => false));
                    return {
                        frame,
                        screen,
                        textarea: hasTextarea ? textarea : null,
                    };
                }
            } catch {
                // Continue scanning other frames
            }
        }
        return null;
    }

    async simulateHumanMovement(targetX, targetY) {
        if (!this.page || (typeof this.page.isClosed === "function" && this.page.isClosed())) return;
        try {
            const steps = 3;
            for (let i = 1; i <= steps; i++) {
                const intermediateX = targetX + (Math.random() - 0.5) * (100 / i);
                const intermediateY = targetY + (Math.random() - 0.5) * (100 / i);

                const destX = i === steps ? targetX : intermediateX;
                const destY = i === steps ? targetY : intermediateY;

                await this.page.mouse.move(destX, destY, {
                    steps: 5 + Math.floor(Math.random() * 5),
                });
            }
        } catch {
            // Ignore movement errors if page is closed or closing
        }
    }

    async performActiveMicroActions(tickCount = 0) {
        if (!this.page || (typeof this.page.isClosed === "function" && this.page.isClosed())) return;

        // 1. Keep-Alive: Random micro-actions (30% chance)
        if (Math.random() < 0.3) {
            try {
                const vp = (typeof this.page.viewportSize === "function" && this.page.viewportSize()) || {
                    height: 1080,
                    width: 1920,
                };
                if (typeof this.page.evaluate === "function") {
                    // eslint-disable-next-line no-undef
                    await this.page.evaluate(() => window.scrollBy(0, (Math.random() - 0.5) * 20));
                }
                const x = Math.floor(Math.random() * (vp.width * 0.8));
                const y = Math.floor(Math.random() * (vp.height * 0.8));
                await this.simulateHumanMovement(x, y);
            } catch {
                // ignore
            }
        }

        // 2. Anti-Timeout: Move to top-left corner (1, 1) every ~1 minute (15 ticks)
        if (tickCount > 0 && tickCount % 15 === 0) {
            try {
                await this.simulateHumanMovement(1, 1);
            } catch {
                // ignore
            }
        }
    }

    async waitForTerminalReady(timeoutMs = 180000) {
        this.log(`⏳ Waiting for Cloud Shell machine provisioning & terminal ready (max ${timeoutMs / 1000}s)...`);
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            await this.checkPageStatus();
            await this.bypassModalsOnce();

            if (Math.random() < 0.3) {
                try {
                    const vp = (typeof this.page.viewportSize === "function" && this.page.viewportSize()) || {
                        height: 1080,
                        width: 1920,
                    };
                    const x = Math.floor(Math.random() * (vp.width * 0.5));
                    const y = Math.floor(Math.random() * (vp.height * 0.5));
                    await this.simulateHumanMovement(x, y);
                } catch {
                    // ignore
                }
            }

            const target = await this.findTerminalTarget();
            if (target) {
                this.log("✅ Terminal located and ready!");
                return target;
            }

            await new Promise(r => setTimeout(r, 1500));
        }

        await this.saveDebugArtifacts("terminal_timeout");
        throw new Error(
            `Timeout after ${timeoutMs / 1000}s waiting for Cloud Shell terminal to initialize. ` +
                `Artifacts dumped to logs/cloudshell/.`
        );
    }

    async focusTerminal() {
        const target = await this.findTerminalTarget();
        if (!target) return false;

        try {
            await target.screen.click({ force: true, timeout: 2000 });
            if (target.textarea) {
                await target.textarea.focus().catch(() => {});
            }
            return true;
        } catch {
            return false;
        }
    }

    async sendHeartbeat() {
        if (!this.page || this.page.isClosed()) return;
        try {
            await this.focusTerminal().catch(() => {});
            await this.page.keyboard.press("Space");
            await this.page.keyboard.press("Backspace");
            this.log(`💓 Sent anti-idle heartbeat (${new Date().toLocaleTimeString()})`);
        } catch (e) {
            this.warn(`Heartbeat dispatch warning: ${e.message}`);
        }
    }

    stopKeepAliveLoop() {
        this._keepAliveRunning = false;
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    async startKeepAliveLoop(keepAliveMinutes = 0, intervalSec = 120) {
        if (keepAliveMinutes === 0) {
            this.log("Keep-alive set to 0. Exiting after commands.");
            return;
        }

        const isInfinite = keepAliveMinutes === -1;
        this.log(
            `🛡️ Starting keep-alive loop: ${
                isInfinite ? "infinite" : `${keepAliveMinutes} min`
            }, heartbeat every ${intervalSec}s... Press Ctrl+C to terminate.`
        );

        this._keepAliveRunning = true;
        const startTime = Date.now();
        const maxDurationMs = isInfinite ? Infinity : keepAliveMinutes * 60 * 1000;

        while (this._keepAliveRunning && Date.now() - startTime < maxDurationMs) {
            if (this.page.isClosed()) {
                this.warn("Page was closed. Exiting keep-alive loop.");
                break;
            }

            await this.sendHeartbeat();
            await this.bypassModalsOnce();

            const sleepSeconds = Math.min(intervalSec, 10);
            for (let i = 0; i < intervalSec / sleepSeconds; i++) {
                if (!this._keepAliveRunning) break;
                await new Promise(r => setTimeout(r, sleepSeconds * 1000));
            }
        }

        this.log("🏁 Keep-alive duration completed.");
        this.stopKeepAliveLoop();
    }
}

module.exports = {
    AuthExpiredError,
    CloudShellController,
    RegionBlockedError,
};
