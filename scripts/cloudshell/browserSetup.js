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
    const rawEnv = process.env.CAMOUFOX_EXECUTABLE_PATH;
    const envVal = typeof rawEnv === "string" ? rawEnv.trim() : "";
    if (envVal) {
        const envPath = path.isAbsolute(envVal) ? envVal : path.resolve(process.cwd(), envVal);
        if (fs.existsSync(envPath)) {
            return envPath;
        }
        return envVal;
    }

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
                // 1. Mask webdriver
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined,
                    enumerable: true,
                    configurable: true,
                });

                // 2. Legitimate plugins and mimeTypes
                if (!navigator.plugins || navigator.plugins.length === 0) {
                    const pluginData = [
                        {
                            name: 'PDF Viewer',
                            filename: 'internal-pdf-viewer',
                            description: 'Portable Document Format',
                            mimeTypes: [
                                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
                                { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                            ]
                        },
                        {
                            name: 'Chrome PDF Viewer',
                            filename: 'internal-pdf-viewer',
                            description: 'Portable Document Format',
                            mimeTypes: [
                                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                            ]
                        },
                        {
                            name: 'Chromium PDF Viewer',
                            filename: 'internal-pdf-viewer',
                            description: 'Portable Document Format',
                            mimeTypes: [
                                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                            ]
                        },
                        {
                            name: 'Microsoft Edge PDF Viewer',
                            filename: 'internal-pdf-viewer',
                            description: 'Portable Document Format',
                            mimeTypes: [
                                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                            ]
                        },
                        {
                            name: 'WebKit built-in PDF',
                            filename: 'internal-pdf-viewer',
                            description: 'Portable Document Format',
                            mimeTypes: [
                                { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
                            ]
                        }
                    ];

                    const fakePlugins = Object.create(window.PluginArray ? window.PluginArray.prototype : Object.prototype);
                    const fakeMimeTypes = Object.create(window.MimeTypeArray ? window.MimeTypeArray.prototype : Object.prototype);
                    const allMimes = [];

                    pluginData.forEach(function(pInfo, pIdx) {
                        const fakePlugin = Object.create(window.Plugin ? window.Plugin.prototype : Object.prototype);
                        const mimesForPlugin = [];

                        pInfo.mimeTypes.forEach(function(mInfo, mIdx) {
                            const fakeMime = Object.create(window.MimeType ? window.MimeType.prototype : Object.prototype);
                            Object.defineProperties(fakeMime, {
                                type: { value: mInfo.type, enumerable: true },
                                suffixes: { value: mInfo.suffixes, enumerable: true },
                                description: { value: mInfo.description, enumerable: true },
                                enabledPlugin: { value: fakePlugin, enumerable: true }
                            });
                            mimesForPlugin.push(fakeMime);
                            fakePlugin[mIdx] = fakeMime;
                            fakePlugin[mInfo.type] = fakeMime;

                            if (!fakeMimeTypes[mInfo.type]) {
                                fakeMimeTypes[allMimes.length] = fakeMime;
                                fakeMimeTypes[mInfo.type] = fakeMime;
                                allMimes.push(fakeMime);
                            }

                            if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
                                fakeMime[Symbol.toStringTag] = 'MimeType';
                            }
                        });

                        Object.defineProperties(fakePlugin, {
                            name: { value: pInfo.name, enumerable: true },
                            filename: { value: pInfo.filename, enumerable: true },
                            description: { value: pInfo.description, enumerable: true },
                            length: { value: mimesForPlugin.length, enumerable: true },
                            item: {
                                value: function(index) {
                                    const i = Number(index);
                                    if (!Number.isInteger(i) || i < 0 || i >= mimesForPlugin.length) return null;
                                    return mimesForPlugin[i] || null;
                                },
                                enumerable: false
                            },
                            namedItem: {
                                value: function(name) {
                                    if (!name || typeof name !== 'string') return null;
                                    return mimesForPlugin.find(function(m) { return m.type === name; }) || null;
                                },
                                enumerable: false
                            }
                        });

                        if (typeof Symbol !== 'undefined') {
                            if (Symbol.iterator) fakePlugin[Symbol.iterator] = Array.prototype[Symbol.iterator];
                            if (Symbol.toStringTag) fakePlugin[Symbol.toStringTag] = 'Plugin';
                        }

                        fakePlugins[pIdx] = fakePlugin;
                        fakePlugins[pInfo.name] = fakePlugin;
                    });

                    Object.defineProperties(fakePlugins, {
                        length: { value: pluginData.length, enumerable: true },
                        item: {
                            value: function(index) {
                                const i = Number(index);
                                if (!Number.isInteger(i) || i < 0 || i >= pluginData.length) return null;
                                return this[i] || null;
                            },
                            enumerable: false
                        },
                        namedItem: {
                            value: function(name) {
                                if (!name || typeof name !== 'string') return null;
                                return this[name] || null;
                            },
                            enumerable: false
                        },
                        refresh: {
                            value: function() {},
                            enumerable: false
                        }
                    });

                    Object.defineProperties(fakeMimeTypes, {
                        length: { value: allMimes.length, enumerable: true },
                        item: {
                            value: function(index) {
                                const i = Number(index);
                                if (!Number.isInteger(i) || i < 0 || i >= allMimes.length) return null;
                                return allMimes[i] || null;
                            },
                            enumerable: false
                        },
                        namedItem: {
                            value: function(name) {
                                if (!name || typeof name !== 'string') return null;
                                return this[name] || null;
                            },
                            enumerable: false
                        }
                    });

                    if (typeof Symbol !== 'undefined') {
                        if (Symbol.iterator) {
                            fakePlugins[Symbol.iterator] = Array.prototype[Symbol.iterator];
                            fakeMimeTypes[Symbol.iterator] = Array.prototype[Symbol.iterator];
                        }
                        if (Symbol.toStringTag) {
                            fakePlugins[Symbol.toStringTag] = 'PluginArray';
                            fakeMimeTypes[Symbol.toStringTag] = 'MimeTypeArray';
                        }
                    }

                    Object.defineProperty(navigator, 'plugins', {
                        get: () => fakePlugins,
                        enumerable: true,
                        configurable: true
                    });

                    Object.defineProperty(navigator, 'mimeTypes', {
                        get: () => fakeMimeTypes,
                        enumerable: true,
                        configurable: true
                    });
                }

                // 3. WebGL and WebGL2 getParameter spoofing
                const hookWebGLContext = function(ContextClass) {
                    if (typeof ContextClass === 'undefined' || !ContextClass || !ContextClass.prototype) return;
                    const originalGetParameter = ContextClass.prototype.getParameter;
                    if (typeof originalGetParameter === 'function') {
                        ContextClass.prototype.getParameter = function(parameter) {
                            // 37445: UNMASKED_VENDOR_WEBGL
                            if (parameter === 37445) return '${profile.vendor}';
                            // 37446: UNMASKED_RENDERER_WEBGL
                            if (parameter === 37446) return '${profile.renderer}';
                            return originalGetParameter.apply(this, arguments);
                        };

                        try {
                            ContextClass.prototype.getParameter.toString = function() {
                                return 'function getParameter() { [native code] }';
                            };
                        } catch (e) {}
                    }

                    const originalGetExtension = ContextClass.prototype.getExtension;
                    if (typeof originalGetExtension === 'function') {
                        ContextClass.prototype.getExtension = function(name) {
                            const ext = originalGetExtension.apply(this, arguments);
                            if (name === 'WEBGL_debug_renderer_info') {
                                return ext || {
                                    UNMASKED_VENDOR_WEBGL: 37445,
                                    UNMASKED_RENDERER_WEBGL: 37446
                                };
                            }
                            return ext;
                        };

                        try {
                            ContextClass.prototype.getExtension.toString = function() {
                                return 'function getExtension() { [native code] }';
                            };
                        } catch (e) {}
                    }
                };

                hookWebGLContext(window.WebGLRenderingContext);
                hookWebGLContext(window.WebGL2RenderingContext);
            } catch (e) {}
        })();
    `;
};

const createBrowserContext = async (browser, authIndex = 0, proxyConfig = null) => {
    const storageState = loadAuthStorageState(authIndex);
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

    return context;
};

const launchBrowser = async (options = {}) => {
    const { headless = true, proxy = null, executablePath: customExecutablePath = null } = options;

    const executablePath = customExecutablePath || resolveBrowserExecutablePath();

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

    return await firefox.launch(launchOpts);
};

const launchCloudShellBrowser = async (options = {}) => {
    const { authIndex = 0, proxy = null } = options;

    const browser = await launchBrowser(options);

    let proxyConfig = null;
    if (proxy) {
        proxyConfig = { server: proxy };
    } else {
        proxyConfig = parseProxyFromEnv();
    }

    const context = await createBrowserContext(browser, authIndex, proxyConfig);

    return { browser, context };
};

module.exports = {
    createBrowserContext,
    FIREFOX_DOH_DISABLED_PREFS,
    generatePrivacyInitScript,
    launchBrowser,
    launchCloudShellBrowser,
    loadAuthStorageState,
    resolveBrowserExecutablePath,
};
