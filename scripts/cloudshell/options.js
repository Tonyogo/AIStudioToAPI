/**
 * File: scripts/cloudshell/options.js
 * Description: CLI options parser and help generator for Cloud Shell runner
 */

const parseBooleanLike = value => {
    if (value === undefined || value === null || value === "") return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
    return undefined;
};

const parseAuthIndices = raw => {
    if (!raw || typeof raw !== "string" || !raw.trim()) {
        throw new Error(`Invalid auth index: ${raw}. Must be a non-negative integer.`);
    }
    const parts = raw.split(",");
    const result = [];
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) {
            throw new Error(`Invalid auth index: ${raw}. Must be a non-negative integer.`);
        }
        if (trimmed.includes("-")) {
            const rangeParts = trimmed.split("-");
            if (rangeParts.length !== 2 || rangeParts[0] === "" || rangeParts[1] === "") {
                throw new Error(`Invalid auth index: ${raw}. Must be a non-negative integer.`);
            }
            const start = parseInt(rangeParts[0], 10);
            const end = parseInt(rangeParts[1], 10);
            if (
                Number.isNaN(start) ||
                Number.isNaN(end) ||
                start < 0 ||
                end < start ||
                String(start) !== rangeParts[0] ||
                String(end) !== rangeParts[1]
            ) {
                throw new Error(`Invalid auth index: ${raw}. Must be a non-negative integer.`);
            }
            for (let k = start; k <= end; k++) {
                result.push(k);
            }
        } else {
            const val = parseInt(trimmed, 10);
            if (Number.isNaN(val) || val < 0 || String(val) !== trimmed) {
                throw new Error(`Invalid auth index: ${raw}. Must be a non-negative integer.`);
            }
            result.push(val);
        }
    }
    if (result.length === 0) {
        throw new Error(`Invalid auth index: ${raw}. Must be a non-negative integer.`);
    }
    return Array.from(new Set(result)).sort((a, b) => a - b);
};

const VALID_COMMANDS = new Set(["start", "status", "stop", "restart", "logs", "pause", "resume"]);

const parseCliArgs = (args = []) => {
    let command = "status";
    let startIndex = 0;

    if (args.length > 0 && !args[0].startsWith("-")) {
        const cmd = args[0].toLowerCase();
        if (!VALID_COMMANDS.has(cmd)) {
            throw new Error(
                `Unknown command: ${args[0]}. Available commands: start, status, stop, restart, logs, pause, resume`
            );
        }
        command = cmd;
        startIndex = 1;
    }

    const options = {
        all: false,
        authIndices: [0],
        command,
        debug: false,
        follow: false,
        force: false,
        foreground: false,
        headless: true,
        heartbeatIntervalSeconds: 120,
        help: false,
        keepAliveMinutes: -1,
        proxy: null,
        switchIntervalMinutes: 10,
    };

    for (let i = startIndex; i < args.length; i++) {
        const arg = args[i];

        if (arg === "-h" || arg === "--help") {
            options.help = true;
            continue;
        }

        if (arg === "--debug") {
            options.debug = true;
            continue;
        }

        if (arg === "--all") {
            options.all = true;
            continue;
        }

        if (arg === "--foreground") {
            options.foreground = true;
            continue;
        }

        if (arg === "--force") {
            options.force = true;
            continue;
        }

        if (arg === "--follow") {
            options.follow = true;
            continue;
        }

        if (arg === "-f") {
            if (options.command === "logs") {
                options.follow = true;
            } else if (options.command === "stop") {
                options.force = true;
            } else {
                options.foreground = true;
            }
            continue;
        }

        if (arg.startsWith("--headless=")) {
            const rawVal = arg.slice("--headless=".length);
            const parsed = parseBooleanLike(rawVal);
            if (parsed === undefined) {
                throw new Error(`Invalid boolean value for --headless: ${rawVal}. Must be true or false.`);
            }
            options.headless = parsed;
            continue;
        }

        if (arg === "--headless") {
            const nextArg = args[i + 1];
            const parsed = parseBooleanLike(nextArg);
            if (parsed !== undefined) {
                options.headless = parsed;
                i++;
            } else {
                options.headless = true;
            }
            continue;
        }

        if (arg === "--headed") {
            options.headless = false;
            options.foreground = true;
            continue;
        }

        if (arg.startsWith("--auth=")) {
            const rawVal = arg.slice("--auth=".length);
            options.authIndices = parseAuthIndices(rawVal);
            continue;
        }
        if (arg === "--auth") {
            const rawVal = args[++i];
            options.authIndices = parseAuthIndices(rawVal);
            continue;
        }

        if (arg === "--cmd" || arg.startsWith("--cmd=")) {
            throw new Error(
                "--cmd is deprecated and no longer supported. Cloud Shell operates in interactive / keep-alive mode."
            );
        }

        if (arg === "--file" || arg.startsWith("--file=")) {
            throw new Error(
                "--file is deprecated and no longer supported. Cloud Shell operates in interactive / keep-alive mode."
            );
        }

        if (arg.startsWith("--switch-interval=")) {
            const val = parseInt(arg.slice("--switch-interval=".length), 10);
            if (Number.isNaN(val) || val <= 0) {
                throw new Error("Invalid switch-interval. Must be a positive integer.");
            }
            options.switchIntervalMinutes = val;
            continue;
        }
        if (arg === "--switch-interval") {
            const val = parseInt(args[++i], 10);
            if (Number.isNaN(val) || val <= 0) {
                throw new Error("Invalid switch-interval. Must be a positive integer.");
            }
            options.switchIntervalMinutes = val;
            continue;
        }

        if (arg.startsWith("--keep-alive=")) {
            const val = parseInt(arg.slice("--keep-alive=".length), 10);
            if (Number.isNaN(val)) {
                throw new Error("Invalid keep-alive minutes. Must be an integer.");
            }
            options.keepAliveMinutes = val;
            continue;
        }
        if (arg === "--keep-alive") {
            const val = parseInt(args[++i], 10);
            if (Number.isNaN(val)) {
                throw new Error("Invalid keep-alive minutes. Must be an integer.");
            }
            options.keepAliveMinutes = val;
            continue;
        }

        if (arg.startsWith("--heartbeat-interval=")) {
            const val = parseInt(arg.slice("--heartbeat-interval=".length), 10);
            if (Number.isNaN(val) || val <= 0) {
                throw new Error("Invalid heartbeat interval. Must be a positive integer.");
            }
            options.heartbeatIntervalSeconds = val;
            continue;
        }
        if (arg === "--heartbeat-interval") {
            const val = parseInt(args[++i], 10);
            if (Number.isNaN(val) || val <= 0) {
                throw new Error("Invalid heartbeat interval. Must be a positive integer.");
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
    console.log("Usage: node scripts/cloudshell/runCloudShell.js <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  start                      Start Cloud Shell daemon (or foreground if --foreground / --headed)");
    console.log("  status                     Show Cloud Shell daemon status and account state (default)");
    console.log("  stop                       Stop running Cloud Shell daemon");
    console.log("  restart                    Restart Cloud Shell daemon");
    console.log("  logs                       View or follow Cloud Shell daemon logs");
    console.log("  pause                      Pause anti-detection micro-actions and auto-rotation");
    console.log("  resume                     Resume anti-detection micro-actions and auto-rotation");
    console.log("");
    console.log("Options:");
    console.log("  -h, --help                 Show this help message");
    console.log("  -f, --foreground           Run in foreground (start command only)");
    console.log("  -f, --follow               Follow log output in real-time (logs command only)");
    console.log("  --force                    Force stop immediately (SIGKILL) (stop command only)");
    console.log(
        "  --auth <indices>           Auth index or range in configs/auth/auth-N.json (e.g. 0, 0,1,2, 0-3; default: 0)"
    );
    console.log("  --all                      Automatically discover and load all configs/auth/auth-N.json accounts");
    console.log("  --switch-interval <min>    Active context rotation interval in minutes (default: 10)");
    console.log("  --keep-alive <min>         Keep-alive duration in minutes (-1=infinite, default: -1)");
    console.log("  --heartbeat-interval <s>   Anti-idle keypress interval in seconds (default: 120)");
    console.log("  --headless [true|false]    Run in headless mode (default: true)");
    console.log("  --headed                   Shortcut for --headless false (visible window, forces foreground)");
    console.log("  --proxy <url>              Proxy server URL (e.g. http://127.0.0.1:7890)");
    console.log("  --debug                    Capture screenshots and HTML dumps to logs/cloudshell/");
    console.log("");
    console.log("Examples:");
    console.log("  npm run cloudshell -- start --auth 0");
    console.log("  npm run cloudshell -- start --auth 0-2 --switch-interval 15");
    console.log("  npm run cloudshell -- start --all --headed");
    console.log("  npm run cloudshell -- status");
    console.log("  npm run cloudshell -- logs -f");
    console.log("  npm run cloudshell -- pause");
    console.log("  npm run cloudshell -- resume");
    console.log("  npm run cloudshell -- stop");
};

module.exports = {
    parseAuthIndices,
    parseCliArgs,
    printHelp,
};
