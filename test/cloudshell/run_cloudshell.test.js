/* eslint-env jest */
const { spawnSync } = require("child_process");
const path = require("path");

describe("CloudShell CLI Entrypoint Smoke Test", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "cloudshell", "runCloudShell.js");

    test("--help outputs usage and exits with 0", () => {
        const res = spawnSync("node", [scriptPath, "--help"], {
            encoding: "utf-8",
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Usage: node scripts/cloudshell/runCloudShell.js");
        expect(res.stdout).toContain("--auth <indices>");
        expect(res.stdout).toContain("--all");
        expect(res.stdout).toContain("--switch-interval <min>");
        expect(res.stdout).not.toContain("--cmd <command>");
        expect(res.stdout).not.toContain("--file <path>");
    });

    test("deprecated --cmd exits with error code 1 and warning message", () => {
        const res = spawnSync("node", [scriptPath, "--cmd", "echo test"], {
            encoding: "utf-8",
        });
        expect(res.status).toBe(1);
        expect(res.stderr || res.stdout).toContain("--cmd is deprecated and no longer supported");
    });

    test("missing auth file exits with error code 1 and helpful message", () => {
        const res = spawnSync("node", [scriptPath, "start", "--auth", "987654"], {
            encoding: "utf-8",
        });
        expect(res.status).toBe(1);
        expect(res.stderr || res.stdout).toContain("auth-987654.json does not exist");
    });

    test("cloudshell status outputs stopped when no daemon is running", () => {
        const res = spawnSync("node", [scriptPath, "status"], { encoding: "utf-8" });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Stopped");
    });

    test("cloudshell stop outputs message when not running", () => {
        const res = spawnSync("node", [scriptPath, "stop"], { encoding: "utf-8" });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("not running");
    });

    test("cloudshell pause outputs message when daemon is not running", () => {
        const res = spawnSync("node", [scriptPath, "pause"], { encoding: "utf-8" });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("not running");
    });

    test("cloudshell resume outputs message when daemon is not running", () => {
        const res = spawnSync("node", [scriptPath, "resume"], { encoding: "utf-8" });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("not running");
    });

    test("handlePause and handleResume update stateTracker when alive", () => {
        const { handlePause, handleResume } = require("../../scripts/cloudshell/runCloudShell");
        const mockTracker = { setPaused: jest.fn() };
        const mockDaemon = {
            getPid: () => 1234,
            isProcessAlive: () => true,
        };

        const spyLog = jest.spyOn(console, "log").mockImplementation(() => {});

        handlePause(mockTracker, mockDaemon);
        expect(mockTracker.setPaused).toHaveBeenCalledWith(true);

        handleResume(mockTracker, mockDaemon);
        expect(mockTracker.setPaused).toHaveBeenCalledWith(false);

        spyLog.mockRestore();
    });

    test("handleStart launches daemon when headless is false but foreground is false", async () => {
        const { handleStart } = require("../../scripts/cloudshell/runCloudShell");
        const { CloudShellManager } = require("../../scripts/cloudshell/CloudShellManager");
        expect(typeof handleStart).toBe("function");

        const mockValidate = jest.spyOn(CloudShellManager.prototype, "validateAuthFiles").mockImplementation(() => {});
        const mockTracker = {};
        const mockDaemon = {
            logFile: "/dummy/path.log",
            startDaemon: jest.fn().mockReturnValue({ pid: 5678 }),
        };
        const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {});
        const mockConsole = jest.spyOn(console, "log").mockImplementation(() => {});

        await handleStart({ authIndices: [0], foreground: false, headless: false }, mockTracker, mockDaemon);

        expect(mockDaemon.startDaemon).toHaveBeenCalled();
        expect(mockExit).toHaveBeenCalledWith(0);

        mockValidate.mockRestore();
        mockExit.mockRestore();
        mockConsole.mockRestore();
    });

    test("default without subcommand outputs status and usage", () => {
        const res = spawnSync("node", [scriptPath], { encoding: "utf-8" });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain("Stopped");
        expect(res.stdout).toContain("Usage:");
    });
});
