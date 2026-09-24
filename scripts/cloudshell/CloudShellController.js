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
                            await target.click({ timeout: 5000 });
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

    async waitForTerminalReady(timeoutMs = 180000) {
        this.log(`⏳ Waiting for Cloud Shell machine provisioning & terminal ready (max ${timeoutMs / 1000}s)...`);
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            await this.checkPageStatus();
            await this.bypassModalsOnce();

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

    async executeCommand(command) {
        if (!command || typeof command !== "string") return;
        this.log(`⌨️ Executing command: "${command}"`);

        await this.focusTerminal();
        await new Promise(r => setTimeout(r, 100));

        await this.page.keyboard.type(command, { delay: 15 });
        await new Promise(r => setTimeout(r, 200));
        await this.page.keyboard.press("Enter");
        this.log(`✅ Command dispatched: "${command}"`);
    }

    async executeCommands(commands = []) {
        const flattened = [];
        for (const item of commands) {
            if (typeof item === "string") {
                flattened.push(...item.split(/\r?\n/));
            }
        }
        for (const cmd of flattened) {
            const trimmed = (cmd || "").trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            await this.executeCommand(trimmed);
            await new Promise(r => setTimeout(r, 1000));
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
