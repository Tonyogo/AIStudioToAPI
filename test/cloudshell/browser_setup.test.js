/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const {
    generatePrivacyInitScript,
    loadAuthStorageState,
    resolveBrowserExecutablePath,
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
