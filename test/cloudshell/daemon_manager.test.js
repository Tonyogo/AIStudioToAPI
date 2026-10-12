/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const { DaemonManager } = require("../../scripts/cloudshell/daemonManager");

describe("CloudShell DaemonManager", () => {
    const testDir = path.join(process.cwd(), "logs", "cloudshell_test_daemon");
    const pidFile = path.join(testDir, "daemon.pid");
    const logFile = path.join(testDir, "daemon.log");

    beforeEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { force: true, recursive: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { force: true, recursive: true });
        }
        jest.restoreAllMocks();
    });

    test("writes and reads PID correctly", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        expect(dm.getPid()).toBeNull();
        dm.writePid(54321);
        expect(dm.getPid()).toBe(54321);
        dm.removePid();
        expect(dm.getPid()).toBeNull();
    });

    test("isProcessAlive returns true for current process and false for non-existent pid", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        expect(dm.isProcessAlive(process.pid)).toBe(true);
        expect(dm.isProcessAlive(9999999)).toBe(false);
        expect(dm.isProcessAlive(null)).toBe(false);
        expect(dm.isProcessAlive(-1)).toBe(false);
    });

    test("startDaemon throws error when already running", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        dm.writePid(12345);
        jest.spyOn(dm, "isProcessAlive").mockReturnValue(true);

        expect(() => dm.startDaemon({})).toThrow(/already running/i);
    });

    test("startDaemon spawns detached background process and writes PID", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        const mockChild = {
            pid: 7777,
            unref: jest.fn(),
        };
        const spawnSpy = jest.spyOn(childProcess, "spawn").mockReturnValue(mockChild);

        const result = dm.startDaemon({
            authIndices: [0, 1],
            switchIntervalMinutes: 15,
        });

        expect(result.pid).toBe(7777);
        expect(result.background).toBe(true);
        expect(dm.getPid()).toBe(7777);
        expect(mockChild.unref).toHaveBeenCalled();
        expect(spawnSpy).toHaveBeenCalledWith(
            process.execPath,
            expect.arrayContaining(["start", "--foreground", "--auth", "0,1", "--switch-interval", "15"]),
            expect.objectContaining({ detached: true })
        );
    });

    test("buildForwardArgs includes --headless false when options.headless is false", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        const args = dm.buildForwardArgs({
            authIndices: [0],
            headless: false,
        });
        expect(args).toContain("--headless");
        const idx = args.indexOf("--headless");
        expect(args[idx + 1]).toBe("false");
    });

    test("stopDaemon returns message when not running", async () => {
        const dm = new DaemonManager({ logFile, pidFile });
        const result = await dm.stopDaemon();
        expect(result.stopped).toBe(false);
        expect(result.message).toContain("not running");
    });

    test("stopDaemon terminates running process with SIGTERM", async () => {
        const dm = new DaemonManager({ logFile, pidFile });
        dm.writePid(8888);

        let aliveCalls = 0;
        jest.spyOn(dm, "isProcessAlive").mockImplementation(() => {
            aliveCalls++;
            return aliveCalls <= 1; // alive on first check, dead on second check
        });
        const killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);

        const result = await dm.stopDaemon(false, { pollIntervalMs: 10, timeoutMs: 200 });
        expect(result.stopped).toBe(true);
        expect(result.pid).toBe(8888);
        expect(killSpy).toHaveBeenCalledWith(8888, "SIGTERM");
        expect(dm.getPid()).toBeNull();
    });

    test("stopDaemon with force sends SIGKILL directly", async () => {
        const dm = new DaemonManager({ logFile, pidFile });
        dm.writePid(9999);
        jest.spyOn(dm, "isProcessAlive").mockReturnValue(true);
        const killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);

        const result = await dm.stopDaemon(true);
        expect(result.stopped).toBe(true);
        expect(result.pid).toBe(9999);
        expect(killSpy).toHaveBeenCalledWith(9999, "SIGKILL");
        expect(dm.getPid()).toBeNull();
    });

    test("tailLogs reads last lines of log file", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(logFile, "line 1\nline 2\nline 3\n", "utf-8");

        const stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
        dm.tailLogs(false, 2);
        expect(stdoutSpy).toHaveBeenCalledWith("line 2\nline 3\n");
    });

    test("getProcessCommandLine returns command string for valid pid and null for non-existent", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        const cmd = dm.getProcessCommandLine(process.pid);
        expect(typeof cmd).toBe("string");
        expect(cmd.length).toBeGreaterThan(0);

        expect(dm.getProcessCommandLine(9999999)).toBeNull();
        expect(dm.getProcessCommandLine(-1)).toBeNull();
        expect(dm.getProcessCommandLine(null)).toBeNull();
    });

    test("isCloudShellProcess validates expected script in command line", () => {
        const dm = new DaemonManager({ logFile, pidFile });

        // Current process is recognized
        expect(dm.isCloudShellProcess(process.pid)).toBe(true);

        // Foreign PID running cloudshell
        jest.spyOn(dm, "getProcessCommandLine").mockReturnValue("node /app/scripts/cloudshell/runCloudShell.js start");
        expect(dm.isCloudShellProcess(55555)).toBe(true);

        // Foreign PID running an unrelated process
        dm.getProcessCommandLine.mockReturnValue("nginx: master process /usr/sbin/nginx");
        expect(dm.isCloudShellProcess(55555)).toBe(false);
    });

    test("isProcessAlive validates process command line by default", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        jest.spyOn(process, "kill").mockImplementation(() => true); // simulate process alive

        // Command matches CloudShell
        jest.spyOn(dm, "getProcessCommandLine").mockReturnValue("node scripts/cloudshell/runCloudShell.js start");
        expect(dm.isProcessAlive(55555)).toBe(true);

        // Command belongs to another process (PID reuse)
        dm.getProcessCommandLine.mockReturnValue("/usr/bin/python3 -m http.server 8080");
        expect(dm.isProcessAlive(55555)).toBe(false);
        // But alive without command check
        expect(dm.isProcessAlive(55555, false)).toBe(true);
    });

    test("stopDaemon protects against PID reuse and does not kill unrelated process", async () => {
        const dm = new DaemonManager({ logFile, pidFile });
        dm.writePid(44444);

        const killSpy = jest.spyOn(process, "kill").mockImplementation((pid, sig) => {
            if (sig === 0) return true; // process exists
            return true;
        });

        // PID is running an unrelated system process
        jest.spyOn(dm, "getProcessCommandLine").mockReturnValue("/usr/sbin/cron -f");

        const result = await dm.stopDaemon();
        expect(result.stopped).toBe(false);
        expect(killSpy).not.toHaveBeenCalledWith(44444, "SIGTERM");
        expect(killSpy).not.toHaveBeenCalledWith(44444, "SIGKILL");
        expect(dm.getPid()).toBeNull();
    });

    test("isCloudShellProcess rejects commands from tools like git, grep, and cat even when referencing script file", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        const spyCmd = jest.spyOn(dm, "getProcessCommandLine");

        spyCmd.mockReturnValue("git diff scripts/cloudshell/runCloudShell.js");
        expect(dm.isCloudShellProcess(55555)).toBe(false);

        spyCmd.mockReturnValue("cat scripts/cloudshell/runCloudShell.js");
        expect(dm.isCloudShellProcess(55555)).toBe(false);

        spyCmd.mockReturnValue("grep -rn runCloudShell .");
        expect(dm.isCloudShellProcess(55555)).toBe(false);

        spyCmd.mockRestore();
    });

    test("stopDaemon accurately reports SIGKILL vs graceful termination", async () => {
        const dm = new DaemonManager({ logFile, pidFile });
        dm.writePid(33333);

        jest.spyOn(dm, "isProcessAlive").mockReturnValue(true);
        const killSpy = jest.spyOn(process, "kill").mockImplementation(() => true);

        const result = await dm.stopDaemon(false, { pollIntervalMs: 5, timeoutMs: 20 });
        expect(result.stopped).toBe(true);
        expect(killSpy).toHaveBeenCalledWith(33333, "SIGTERM");
        expect(killSpy).toHaveBeenCalledWith(33333, "SIGKILL");
        expect(result.message).toContain("killed with SIGKILL");
    });
});
