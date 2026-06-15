const fs = require("fs");
const path = require("path");
const BrowserManager = require("../../src/core/BrowserManager");
const LoggingService = require("../../src/utils/LoggingService");

async function test() {
    const logger = new LoggingService("Test");
    const bm = new BrowserManager(logger, { maxContexts: 1 }, { getAuth: () => ({}) });

    const mockPage = {
        content: async () => "<html><body>Test Content</body></html>",
        isClosed: () => false,
        screenshot: async opts => {
            fs.writeFileSync(opts.path, "mock-screenshot-content");
        },
    };

    await bm._saveDebugArtifacts("test_run", 5, mockPage);

    const debugDir = path.join(process.cwd(), "data", "debug");
    const files = fs.readdirSync(debugDir);
    console.log("Created files:", files);

    const screenshotOk = files.some(f => f.startsWith("debug_screenshot_auth_5_test_run_") && f.endsWith(".png"));
    const htmlOk = files.some(f => f.startsWith("debug_page_source_auth_5_test_run_") && f.endsWith(".html"));

    if (screenshotOk && htmlOk) {
        console.log("SUCCESS: Debug artifacts formatted correctly inside data/debug/");
        process.exit(0);
    } else {
        console.error("FAIL: Incorrect format or directory");
        process.exit(1);
    }
}

test();
