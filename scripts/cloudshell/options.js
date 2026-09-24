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
    console.log('  npm run cloudshell -- --auth 0 --cmd "docker ps"');
    console.log('  npm run cloudshell -- --auth 1 --cmd "uname -a" --keep-alive 60');
};

module.exports = {
    parseCliArgs,
    printHelp,
};
