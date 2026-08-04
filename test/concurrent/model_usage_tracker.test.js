/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const ModelUsageTracker = require("../../src/concurrent/ModelUsageTracker");

describe("ModelUsageTracker", () => {
    const testDataDir = path.join(process.cwd(), "tmp_test_data");
    const testFilePath = path.join(testDataDir, "concurrent-model-usage.json");

    afterEach(() => {
        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }
        if (fs.existsSync(testDataDir)) {
            fs.rmdirSync(testDataDir);
        }
    });

    test("getBeijingCycleKey calculates correct cycle key before and after 15:00 Beijing time", () => {
        const tracker = new ModelUsageTracker(null, testFilePath);

        // Beijing time: 2026-08-02 10:00:00 (UTC: 2026-08-02 02:00:00) -> before 15:00 -> cycle key is 2026-08-01_15:00
        const before15 = new Date("2026-08-02T02:00:00Z");
        expect(tracker.getBeijingCycleKey(before15)).toBe("2026-08-01_15:00");

        // Beijing time: 2026-08-02 16:00:00 (UTC: 2026-08-02 08:00:00) -> after 15:00 -> cycle key is 2026-08-02_15:00
        const after15 = new Date("2026-08-02T08:00:00Z");
        expect(tracker.getBeijingCycleKey(after15)).toBe("2026-08-02_15:00");
    });

    test("recordUsage increments count and retrieves current count", () => {
        const tracker = new ModelUsageTracker(null, testFilePath);
        expect(tracker.getUsage(0, "gemini-2.5-flash")).toBe(0);

        tracker.recordUsage(0, "gemini-2.5-flash");
        expect(tracker.getUsage(0, "gemini-2.5-flash")).toBe(1);

        tracker.recordUsage(0, "gemini-2.5-flash");
        expect(tracker.getUsage(0, "gemini-2.5-flash")).toBe(2);
        expect(tracker.getUsage(1, "gemini-2.5-flash")).toBe(0);
    });

    test("persists and restores stats from disk file", () => {
        const tracker = new ModelUsageTracker(null, testFilePath);
        tracker.recordUsage(0, "gemini-2.5-pro");
        tracker.saveSync();

        const tracker2 = new ModelUsageTracker(null, testFilePath);
        tracker2.loadSync();
        expect(tracker2.getUsage(0, "gemini-2.5-pro")).toBe(1);
    });

    test("getAccountUsageDetails calculates total and per-model usage with limits, omitting unused models", () => {
        const tracker = new ModelUsageTracker(null, testFilePath);
        tracker.recordUsage(0, "gemini-2.5-flash");
        tracker.recordUsage(0, "gemini-2.5-flash");
        tracker.recordUsage(0, "gemini-2.5-pro");

        const modelList = [
            { dailyLimit: 1000, name: "models/gemini-2.5-flash" },
            { dailyLimit: 50, name: "models/gemini-2.5-pro" },
            { dailyLimit: 200, name: "models/gemini-2.5-flash-lite" },
        ];

        const details = tracker.getAccountUsageDetails(0, modelList);

        expect(details.total).toBe(3);
        expect(details.byModel["gemini-2.5-flash"]).toEqual({ limit: 1000, usage: 2 });
        expect(details.byModel["gemini-2.5-pro"]).toEqual({ limit: 50, usage: 1 });
        expect(details.byModel["gemini-2.5-flash-lite"]).toBeUndefined();
    });
});
