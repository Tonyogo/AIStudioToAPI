/* eslint-env jest */
const express = require("express");
const ProxyServerSystem = require("../../src/core/ProxyServerSystem");

describe("CORS Expose Headers", () => {
    let system;
    let app;

    beforeEach(() => {
        system = new ProxyServerSystem();
        app = system._createExpressApp();
    });

    test("includes x-account-name in Access-Control-Expose-Headers", async () => {
        const req = {
            method: "GET",
            path: "/health",
            headers: {},
        };
        const headers = {};
        const res = {
            header: (name, val) => {
                headers[name] = val;
            },
            sendStatus: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            use: jest.fn(),
        };

        // Trigger CORS middleware manually from app
        const corsMiddleware = app._router.stack.find(
            layer => layer.name === "<anonymous>" && layer.handle.toString().includes("Access-Control-Allow-Origin")
        );
        expect(corsMiddleware).toBeDefined();

        let nextCalled = false;
        corsMiddleware.handle(req, res, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(headers["Access-Control-Expose-Headers"]).toContain("x-account-name");
    });
});
