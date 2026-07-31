/* eslint-env jest */
const express = require("express");
const { initConcurrentMode } = require("../../src/concurrent");

describe("concurrent module facade (index.js)", () => {
    test("initConcurrentMode initializes scheduler and request handler", () => {
        const app = express();
        const mockAuthSource = { getAllAccounts: jest.fn().mockReturnValue([]) };
        const mockConnectionRegistry = { hasConnection: jest.fn() };
        const mockLogger = { info: jest.fn(), debug: jest.fn(), error: jest.fn() };

        const result = initConcurrentMode(app, {
            authSource: mockAuthSource,
            connectionRegistry: mockConnectionRegistry,
            formatConverter: {},
            logger: mockLogger,
            modelList: [],
        });

        expect(result).toHaveProperty("scheduler");
        expect(result).toHaveProperty("concurrentRequestHandler");
    });
});
