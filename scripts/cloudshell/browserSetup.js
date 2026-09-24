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
    "network.trr.mode": 5,
    "network.trr.uri": "",
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
                    // 37445: UNMASKED_VENDOR_WEBGL
                    if (parameter === 37445) return '${profile.vendor}';
                    // 37446: UNMASKED_RENDERER_WEBGL
                    if (parameter === 37446) return '${profile.renderer}';
                    return getParameterProxy.apply(this, arguments);
                };
            } catch (e) {}
        })();
    `;
};

const launchCloudShellBrowser = async (options = {}) => {
    const { authIndex = 0, headless = true, proxy = null } = options;

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
