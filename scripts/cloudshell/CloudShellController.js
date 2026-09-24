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
}

module.exports = {
    AuthExpiredError,
    CloudShellController,
    RegionBlockedError,
};
