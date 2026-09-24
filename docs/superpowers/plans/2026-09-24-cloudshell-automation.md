# Google Cloud Shell Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, testable CLI automation tool (`scripts/cloudshell/runCloudShell.js`) that injects stored Google authentication into Camoufox/Firefox, navigates to Google Cloud Shell, handles initialization modals and VM provisioning, locates the nested xterm terminal, executes bash commands via simulated keystrokes, and provides anti-idle heartbeat keep-alive.

**Architecture:** The tool is partitioned into four modular layers:
1. `options.js`: CLI option parsing, defaults resolution, and input validation.
2. `browserSetup.js`: Platform-specific Camoufox/Firefox binary resolution, proxy extraction, privacy script generation, and authenticated BrowserContext creation from `configs/auth/auth-N.json`.
3. `CloudShellController.js`: State-machine controlling the page lifecycle, handling dialog auto-bypass (Authorize/Reconnect/ToS), traversing iframes to locate and focus xterm, typing commands, managing keep-alive heartbeat loops, and capturing diagnostic artifacts.
4. `runCloudShell.js`: Top-level CLI entry point orchestrating lifecycle setup, execution, signal handling (SIGINT/SIGTERM), and process exit.

**Tech Stack:** Node.js (CommonJS), Playwright (Firefox / Camoufox), Jest for unit/integration tests, dotenv.

**Spec:** `docs/superpowers/specs/2026-09-24-cloudshell-automation-design.md`

## Global Constraints

- Runtime: Node.js CommonJS (`require` / `module.exports`), consistent with existing project code.
- Auth directory: `configs/auth/auth-N.json` (Playwright `storageState` format).
- Browser: Playwright `firefox` engine, with DoH disabled (`network.trr.mode: 5`) and privacy script injected (`addInitScript`).
- Target URL: `https://shell.cloud.google.com/?show=terminal`.
- Anti-idle heartbeat: Default 120s interval using `Space` + `Backspace` keystrokes.
- Log/Debug directory: `logs/cloudshell/`.
- Code quality: Clean linter output (`npm run lint:js`).

## Review Focus

1. **Non-existent or malformed auth file**: Fails immediately with a friendly error and guidance to run `npm run save-auth`, without an uncaught crash.
2. **Expired Google authentication**: Immediately detects redirection to `accounts.google.com` or page titles containing "Sign in" / "登录", throwing a specific `AuthExpiredError`.
3. **Provisioning or terminal iframe timeout**: Prevents hanging indefinitely by timing out cleanly after max wait time and dumping timestamped screenshot + HTML into `logs/cloudshell/`.
4. **Multiline or special-character commands**: Commands split across multiple lines or containing flags are typed line-by-line with delay to prevent terminal input buffer truncation.
5. **Clean process exit on `SIGINT` / `SIGTERM`**: Heartbeat interval is cleared, browser/context are closed cleanly, and process exits with status code 0.

---

### Task 1: CLI Argument Parsing and Validation Module (`options.js`)

**Files:**
- Create: `scripts/cloudshell/options.js`
- Modify: `package.json:20` (add `"cloudshell": "node scripts/cloudshell/runCloudShell.js"`)
- Test: `test/cloudshell/options.test.js`

**Interfaces:**
- Consumes: `process.argv`
- Produces: `parseCliArgs(rawArgs): CloudShellOptions`
  - `authIndex: number` (default 0)
  - `cmd: string | null`
  - `filePath: string | null`
  - `keepAliveMinutes: number` (default 0)
  - `heartbeatIntervalSeconds: number` (default 120)
  - `headless: boolean` (default true)
  - `proxy: string | null`
  - `debug: boolean` (default false)
  - `help: boolean` (default false)
  - `printHelp(): void`

- [ ] **Step 1: Write the failing test for options parsing**

Create `test/cloudshell/options.test.js`:
```javascript
/* eslint-env jest */
const { parseCliArgs, printHelp } = require("../../scripts/cloudshell/options");

describe("CloudShell CLI Options Parser", () => {
    test("returns default values when no args provided", () => {
        const opts = parseCliArgs([]);
        expect(opts.authIndex).toBe(0);
        expect(opts.cmd).toBeNull();
        expect(opts.filePath).toBeNull();
        expect(opts.keepAliveMinutes).toBe(0);
        expect(opts.heartbeatIntervalSeconds).toBe(120);
        expect(opts.headless).toBe(true);
        expect(opts.debug).toBe(false);
        expect(opts.help).toBe(false);
    });

    test("parses custom options correctly", () => {
        const args = [
            "--auth", "2",
            "--cmd", "echo test",
            "--keep-alive", "30",
            "--heartbeat-interval", "60",
            "--headed",
            "--proxy", "http://127.0.0.1:7890",
            "--debug"
        ];
        const opts = parseCliArgs(args);
        expect(opts.authIndex).toBe(2);
        expect(opts.cmd).toBe("echo test");
        expect(opts.keepAliveMinutes).toBe(30);
        expect(opts.heartbeatIntervalSeconds).toBe(60);
        expect(opts.headless).toBe(false);
        expect(opts.proxy).toBe("http://127.0.0.1:7890");
        expect(opts.debug).toBe(true);
    });

    test("parses equals syntax like --auth=3", () => {
        const args = ["--auth=3", "--cmd=ls -la", "--keep-alive=-1"];
        const opts = parseCliArgs(args);
        expect(opts.authIndex).toBe(3);
        expect(opts.cmd).toBe("ls -la");
        expect(opts.keepAliveMinutes).toBe(-1);
    });

    test("throws error when auth index is negative", () => {
        expect(() => parseCliArgs(["--auth", "-1"])).toThrow(/auth index/i);
    });

    test("printHelp does not throw", () => {
        const spy = jest.spyOn(console, "log").mockImplementation(() => {});
        expect(() => printHelp()).not.toThrow();
        spy.mockRestore();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/cloudshell/options.test.js`
Expected: FAIL (Cannot find module `../../scripts/cloudshell/options`)

- [ ] **Step 3: Implement `scripts/cloudshell/options.js` and update `package.json`**

Create `scripts/cloudshell/options.js`:
```javascript
/**
 * File: scripts/cloudshell/options.js
 * Description: CLI options parser and help generator for Cloud Shell runner
 */

const parseCliArgs = (args = []) => {
    const options = {
        authIndex: 0,
        cmd: null,
        debug: false,
        filePath: null,
        headless: true,
        heartbeatIntervalSeconds: 120,
        help: false,
        keepAliveMinutes: 0,
        proxy: null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }

        if (arg === "--debug") {
            options.debug = true;
            continue;
        }

        if (arg === "--headless") {
            options.headless = true;
            continue;
        }

        if (arg === "--headed") {
            options.headless = false;
            continue;
        }

        if (arg.startsWith("--auth=")) {
            const val = parseInt(arg.slice("--auth=".length), 10);
            if (Number.isNaN(val) || val < 0) {
                throw new Error(`Invalid auth index: ${arg.slice("--auth=".length)}. Must be a non-negative integer.`);
            }
            options.authIndex = val;
            continue;
        }
        if (arg === "--auth") {
            const val = parseInt(args[++i], 10);
            if (Number.isNaN(val) || val < 0) {
                throw new Error(`Invalid auth index: ${args[i]}. Must be a non-negative integer.`);
            }
            options.authIndex = val;
            continue;
        }

        if (arg.startsWith("--cmd=")) {
            options.cmd = arg.slice("--cmd=".length);
            continue;
        }
        if (arg === "--cmd") {
            options.cmd = args[++i];
            continue;
        }

        if (arg.startsWith("--file=")) {
            options.filePath = arg.slice("--file=".length);
            continue;
        }
        if (arg === "--file") {
            options.filePath = args[++i];
            continue;
        }

        if (arg.startsWith("--keep-alive=")) {
            const val = parseInt(arg.slice("--keep-alive=".length), 10);
            if (Number.isNaN(val)) {
                throw new Error(`Invalid keep-alive minutes. Must be an integer.`);
            }
            options.keepAliveMinutes = val;
            continue;
        }
        if (arg === "--keep-alive") {
            const val = parseInt(args[++i], 10);
            if (Number.isNaN(val)) {
                throw new Error(`Invalid keep-alive minutes. Must be an integer.`);
            }
            options.keepAliveMinutes = val;
            continue;
        }

        if (arg.startsWith("--heartbeat-interval=")) {
            const val = parseInt(arg.slice("--heartbeat-interval=".length), 10);
            if (Number.isNaN(val) || val <= 0) {
                throw new Error(`Invalid heartbeat interval. Must be a positive integer.`);
            }
            options.heartbeatIntervalSeconds = val;
            continue;
        }
        if (arg === "--heartbeat-interval") {
            const val = parseInt(args[++i], 10);
            if (Number.isNaN(val) || val <= 0) {
                throw new Error(`Invalid heartbeat interval. Must be a positive integer.`);
            }
            options.heartbeatIntervalSeconds = val;
            continue;
        }

        if (arg.startsWith("--proxy=")) {
            options.proxy = arg.slice("--proxy=".length);
            continue;
        }
        if (arg === "--proxy") {
            options.proxy = args[++i];
            continue;
        }
    }

    return options;
};

const printHelp = () => {
    console.log("Usage: node scripts/cloudshell/runCloudShell.js [options]");
    console.log("");
    console.log("Options:");
    console.log("  -h, --help                 Show this help message");
    console.log("  --auth <index>             Auth index in configs/auth/auth-N.json (default: 0)");
    console.log("  --cmd <command>            Command string to execute in Cloud Shell");
    console.log("  --file <path>              Path to script file containing commands");
    console.log("  --keep-alive <min>         Keep-alive duration in minutes (0=exit after commands, -1=infinite)");
    console.log("  --heartbeat-interval <s>   Anti-idle keypress interval in seconds (default: 120)");
    console.log("  --headless                 Run in headless mode (default: true)");
    console.log("  --headed                   Run with visible browser window");
    console.log("  --proxy <url>              Proxy server URL (e.g. http://127.0.0.1:7890)");
    console.log("  --debug                    Capture screenshots and HTML dumps to logs/cloudshell/");
    console.log("");
    console.log("Examples:");
    console.log("  npm run cloudshell -- --auth 0 --cmd \"docker ps\"");
    console.log("  npm run cloudshell -- --auth 1 --cmd \"uname -a\" --keep-alive 60");
};

module.exports = {
    parseCliArgs,
    printHelp,
};
```

Update `package.json` to add `"cloudshell": "node scripts/cloudshell/runCloudShell.js"` under `"scripts"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/cloudshell/options.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/cloudshell/options.js test/cloudshell/options.test.js
git commit -m "feat(cloudshell): implement CLI options parser and validation"
```

---

### Task 2: Browser Setup and Authentication Injector (`browserSetup.js`)

**Files:**
- Create: `scripts/cloudshell/browserSetup.js`
- Test: `test/cloudshell/browser_setup.test.js`

**Interfaces:**
- Consumes:
  - `configs/auth/auth-${authIndex}.json`
  - `src/utils/ProxyUtils.js` (`parseProxyFromEnv`)
  - `playwright.firefox`
- Produces:
  - `resolveBrowserExecutablePath(): string | null`
  - `loadAuthStorageState(authIndex: number): object`
  - `generatePrivacyInitScript(seedString?: string): string`
  - `launchCloudShellBrowser(options: object): Promise<{ browser, context }>`

- [ ] **Step 1: Write the failing test for browserSetup**

Create `test/cloudshell/browser_setup.test.js`:
```javascript
/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const {
    loadAuthStorageState,
    generatePrivacyInitScript,
    resolveBrowserExecutablePath
} = require("../../scripts/cloudshell/browserSetup");

describe("CloudShell Browser Setup", () => {
    const testAuthDir = path.join(process.cwd(), "configs", "auth");
    const testAuthFile = path.join(testAuthDir, "auth-9999.json");

    beforeAll(() => {
        if (!fs.existsSync(testAuthDir)) {
            fs.mkdirSync(testAuthDir, { recursive: true });
        }
        fs.writeFileSync(
            testAuthFile,
            JSON.stringify({
                cookies: [{ name: "SSID", value: "test-cookie", domain: ".google.com", path: "/" }],
                origins: []
            })
        );
    });

    afterAll(() => {
        if (fs.existsSync(testAuthFile)) {
            fs.unlinkSync(testAuthFile);
        }
    });

    test("loadAuthStorageState loads valid auth file", () => {
        const state = loadAuthStorageState(9999);
        expect(state.cookies).toHaveLength(1);
        expect(state.cookies[0].name).toBe("SSID");
    });

    test("loadAuthStorageState throws friendly error when auth file does not exist", () => {
        expect(() => loadAuthStorageState(8888)).toThrow(/auth-8888\.json does not exist/);
    });

    test("generatePrivacyInitScript produces script masking webdriver", () => {
        const script = generatePrivacyInitScript("test-seed");
        expect(script).toContain("navigator, 'webdriver'");
        expect(script).toContain("UNMASKED_VENDOR_WEBGL");
    });

    test("resolveBrowserExecutablePath returns string or null", () => {
        const execPath = resolveBrowserExecutablePath();
        expect(typeof execPath === "string" || execPath === null).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/cloudshell/browser_setup.test.js`
Expected: FAIL (Cannot find module `../../scripts/cloudshell/browserSetup`)

- [ ] **Step 3: Implement `scripts/cloudshell/browserSetup.js`**

Create `scripts/cloudshell/browserSetup.js`:
```javascript
/**
 * File: scripts/cloudshell/browserSetup.js
 * Description: Browser initialization, proxy resolution, and auth state injection for Cloud Shell
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { firefox } = require("playwright");
const { parseProxyFromEnv } = require("../../src/utils/ProxyUtils");

const FIREFOX_DOH_DISABLED_PREFS = {
    "network.trr.mode": 5,
    "network.trr.uri": "",
    "app.update.enabled": false,
    "browser.cache.disk.enable": false,
    "browser.ping-centre.telemetry": false,
    "browser.safebrowsing.enabled": false,
    "browser.safebrowsing.malware.enabled": false,
    "browser.safebrowsing.phishing.enabled": false,
    "browser.search.update": false,
    "browser.shell.checkDefaultBrowser": false,
    "browser.tabs.warnOnClose": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "dom.min_background_timeout_value": 1,
    "dom.min_timeout_value": 1,
    "dom.timeout.throttling_delay": 2147483647,
    "dom.webnotifications.enabled": false,
    "general.smoothScroll": false,
    "gfx.webrender.all": false,
    "layers.acceleration.disabled": true,
    "media.autoplay.default": 5,
    "media.volume_scale": "0.0",
    "network.dns.disablePrefetch": true,
    "network.http.speculative-parallel-limit": 0,
    "network.prefetch-next": false,
    "permissions.default.geo": 0,
    "services.sync.enabled": false,
    "toolkit.cosmeticAnimations.enabled": false,
    "toolkit.telemetry.enabled": false,
};

const resolveBrowserExecutablePath = () => {
    const platform = os.platform();
    let candidate = null;

    if (platform === "linux") {
        candidate = path.join(process.cwd(), "camoufox-linux", "camoufox");
    } else if (platform === "win32") {
        candidate = path.join(process.cwd(), "camoufox", "camoufox.exe");
    } else if (platform === "darwin") {
        candidate = path.join(process.cwd(), "camoufox-macos", "Camoufox.app", "Contents", "MacOS", "camoufox");
    }

    if (candidate && fs.existsSync(candidate)) {
        return candidate;
    }
    return null;
};

const loadAuthStorageState = (authIndex = 0) => {
    const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${authIndex}.json`);
    if (!fs.existsSync(authFilePath)) {
        throw new Error(
            `Auth file configs/auth/auth-${authIndex}.json does not exist. ` +
            `Please run 'npm run save-auth' first to generate credentials for account #${authIndex}.`
        );
    }

    try {
        const content = fs.readFileSync(authFilePath, "utf-8");
        const parsed = JSON.parse(content);
        if (!parsed.cookies || !Array.isArray(parsed.cookies)) {
            throw new Error(`Auth file configs/auth/auth-${authIndex}.json does not contain valid cookies.`);
        }
        return parsed;
    } catch (err) {
        throw new Error(`Failed to parse auth file configs/auth/auth-${authIndex}.json: ${err.message}`);
    }
};

const generatePrivacyInitScript = (seedSource = "cloudshell_seed") => {
    let hashValue = 0;
    for (let i = 0; i < seedSource.length; i++) {
        const charCode = seedSource.charCodeAt(i);
        hashValue = (hashValue << 5) - hashValue + charCode;
        hashValue |= 0;
    }
    let seed = Math.abs(hashValue);
    const deterministicRandom = () => {
        const x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    };

    const gpuProfiles = [
        { renderer: "Intel Iris OpenGL Engine", vendor: "Intel Inc." },
        {
            renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)",
            vendor: "Google Inc. (NVIDIA)",
        },
        {
            renderer: "ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)",
            vendor: "Google Inc. (AMD)",
        },
    ];
    const profile = gpuProfiles[Math.floor(deterministicRandom() * gpuProfiles.length)];

    return `
        (function() {
            if (window._cloudshellPrivacyInjected) return;
            window._cloudshellPrivacyInjected = true;
            try {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                if (navigator.plugins.length === 0) {
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => new Array(${3 + Math.floor(deterministicRandom() * 3)}),
                    });
                }
                const getParameterProxy = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return '${profile.vendor}';
                    if (parameter === 37445 || parameter === 37446) return '${profile.renderer}';
                    return getParameterProxy.apply(this, arguments);
                };
            } catch (e) {}
        })();
    `;
};

const launchCloudShellBrowser = async (options = {}) => {
    const {
        authIndex = 0,
        headless = true,
        proxy = null,
    } = options;

    const storageState = loadAuthStorageState(authIndex);
    const executablePath = resolveBrowserExecutablePath();

    let proxyConfig = null;
    if (proxy) {
        proxyConfig = { server: proxy };
    } else {
        proxyConfig = parseProxyFromEnv();
    }

    const launchOpts = {
        firefoxUserPrefs: FIREFOX_DOH_DISABLED_PREFS,
        headless,
        ...(executablePath ? { executablePath } : {}),
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
    };

    const browser = await firefox.launch(launchOpts);

    const randomWidth = 1920 + Math.floor(Math.random() * 50);
    const randomHeight = 1080 + Math.floor(Math.random() * 50);

    const context = await browser.newContext({
        deviceScaleFactor: 1,
        storageState,
        viewport: { height: randomHeight, width: randomWidth },
        ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });

    const privacyScript = generatePrivacyInitScript(`account_auth_${authIndex}`);
    await context.addInitScript(privacyScript);

    return { browser, context };
};

module.exports = {
    FIREFOX_DOH_DISABLED_PREFS,
    generatePrivacyInitScript,
    launchCloudShellBrowser,
    loadAuthStorageState,
    resolveBrowserExecutablePath,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/cloudshell/browser_setup.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cloudshell/browserSetup.js test/cloudshell/browser_setup.test.js
git commit -m "feat(cloudshell): implement browser launcher and auth injection"
```

---

### Task 3: CloudShell Page Lifecycle & Dialog Bypasser (`CloudShellController.js` - Part 1)

**Files:**
- Create: `scripts/cloudshell/CloudShellController.js`
- Test: `test/cloudshell/cloudshell_controller_lifecycle.test.js`

**Interfaces:**
- Consumes: Playwright `page`, `context`
- Produces:
  - `class CloudShellController`
    - `constructor(page, options)`
    - `navigate(): Promise<void>`
    - `checkPageStatus(): Promise<void>` (throws `AuthExpiredError`, `RegionBlockedError`)
    - `bypassModalsOnce(): Promise<boolean>` (checks Authorize, Reconnect, Terms of Service)
    - `saveDebugArtifacts(reason: string): Promise<{ screenshotPath, htmlPath }>`

- [ ] **Step 1: Write the failing test for CloudShellController lifecycle & dialogs**

Create `test/cloudshell/cloudshell_controller_lifecycle.test.js`:
```javascript
/* eslint-env jest */
const { CloudShellController, AuthExpiredError, RegionBlockedError } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Lifecycle & Modals", () => {
    test("checkPageStatus detects expired authentication", async () => {
        const mockPage = {
            url: () => "https://accounts.google.com/signin/v2/identifier",
            title: async () => "Sign in - Google Accounts",
        };
        const controller = new CloudShellController(mockPage);
        await expect(controller.checkPageStatus()).rejects.toThrow(AuthExpiredError);
    });

    test("checkPageStatus detects region not available", async () => {
        const mockPage = {
            url: () => "https://shell.cloud.google.com/?show=terminal",
            title: async () => "Available regions - Google Cloud",
        };
        const controller = new CloudShellController(mockPage);
        await expect(controller.checkPageStatus()).rejects.toThrow(RegionBlockedError);
    });

    test("bypassModalsOnce clicks Authorize button if found in frame", async () => {
        let clicked = false;
        const mockButton = {
            count: async () => 1,
            first: () => ({
                isVisible: async () => true,
                click: async () => { clicked = true; }
            })
        };
        const mockFrame = {
            locator: (selector) => {
                if (selector.includes("Authorize") || selector.includes("授权")) {
                    return mockButton;
                }
                return { count: async () => 0 };
            }
        };
        const mockPage = {
            url: () => "https://shell.cloud.google.com/?show=terminal",
            title: async () => "Google Cloud Shell",
            frames: () => [mockFrame],
        };
        const controller = new CloudShellController(mockPage);
        const didBypass = await controller.bypassModalsOnce();
        expect(didBypass).toBe(true);
        expect(clicked).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/cloudshell/cloudshell_controller_lifecycle.test.js`
Expected: FAIL (Cannot find module `../../scripts/cloudshell/CloudShellController`)

- [ ] **Step 3: Implement lifecycle checking and dialog bypassing in `scripts/cloudshell/CloudShellController.js`**

Create `scripts/cloudshell/CloudShellController.js`:
```javascript
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
            waitUntil: "domcontentloaded",
            timeout: 180000,
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
            'button:has-text("确认")'
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
            await this.page.screenshot({ fullPage: true, path: screenshotPath });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/cloudshell/cloudshell_controller_lifecycle.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cloudshell/CloudShellController.js test/cloudshell/cloudshell_controller_lifecycle.test.js
git commit -m "feat(cloudshell): implement page lifecycle checks and modal bypasser"
```

---

### Task 4: Terminal Piercing & Command Dispatching (`CloudShellController.js` - Part 2)

**Files:**
- Modify: `scripts/cloudshell/CloudShellController.js`
- Test: `test/cloudshell/cloudshell_controller_terminal.test.js`

**Interfaces:**
- Consumes: Playwright `page.frames()`, `page.keyboard`
- Produces:
  - `CloudShellController.findTerminalTarget(): Promise<{ frame, textarea, screen } | null>`
  - `CloudShellController.waitForTerminalReady(timeoutMs?: number): Promise<{ frame, textarea, screen }>`
  - `CloudShellController.focusTerminal(): Promise<boolean>`
  - `CloudShellController.executeCommand(command: string): Promise<void>`
  - `CloudShellController.executeCommands(commands: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test for terminal piercing and command dispatch**

Create `test/cloudshell/cloudshell_controller_terminal.test.js`:
```javascript
/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Terminal Piercing & Commands", () => {
    test("findTerminalTarget locates xterm in child frame", async () => {
        const mockScreen = {
            count: async () => 1,
            isVisible: async () => true,
            click: async () => {},
        };
        const mockTextarea = {
            count: async () => 1,
            isVisible: async () => true,
            focus: async () => {},
        };

        const mockFrame = {
            locator: (selector) => {
                if (selector.includes("textarea.xterm-helper-textarea")) return mockTextarea;
                if (selector.includes(".xterm-screen")) return mockScreen;
                return { count: async () => 0 };
            }
        };

        const mockPage = {
            frames: () => [mockFrame],
            keyboard: {
                press: async () => {},
                type: async () => {},
            },
        };

        const controller = new CloudShellController(mockPage);
        const target = await controller.findTerminalTarget();
        expect(target).not.toBeNull();
        expect(target.screen).toBe(mockScreen);
        expect(target.textarea).toBe(mockTextarea);
    });

    test("executeCommand focuses terminal and types command with enter", async () => {
        const typed = [];
        const pressed = [];
        let screenClicked = false;

        const mockScreen = {
            count: async () => 1,
            isVisible: async () => true,
            click: async () => { screenClicked = true; },
        };
        const mockTextarea = {
            count: async () => 1,
            isVisible: async () => true,
            focus: async () => {},
        };
        const mockFrame = {
            locator: (selector) => {
                if (selector.includes("textarea.xterm-helper-textarea")) return mockTextarea;
                if (selector.includes(".xterm-screen")) return mockScreen;
                return { count: async () => 0 };
            }
        };

        const mockPage = {
            frames: () => [mockFrame],
            keyboard: {
                press: async (key) => { pressed.push(key); },
                type: async (text) => { typed.push(text); },
            },
        };

        const controller = new CloudShellController(mockPage);
        await controller.executeCommand("echo hello");
        expect(screenClicked).toBe(true);
        expect(typed).toContain("echo hello");
        expect(pressed).toContain("Enter");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/cloudshell/cloudshell_controller_terminal.test.js`
Expected: FAIL (`controller.findTerminalTarget is not a function`)

- [ ] **Step 3: Implement terminal detection and command execution in `scripts/cloudshell/CloudShellController.js`**

Add the following methods to `CloudShellController` class in `scripts/cloudshell/CloudShellController.js`:
```javascript
    async findTerminalTarget() {
        for (const frame of this.page.frames()) {
            try {
                const textarea = frame.locator("textarea.xterm-helper-textarea");
                const screen = frame.locator(".xterm-screen, .terminal, [role='terminal']");

                const hasScreen = (await screen.count()) > 0 && (await screen.first().isVisible().catch(() => false));
                if (hasScreen) {
                    const hasTextarea =
                        (await textarea.count()) > 0 && (await textarea.first().isVisible().catch(() => false));
                    return {
                        frame,
                        screen: screen.first(),
                        textarea: hasTextarea ? textarea.first() : null,
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
        for (const cmd of commands) {
            const trimmed = (cmd || "").trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            await this.executeCommand(trimmed);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/cloudshell/cloudshell_controller_terminal.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cloudshell/CloudShellController.js test/cloudshell/cloudshell_controller_terminal.test.js
git commit -m "feat(cloudshell): add terminal piercing and command dispatching"
```

---

### Task 5: Anti-Idle Heartbeat Loop & Keep-Alive (`CloudShellController.js` - Part 3)

**Files:**
- Modify: `scripts/cloudshell/CloudShellController.js`
- Test: `test/cloudshell/cloudshell_controller_heartbeat.test.js`

**Interfaces:**
- Consumes: `page.keyboard`, `page.isClosed`
- Produces:
  - `CloudShellController.sendHeartbeat(): Promise<void>`
  - `CloudShellController.startKeepAliveLoop(minutes: number, intervalSec: number): Promise<void>`
  - `CloudShellController.stopKeepAliveLoop(): void`

- [ ] **Step 1: Write the failing test for heartbeat & keep-alive**

Create `test/cloudshell/cloudshell_controller_heartbeat.test.js`:
```javascript
/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Anti-Idle Heartbeat", () => {
    test("sendHeartbeat sends Space and Backspace to prevent idle disconnect", async () => {
        const pressedKeys = [];
        const mockPage = {
            isClosed: () => false,
            keyboard: {
                press: async (key) => { pressedKeys.push(key); }
            },
            frames: () => []
        };
        const controller = new CloudShellController(mockPage);
        await controller.sendHeartbeat();
        expect(pressedKeys).toEqual(["Space", "Backspace"]);
    });

    test("stopKeepAliveLoop halts active loop", () => {
        const mockPage = { isClosed: () => false };
        const controller = new CloudShellController(mockPage);
        controller._keepAliveRunning = true;
        controller.stopKeepAliveLoop();
        expect(controller._keepAliveRunning).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/cloudshell/cloudshell_controller_heartbeat.test.js`
Expected: FAIL (`controller.sendHeartbeat is not a function`)

- [ ] **Step 3: Implement heartbeat and keep-alive loop in `scripts/cloudshell/CloudShellController.js`**

Add the heartbeat methods to `CloudShellController`:
```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/cloudshell/cloudshell_controller_heartbeat.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/cloudshell/CloudShellController.js test/cloudshell/cloudshell_controller_heartbeat.test.js
git commit -m "feat(cloudshell): implement anti-idle heartbeat and keep-alive loop"
```

---

### Task 6: CLI Orchestration Entrypoint & Integration (`runCloudShell.js`)

**Files:**
- Create: `scripts/cloudshell/runCloudShell.js`
- Test: `test/cloudshell/run_cloudshell.test.js`

**Interfaces:**
- Consumes:
  - `options.js` (`parseCliArgs`, `printHelp`)
  - `browserSetup.js` (`launchCloudShellBrowser`)
  - `CloudShellController.js` (`CloudShellController`)
- Produces:
  - Executable CLI runner with signal handling and process exit codes

- [ ] **Step 1: Write the integration smoke test**

Create `test/cloudshell/run_cloudshell.test.js`:
```javascript
/* eslint-env jest */
const { spawnSync } = require("child_process");
const path = require("path");

describe("CloudShell CLI Entrypoint Smoke Test", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "cloudshell", "runCloudShell.js");

    test("--help outputs usage and exits with 0", () => {
        const res = spawnSync("node", [scriptPath, "--help"], { encoding: "utf-8" });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Usage: node scripts/cloudshell/runCloudShell.js");
        expect(res.stdout).toContain("--auth <index>");
    });

    test("missing auth file exits with error code 1 and helpful message", () => {
        const res = spawnSync("node", [scriptPath, "--auth", "987654"], { encoding: "utf-8" });
        expect(res.status).toBe(1);
        expect(res.stderr || res.stdout).toContain("auth-987654.json does not exist");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: FAIL (`Cannot find module .../runCloudShell.js`)

- [ ] **Step 3: Implement `scripts/cloudshell/runCloudShell.js`**

Create `scripts/cloudshell/runCloudShell.js`:
```javascript
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
        commandsToExecute.push(options.cmd);
    }
    if (options.filePath) {
        const fullScriptPath = path.resolve(process.cwd(), options.filePath);
        if (!fs.existsSync(fullScriptPath)) {
            console.error(`[CloudShell] ❌ Script file not found: ${fullScriptPath}`);
            process.exit(1);
        }
        const fileContent = fs.readFileSync(fullScriptPath, "utf-8");
        const lines = fileContent.split("\n");
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
            } catch {}
        }
        if (browser) {
            try {
                await browser.close();
            } catch {}
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
```

- [ ] **Step 4: Run integration test and linter**

Run:
```bash
npx jest test/cloudshell/
npm run lint:js
```
Expected: PASS with 0 linting errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/cloudshell/runCloudShell.js test/cloudshell/run_cloudshell.test.js
git commit -m "feat(cloudshell): implement CLI runner entrypoint and integration tests"
```

---

## Self-Review Checklist

1. **Spec coverage**:
   - `configs/auth/auth-N.json` loading? Covered in Task 2.
   - Camoufox/Firefox binary resolution and DoH disabled? Covered in Task 2.
   - Privacy anti-fingerprint script injected? Covered in Task 2.
   - Page lifecycle, expired auth and region block errors? Covered in Task 3.
   - Authorize, Reconnect, ToS modal bypassing? Covered in Task 3.
   - Iframe search and xterm.js focus/typing with delay? Covered in Task 4.
   - Anti-idle heartbeat with Space+Backspace & keep-alive loop? Covered in Task 5.
   - CLI options and graceful shutdown on SIGINT? Covered in Task 1 & Task 6.
2. **No Placeholders**: Every task has complete test code, implementation code, and exact file paths.
3. **Type and interface consistency**: All method signatures match between `options.js`, `browserSetup.js`, `CloudShellController.js`, and `runCloudShell.js`.
4. **Review Focus**: Tested non-existent auth, expired auth, region blocking, modal clicks, keystrokes, and CLI execution.
