/* eslint-env jest */
const express = require("express");
const { initConcurrentMode } = require("../../src/concurrent");

describe("concurrent module facade (index.js)", () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
        process.env.ENABLE_CONCURRENT = "true";
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test("initConcurrentMode initializes scheduler and request handler", () => {
        const app = express();
        const mockAuthSource = { getAllAccounts: jest.fn().mockReturnValue([]) };
        const mockConnectionRegistry = { hasConnection: jest.fn() };
        const mockLogger = { debug: jest.fn(), error: jest.fn(), info: jest.fn() };

        const mockSystem = {
            authSource: mockAuthSource,
            config: { modelList: [] },
            connectionRegistry: mockConnectionRegistry,
            formatConverter: {},
            logger: mockLogger,
        };

        const result = initConcurrentMode(app, mockSystem);

        expect(result).toHaveProperty("scheduler");
        expect(result).toHaveProperty("concurrentRequestHandler");
    });
});
