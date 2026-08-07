/* eslint-env jest */
const { selectCandidate, STRATEGIES } = require("../../src/concurrent/strategies");
const weighted = require("../../src/concurrent/strategies/weighted");
const roundRobin = require("../../src/concurrent/strategies/round-robin");
const leastUsed = require("../../src/concurrent/strategies/least-used");

describe("Scheduling Strategies", () => {
    const candidateA = { idx: 0, inFlight: 0, order: 0, usage: 100 };
    const candidateB = { idx: 1, inFlight: 0, order: 1, usage: 900 };
    const candidateC = { idx: 2, inFlight: 0, order: 2, usage: 500 };

    describe("weighted strategy", () => {
        test("returns null for empty candidates", () => {
            expect(weighted([], { limit: 1000 })).toBeNull();
        });

        test("returns the single candidate if candidates length is 1", () => {
            expect(weighted([candidateA], { limit: 1000 })).toBe(candidateA);
        });

        test("selects candidate proportional to remaining capacity weight", () => {
            jest.spyOn(Math, "random").mockReturnValue(0.1);
            expect(weighted([candidateA, candidateB], { limit: 1000 })).toBe(candidateA);

            Math.random.mockReturnValue(0.95);
            expect(weighted([candidateA, candidateB], { limit: 1000 })).toBe(candidateB);

            Math.random.mockRestore();
        });
    });

    describe("round-robin strategy", () => {
        test("returns candidate with smallest order index", () => {
            const unordered = [candidateC, candidateA, candidateB];
            expect(roundRobin(unordered, {})).toBe(candidateA);
        });
    });

    describe("least-used strategy", () => {
        test("returns candidate with lowest usage count", () => {
            const unordered = [candidateB, candidateC, candidateA];
            expect(leastUsed(unordered, {})).toBe(candidateA);
        });

        test("falls back to order ascending when usage is equal", () => {
            const c1 = { idx: 0, inFlight: 0, order: 0, usage: 100 };
            const c2 = { idx: 1, inFlight: 0, order: 1, usage: 100 };
            expect(leastUsed([c2, c1], {})).toBe(c1);
        });
    });

    describe("strategy factory (index.js)", () => {
        test("exports STRATEGIES object", () => {
            expect(STRATEGIES).toHaveProperty("weighted");
            expect(STRATEGIES).toHaveProperty("round-robin");
            expect(STRATEGIES).toHaveProperty("least-used");
        });

        test("selectCandidate dispatches to correct strategy function", () => {
            const unordered = [candidateB, candidateC, candidateA];
            expect(selectCandidate("round-robin", unordered)).toBe(candidateA);
            expect(selectCandidate("least-used", unordered)).toBe(candidateA);
        });

        test("falls back to round-robin strategy for unknown strategy name", () => {
            expect(selectCandidate("unknown_strategy", [candidateB, candidateC, candidateA])).toBe(candidateA);
        });
    });
});
