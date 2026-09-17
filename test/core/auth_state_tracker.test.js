/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const AuthStateTracker = require("../../src/core/AuthStateTracker");

describe("AuthStateTracker", () => {
    const testDataDir = path.join(process.cwd(), "tmp_test_auth_state_data");
    const testStateFile = path.join(testDataDir, "auth-state.json");
    let tracker = null;

    beforeEach(() => {
        if (!fs.existsSync(testDataDir)) {
            fs.mkdirSync(testDataDir, { recursive: true });
        }
        if (fs.existsSync(testStateFile)) {
            fs.unlinkSync(testStateFile);
        }
        tracker = new AuthStateTracker(null, testStateFile);
    });

    afterEach(() => {
        if (fs.existsSync(testStateFile)) {
            fs.unlinkSync(testStateFile);
        }
        if (fs.existsSync(testDataDir)) {
            fs.rmdirSync(testDataDir);
        }
    });

    test("returns null when state file does not exist", () => {
        expect(tracker.getLastAuthIndex()).toBeNull();
    });

    test("saves and loads lastActiveAuthIndex accurately", () => {
        const saved = tracker.saveLastAuthIndex(3);
        expect(saved).toBe(true);
        expect(tracker.getLastAuthIndex()).toBe(3);

        const content = JSON.parse(fs.readFileSync(testStateFile, "utf-8"));
        expect(content.lastActiveAuthIndex).toBe(3);
        expect(typeof content.updatedAt).toBe("string");
    });

    test("handles corrupted state file gracefully", () => {
        fs.writeFileSync(testStateFile, "invalid-json-content{");
        expect(tracker.getLastAuthIndex()).toBeNull();
    });

    test("rejects invalid auth indices when saving", () => {
        expect(tracker.saveLastAuthIndex(-1)).toBe(false);
        expect(tracker.saveLastAuthIndex(1.5)).toBe(false);
        expect(tracker.saveLastAuthIndex("2")).toBe(false);
        expect(tracker.saveLastAuthIndex(null)).toBe(false);
    });

    describe("resolveStartupIndex", () => {
        const rotationIndices = [0, 2, 4];
        const availableIndices = [0, 1, 2, 4];
        const canonicalIndexGetter = idx => (idx === 1 ? 2 : idx);

        test("uses persisted index directly when present in rotationIndices", () => {
            tracker.saveLastAuthIndex(2);
            const result = tracker.resolveStartupIndex({
                availableIndices,
                canonicalIndexGetter,
                envInitialIndex: 0,
                rotationIndices,
            });
            expect(result.chosenIndex).toBe(2);
            expect(result.startupOrder).toEqual([2, 0, 4]);
            expect(result.source).toBe("persisted");
        });

        test("resolves duplicate account to canonical index", () => {
            tracker.saveLastAuthIndex(1); // 1 maps to 2
            const result = tracker.resolveStartupIndex({
                availableIndices,
                canonicalIndexGetter,
                envInitialIndex: 0,
                rotationIndices,
            });
            expect(result.chosenIndex).toBe(2);
            expect(result.startupOrder).toEqual([2, 0, 4]);
            expect(result.source).toBe("persisted");
        });

        test("advances to next available index when persisted index was removed (fallback)", () => {
            tracker.saveLastAuthIndex(3); // 3 not in [0, 2, 4], next is 4
            const result = tracker.resolveStartupIndex({
                availableIndices,
                canonicalIndexGetter,
                envInitialIndex: 0,
                rotationIndices,
            });
            expect(result.chosenIndex).toBe(4);
            expect(result.startupOrder).toEqual([4, 0, 2]);
            expect(result.source).toBe("persisted_fallback");
        });

        test("wraps around to first index when persisted index exceeds max index", () => {
            tracker.saveLastAuthIndex(5); // 5 not in [0, 2, 4], exceeds max -> wrap around to 0
            const result = tracker.resolveStartupIndex({
                availableIndices,
                canonicalIndexGetter,
                envInitialIndex: 2,
                rotationIndices,
            });
            expect(result.chosenIndex).toBe(0);
            expect(result.startupOrder).toEqual([0, 2, 4]);
            expect(result.source).toBe("persisted_fallback");
        });

        test("falls back to envInitialIndex when no persisted index exists", () => {
            const result = tracker.resolveStartupIndex({
                availableIndices,
                canonicalIndexGetter,
                envInitialIndex: 4,
                rotationIndices,
            });
            expect(result.chosenIndex).toBe(4);
            expect(result.startupOrder).toEqual([4, 0, 2]);
            expect(result.source).toBe("env");
        });

        test("falls back to first index when no persisted index and invalid envInitialIndex", () => {
            const result = tracker.resolveStartupIndex({
                availableIndices,
                canonicalIndexGetter,
                envInitialIndex: 99,
                rotationIndices,
            });
            expect(result.chosenIndex).toBe(0);
            expect(result.startupOrder).toEqual([0, 2, 4]);
            expect(result.source).toBe("default");
        });

        test("handles empty pools gracefully", () => {
            const result = tracker.resolveStartupIndex({
                availableIndices: [],
                rotationIndices: [],
            });
            expect(result.chosenIndex).toBeNull();
            expect(result.startupOrder).toEqual([]);
            expect(result.source).toBe("default");
        });
    });
});
