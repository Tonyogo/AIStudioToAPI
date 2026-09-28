/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const { StateTracker } = require("../../scripts/cloudshell/stateTracker");

describe("CloudShell StateTracker", () => {
    const testStateDir = path.join(process.cwd(), "logs", "cloudshell_test_state");
    const testStateFile = path.join(testStateDir, "state.json");

    beforeEach(() => {
        if (fs.existsSync(testStateDir)) {
            fs.rmSync(testStateDir, { force: true, recursive: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(testStateDir)) {
            fs.rmSync(testStateDir, { force: true, recursive: true });
        }
    });

    test("saves and loads state atomically", () => {
        const tracker = new StateTracker(testStateFile);
        tracker.saveState({
            accounts: [{ authIndex: 0, status: "ready" }],
            currentAuthIndex: 0,
            pid: 1234,
            status: "running",
        });

        const loaded = tracker.loadState();
        expect(loaded).not.toBeNull();
        expect(loaded.pid).toBe(1234);
        expect(loaded.status).toBe("running");
        expect(loaded.accounts).toHaveLength(1);
    });

    test("merges partial data on subsequent saveState calls", () => {
        const tracker = new StateTracker(testStateFile);
        tracker.saveState({
            pid: 1234,
            status: "running",
            switchIntervalMinutes: 10,
        });

        tracker.saveState({
            currentAuthIndex: 1,
        });

        const loaded = tracker.loadState();
        expect(loaded.pid).toBe(1234);
        expect(loaded.status).toBe("running");
        expect(loaded.currentAuthIndex).toBe(1);
        expect(loaded.switchIntervalMinutes).toBe(10);
    });

    test("loadState returns null when file is missing or corrupted", () => {
        const tracker = new StateTracker(testStateFile);
        expect(tracker.loadState()).toBeNull();

        fs.mkdirSync(testStateDir, { recursive: true });
        fs.writeFileSync(testStateFile, "invalid json {[[", "utf-8");
        expect(tracker.loadState()).toBeNull();
    });

    test("clearState removes state file safely", () => {
        const tracker = new StateTracker(testStateFile);
        tracker.saveState({ pid: 1234 });
        expect(fs.existsSync(testStateFile)).toBe(true);

        tracker.clearState();
        expect(fs.existsSync(testStateFile)).toBe(false);

        // Clearing again should not throw
        expect(() => tracker.clearState()).not.toThrow();
    });

    test("formats status output correctly for stopped and running states", () => {
        const tracker = new StateTracker(testStateFile);
        const stoppedOutput = tracker.formatStatusOutput(null, false);
        expect(stoppedOutput).toContain("Stopped");

        const stoppedWithPreviousState = tracker.formatStatusOutput({ pid: 1234 }, false);
        expect(stoppedWithPreviousState).toContain("Stopped");

        const runningState = {
            accounts: [
                {
                    accountName: "test@gmail.com",
                    authIndex: 0,
                    lastHeartbeatAt: new Date().toISOString(),
                    status: "active",
                },
            ],
            currentAuthIndex: 0,
            pid: 9999,
            startedAt: new Date(Date.now() - 60000).toISOString(),
            status: "running",
            switchIntervalMinutes: 10,
        };
        const runningOutput = tracker.formatStatusOutput(runningState, true);
        expect(runningOutput).toContain("Running (PID: 9999)");
        expect(runningOutput).toContain("test@gmail.com");
        expect(runningOutput).toContain("Active");
    });
});
