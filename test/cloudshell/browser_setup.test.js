/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const {
    generatePrivacyInitScript,
    launchBrowser,
    loadAuthStorageState,
    resolveBrowserExecutablePath,
} = require("../../scripts/cloudshell/browserSetup");

describe("CloudShell Browser Setup", () => {
    const testAuthDir = path.join(process.cwd(), "configs", "cloudshell");
    const testAuthFile = path.join(testAuthDir, "auth-9999.json");

    beforeAll(() => {
        if (!fs.existsSync(testAuthDir)) {
            fs.mkdirSync(testAuthDir, { recursive: true });
        }
        fs.writeFileSync(
            testAuthFile,
            JSON.stringify({
                cookies: [
                    {
                        domain: ".google.com",
                        name: "SSID",
                        path: "/",
                        value: "test-cookie",
                    },
                ],
                origins: [],
            })
        );
    });

    afterAll(() => {
        if (fs.existsSync(testAuthFile)) {
            fs.unlinkSync(testAuthFile);
        }
        try {
            if (fs.existsSync(testAuthDir) && fs.readdirSync(testAuthDir).length === 0) {
                fs.rmdirSync(testAuthDir);
            }
        } catch {
            // ignore
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

    test("resolveBrowserExecutablePath respects CAMOUFOX_EXECUTABLE_PATH environment variable", () => {
        const originalEnv = process.env.CAMOUFOX_EXECUTABLE_PATH;
        try {
            process.env.CAMOUFOX_EXECUTABLE_PATH = "/tmp/mock-camoufox-bin";
            expect(resolveBrowserExecutablePath()).toBe("/tmp/mock-camoufox-bin");

            // Empty or whitespace CAMOUFOX_EXECUTABLE_PATH falls back to platform default / null
            process.env.CAMOUFOX_EXECUTABLE_PATH = "   ";
            const fallback = resolveBrowserExecutablePath();
            expect(fallback).not.toBe("   ");
        } finally {
            if (originalEnv !== undefined) {
                process.env.CAMOUFOX_EXECUTABLE_PATH = originalEnv;
            } else {
                delete process.env.CAMOUFOX_EXECUTABLE_PATH;
            }
        }
    });

    test("launchBrowser respects custom executablePath in options", async () => {
        const { firefox } = require("playwright");
        const launchSpy = jest.spyOn(firefox, "launch").mockResolvedValue({ close: jest.fn() });

        await launchBrowser({ executablePath: "/custom/firefox/bin" });
        expect(launchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                executablePath: "/custom/firefox/bin",
            })
        );
        launchSpy.mockRestore();
    });

    test("generatePrivacyInitScript includes WebGL2 and legitimate plugins definition", () => {
        const script = generatePrivacyInitScript("test-seed");
        expect(script).toContain("WebGL2RenderingContext");
        expect(script).toContain("PluginArray");
        expect(script).toContain("PDF Viewer");
        expect(script).toContain("namedItem");
        expect(script).toContain("refresh");
    });

    test("generatePrivacyInitScript executes and constructs functioning plugins and WebGL2 objects", () => {
        const script = generatePrivacyInitScript("test-seed");

        const mockWindow = {
            MimeType: function MimeType() {},
            MimeTypeArray: function MimeTypeArray() {},
            Plugin: function Plugin() {},
            PluginArray: function PluginArray() {},
            WebGL2RenderingContext: {
                prototype: {
                    getExtension: jest.fn().mockReturnValue(null),
                    getParameter: jest.fn().mockImplementation(param => `original_webgl2_${param}`),
                },
            },
            WebGLRenderingContext: {
                prototype: {
                    getExtension: jest.fn().mockReturnValue(null),
                    getParameter: jest.fn().mockImplementation(param => `original_${param}`),
                },
            },
        };
        const mockNavigator = { plugins: [] };

        const fn = new Function("window", "navigator", script);
        fn(mockWindow, mockNavigator);

        // Verify navigator.plugins
        expect(mockNavigator.plugins.length).toBeGreaterThan(0);
        expect(typeof mockNavigator.plugins.item).toBe("function");
        expect(typeof mockNavigator.plugins.namedItem).toBe("function");
        expect(typeof mockNavigator.plugins.refresh).toBe("function");

        // item() strictly accepts index, does not match string names
        expect(mockNavigator.plugins.item("PDF Viewer")).toBeNull();
        expect(mockNavigator.plugins.item(-1)).toBeNull();

        const firstPlugin = mockNavigator.plugins[0];
        expect(firstPlugin).toBeDefined();
        expect(mockNavigator.plugins.item(0)).toBe(firstPlugin);
        expect(firstPlugin.name).toBe("PDF Viewer");
        expect(firstPlugin.filename).toBe("internal-pdf-viewer");
        expect(typeof firstPlugin.item).toBe("function");
        expect(typeof firstPlugin.namedItem).toBe("function");
        expect(mockNavigator.plugins.namedItem("PDF Viewer")).toBe(firstPlugin);

        // Verify iterable plugins and MIME types
        const pluginMimes = Array.from(firstPlugin);
        expect(pluginMimes.length).toBeGreaterThan(0);
        expect(pluginMimes[0].enabledPlugin).toBe(firstPlugin);

        // Verify Symbol.toStringTag
        expect(Object.prototype.toString.call(mockNavigator.plugins)).toBe("[object PluginArray]");
        expect(Object.prototype.toString.call(mockNavigator.mimeTypes)).toBe("[object MimeTypeArray]");
        expect(Object.prototype.toString.call(firstPlugin)).toBe("[object Plugin]");
        expect(Object.prototype.toString.call(pluginMimes[0])).toBe("[object MimeType]");

        // Verify WebGL and WebGL2 getParameter spoofing
        const gl1Instance = Object.create(mockWindow.WebGLRenderingContext.prototype);
        const gl2Instance = Object.create(mockWindow.WebGL2RenderingContext.prototype);

        expect(gl1Instance.getParameter(37445)).toBeDefined();
        expect(gl1Instance.getParameter(37446)).toBeDefined();
        expect(gl2Instance.getParameter(37445)).toBeDefined();
        expect(gl2Instance.getParameter(37446)).toBeDefined();
        // Regular parameters pass through to original
        expect(gl2Instance.getParameter(1234)).toBe("original_webgl2_1234");

        // Verify WEBGL_debug_renderer_info getExtension spoofing
        const ext = gl2Instance.getExtension("WEBGL_debug_renderer_info");
        expect(ext).toBeDefined();
        expect(ext.UNMASKED_VENDOR_WEBGL).toBe(37445);
        expect(ext.UNMASKED_RENDERER_WEBGL).toBe(37446);
    });
});
