/* eslint-env jest */
const express = require("express");
const ConcurrentRequestHandler = require("../../src/concurrent/ConcurrentRequestHandler");

describe("ConcurrentRequestHandler", () => {
    let app;
    let mockConnectionRegistry;
    let mockScheduler;
    let mockFormatConverter;
    let mockLogger;

    beforeEach(() => {
        app = express();
        app.use(express.json());

        mockConnectionRegistry = {
            hasConnection: jest.fn().mockReturnValue(true),
            sendRequest: jest.fn(),
        };

        mockScheduler = {
            getNextAuthIndex: jest.fn().mockReturnValue(0),
        };

        mockFormatConverter = {};

        mockLogger = {
            debug: jest.fn(),
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
        };
    });

    test("registers routes on express app", () => {
        const handler = new ConcurrentRequestHandler(
            mockConnectionRegistry,
            mockScheduler,
            mockFormatConverter,
            mockLogger,
            [{ name: "models/gemini-2.5-flash" }]
        );

        handler.registerRoutes(app);

        // Verify route stack contains expected paths
        const routes = app._router.stack
            .filter(r => r.route)
            .map(r => ({ path: r.route.path, methods: r.route.methods }));

        expect(routes.some(r => r.path.includes("/v1beta/models"))).toBe(true);
    });

    test("handleGeminiRequest handles 503 when scheduler has no active connections", async () => {
        mockScheduler.getNextAuthIndex.mockImplementation(() => {
            const err = new Error("No active context connection available");
            err.statusCode = 503;
            throw err;
        });

        const handler = new ConcurrentRequestHandler(
            mockConnectionRegistry,
            mockScheduler,
            mockFormatConverter,
            mockLogger
        );

        const req = {
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            params: { 0: "gemini-2.5-flash:generateContent" },
            query: {},
            body: { contents: [] },
        };

        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: expect.stringContaining("No active context connection available"),
                }),
            })
        );
    });
});
