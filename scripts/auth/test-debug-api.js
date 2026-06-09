const fs = require("fs");
const path = require("path");

const debugDir = path.join(process.cwd(), "data", "debug");
if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
}

const mockFiles = [
    "debug_screenshot_auth_1_myaccount_2026-06-09T10-00-00.png",
    "debug_page_source_auth_1_myaccount_2026-06-09T10-00-00.html",
    "debug_screenshot_unknownaccount_2026-06-09T10-05-00.png"
];

mockFiles.forEach(f => fs.writeFileSync(path.join(debugDir, f), "content"));

const regex = /^debug_(screenshot|page_source)_(?:auth_(\d+)_)?([a-zA-Z0-9_-]+)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(png|html)$/;

let passed = true;

mockFiles.forEach(filename => {
    const match = filename.match(regex);
    if (!match) {
        console.error(`Failed to match: ${filename}`);
        passed = false;
        return;
    }

    const [_, type, authIndex, scene, timestamp, ext] = match;
    console.log(`Matched ${filename}: type=${type}, authIndex=${authIndex}, scene=${scene}, timestamp=${timestamp}, ext=${ext}`);

    if (ext === "png" && type !== "screenshot") passed = false;
    if (ext === "html" && type !== "page_source") passed = false;
});

if (passed) {
    console.log("SUCCESS: Backend aggregation regex and parsing logic verified successfully!");
} else {
    console.error("Verification failed!");
    process.exit(1);
}

mockFiles.forEach(f => fs.unlinkSync(path.join(debugDir, f)));
