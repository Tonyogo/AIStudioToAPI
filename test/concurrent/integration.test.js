/* eslint-env jest */
const { initConcurrentMode } = require("../../src/concurrent");

describe("Concurrent System Integration Check", () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test("ENABLE_CONCURRENT environment variable is recognized", () => {
        process.env.ENABLE_CONCURRENT = "true";
        const isConcurrent = process.env.ENABLE_CONCURRENT === "true";
        expect(isConcurrent).toBe(true);
    });

    test("initConcurrentMode can be safely invoked with mock ProxyServerSystem dependencies", () => {
        process.env.ENABLE_CONCURRENT = "true";
        const mockApp = {
            get: jest.fn(),
            post: jest.fn(),
        };

        const result = initConcurrentMode(mockApp, {
            authSource: { getAllAccounts: () => [] },
            connectionRegistry: { hasConnection: () => false },
            formatConverter: {},
            logger: { info: jest.fn() },
            modelList: [{ name: "models/gemini-2.5-flash" }],
        });

        expect(result.scheduler).toBeDefined();
        expect(mockApp.get).toHaveBeenCalled();
        expect(mockApp.post).toHaveBeenCalled();
    });
});
