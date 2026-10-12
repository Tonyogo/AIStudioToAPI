/**
 * File: scripts/cloudshell/daemonManager.js
 * Description: Daemon process lifecycle, PID management, and log tailing for Cloud Shell
 */

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

class DaemonManager {
    constructor(options = {}) {
        this.logDir = options.logDir || path.join(process.cwd(), "logs", "cloudshell");
        this.pidFile = options.pidFile || path.join(this.logDir, "daemon.pid");
        this.logFile = options.logFile || path.join(this.logDir, "daemon.log");
        this.scriptPath = options.scriptPath || path.join(__dirname, "runCloudShell.js");
        this.stateTracker = options.stateTracker || null;
    }

    getPid() {
        try {
            if (!fs.existsSync(this.pidFile)) {
                return null;
            }
            const content = fs.readFileSync(this.pidFile, "utf-8").trim();
            const pid = parseInt(content, 10);
            return Number.isInteger(pid) && pid > 0 ? pid : null;
        } catch {
            return null;
        }
    }

    writePid(pid) {
        const dir = path.dirname(this.pidFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.pidFile, `${pid}\n`, "utf-8");
    }

    removePid() {
        try {
            if (fs.existsSync(this.pidFile)) {
                fs.unlinkSync(this.pidFile);
            }
        } catch {
            // Ignore removal errors
        }
    }

    getProcessCommandLine(pid) {
        if (!pid || typeof pid !== "number" || Number.isNaN(pid) || pid <= 0) {
            return null;
        }

        if (process.platform === "linux") {
            try {
                const cmdlinePath = `/proc/${pid}/cmdline`;
                if (fs.existsSync(cmdlinePath)) {
                    const data = fs.readFileSync(cmdlinePath, "utf-8");
                    const cmd = data.split("\0").filter(Boolean).join(" ");
                    if (cmd) return cmd;
                }
            } catch {
                // fall through to ps
            }
        }

        if (process.platform === "win32") {
            try {
                const stdout = childProcess.execFileSync(
                    "powershell",
                    [
                        "-NoProfile",
                        "-Command",
                        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
                    ],
                    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }
                );
                return stdout ? stdout.trim() : null;
            } catch {
                return null;
            }
        }

        try {
            const stdout = childProcess.execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 3000,
            });
            return stdout ? stdout.trim() : null;
        } catch {
            return null;
        }
    }

    isCloudShellProcess(pid) {
        if (!pid || typeof pid !== "number" || Number.isNaN(pid) || pid <= 0) {
            return false;
        }
        if (pid === process.pid) {
            return true;
        }
        const cmd = this.getProcessCommandLine(pid);
        if (!cmd) {
            return false;
        }

        const firstToken = cmd.trim().split(/\s+/)[0];
        const baseBinary = path.basename(firstToken).toLowerCase();
        const nonTargetBinaries = new Set([
            "ag",
            "awk",
            "bat",
            "cat",
            "code",
            "echo",
            "egrep",
            "emacs",
            "fgrep",
            "git",
            "grep",
            "head",
            "less",
            "more",
            "nano",
            "nvim",
            "rg",
            "sed",
            "tail",
            "vi",
            "vim",
            "whereis",
            "which",
        ]);
        if (nonTargetBinaries.has(baseBinary)) {
            return false;
        }

        const scriptBase = path.basename(this.scriptPath);
        const scriptBaseNoExt = scriptBase.replace(/\.[^/.]+$/, "");
        const scriptPattern = new RegExp(`(?:^|\\s|[\\/\\\\])${scriptBaseNoExt}(?:\\.js)?(?:\\s|$)`);
        return cmd.includes(this.scriptPath) || cmd.includes(scriptBase) || scriptPattern.test(cmd);
    }

    isProcessAlive(pid, validateCommand = true) {
        if (!pid || typeof pid !== "number" || Number.isNaN(pid) || pid <= 0) {
            return false;
        }
        let alive = false;
        try {
            process.kill(pid, 0);
            alive = true;
        } catch (err) {
            alive = err.code === "EPERM";
        }
        if (!alive) {
            return false;
        }
        if (validateCommand) {
            return this.isCloudShellProcess(pid);
        }
        return true;
    }

    buildForwardArgs(options = {}) {
        const args = ["start", "--foreground"];
        if (options.all) {
            args.push("--all");
        } else if (Array.isArray(options.authIndices) && options.authIndices.length > 0) {
            args.push("--auth", options.authIndices.join(","));
        }
        if (options.switchIntervalMinutes) {
            args.push("--switch-interval", String(options.switchIntervalMinutes));
        }
        if (options.keepAliveMinutes !== undefined && options.keepAliveMinutes !== -1) {
            args.push("--keep-alive", String(options.keepAliveMinutes));
        }
        if (options.heartbeatIntervalSeconds) {
            args.push("--heartbeat-interval", String(options.heartbeatIntervalSeconds));
        }
        if (options.proxy) {
            args.push("--proxy", options.proxy);
        }
        if (options.headless === false) {
            args.push("--headless", "false");
        }
        if (options.debug) {
            args.push("--debug");
        }
        return args;
    }

    startDaemon(options = {}) {
        const currentPid = this.getPid();
        if (currentPid && this.isProcessAlive(currentPid)) {
            throw new Error(`CloudShell is already running (PID: ${currentPid}). Use "stop" or "restart" first.`);
        }
        if (currentPid) {
            this.removePid();
        }

        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const outFd = fs.openSync(this.logFile, "a");
        const childArgs = this.buildForwardArgs(options);
        const child = childProcess.spawn(process.execPath, [this.scriptPath, ...childArgs], {
            detached: true,
            stdio: ["ignore", outFd, outFd],
        });
        fs.closeSync(outFd);

        this.writePid(child.pid);
        child.unref();

        return { background: true, pid: child.pid };
    }

    async stopDaemon(force = false, { pollIntervalMs = 200, timeoutMs = 10000 } = {}) {
        const pid = this.getPid();
        if (!pid || !this.isProcessAlive(pid)) {
            this.removePid();
            if (this.stateTracker) {
                this.stateTracker.clearState();
            }
            return { message: "CloudShell is not running.", pid: null, stopped: false };
        }

        if (force) {
            try {
                process.kill(pid, "SIGKILL");
            } catch {
                // Ignore kill errors
            }
            this.removePid();
            if (this.stateTracker) {
                this.stateTracker.clearState();
            }
            return { message: `Killed CloudShell process ${pid}`, pid, stopped: true };
        }

        try {
            process.kill(pid, "SIGTERM");
        } catch {
            this.removePid();
            if (this.stateTracker) {
                this.stateTracker.clearState();
            }
            return { message: `Stopped CloudShell process ${pid}`, pid, stopped: true };
        }

        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (!this.isProcessAlive(pid, false)) {
                this.removePid();
                if (this.stateTracker) {
                    this.stateTracker.clearState();
                }
                return { message: `Stopped CloudShell process ${pid}`, pid, stopped: true };
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        let killedWithSigkill = false;
        if (this.isProcessAlive(pid, true)) {
            try {
                process.kill(pid, "SIGKILL");
                killedWithSigkill = true;
            } catch {
                // Ignore kill errors
            }
        }

        this.removePid();
        if (this.stateTracker) {
            this.stateTracker.clearState();
        }
        return {
            message: killedWithSigkill
                ? `CloudShell process ${pid} did not exit within ${timeoutMs / 1000}s, killed with SIGKILL`
                : `Stopped CloudShell process ${pid}`,
            pid,
            stopped: true,
        };
    }

    tailLogs(follow = false, lines = 50) {
        if (!fs.existsSync(this.logFile)) {
            console.log(`Log file not found: ${this.logFile}`);
            return null;
        }

        let currentSize = 0;
        try {
            const stat = fs.statSync(this.logFile);
            currentSize = stat.size;
            const content = fs.readFileSync(this.logFile, "utf-8");
            const raw = content.endsWith("\n") ? content.slice(0, -1) : content;
            const allLines = raw ? raw.split("\n") : [];
            const tail = allLines.slice(-lines).join("\n");
            if (tail) {
                process.stdout.write(tail + (tail.endsWith("\n") ? "" : "\n"));
            }
        } catch {
            // Ignore initial read error
        }

        if (!follow) {
            return null;
        }

        const watcher = fs.watch(this.logFile, eventType => {
            if (eventType === "change") {
                try {
                    const stat = fs.statSync(this.logFile);
                    if (stat.size > currentSize) {
                        const stream = fs.createReadStream(this.logFile, {
                            end: stat.size,
                            start: currentSize,
                        });
                        stream.pipe(process.stdout, { end: false });
                        currentSize = stat.size;
                    } else if (stat.size < currentSize) {
                        currentSize = stat.size;
                    }
                } catch {
                    // Ignore stream error
                }
            }
        });

        return watcher;
    }
}

module.exports = {
    DaemonManager,
};
