/* eslint-env jest */
const express = require("express");
const ConcurrentRequestHandler = require("../../src/concurrent/ConcurrentRequestHandler");

describe("ConcurrentRequestHandler", () => {
    let app;
    let mockConnectionRegistry;
    let mockScheduler;
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

        mockLogger = {
            debug: jest.fn(),
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
        };
    });

    test("registers routes on express app", () => {
        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger, [
            { name: "models/gemini-2.5-flash" },
        ]);

        handler.registerRoutes(app);

        // Verify route stack contains expected paths
        const routes = app._router.stack
            .filter(r => r.route)
            .map(r => ({ methods: r.route.methods, path: r.route.path }));

        expect(routes.some(r => r.path.includes("/v1beta/models"))).toBe(true);
    });

    test("handleGeminiRequest handles 503 when scheduler has no active connections", async () => {
        mockScheduler.getNextAuthIndex.mockImplementation(() => {
            const err = new Error("No active context connection available");
            err.statusCode = 503;
            throw err;
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [] },
            method: "POST",
            params: { 0: "gemini-2.5-flash:generateContent" },
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };

        const res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
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

    describe("_sendRequestImpl integration", () => {
        test("binds _sendRequestImpl when connectionRegistry does not have sendRequest", () => {
            const minimalRegistry = {
                createMessageQueue: jest.fn(),
                getConnectionByAuth: jest.fn(),
                removeMessageQueue: jest.fn(),
            };
            new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);
            expect(minimalRegistry.sendRequest).toBeDefined();
            expect(typeof minimalRegistry.sendRequest).toBe("function");
        });

        test("_sendRequestImpl processes non-streaming request successfully", async () => {
            const mockWS = {
                send: jest.fn(),
            };
            const mockQueue = {
                dequeue: jest
                    .fn()
                    .mockResolvedValueOnce({ data: '{"response":', event_type: "chunk" })
                    .mockResolvedValueOnce({ data: '"success"}', event_type: "chunk" })
                    .mockResolvedValueOnce({ type: "STREAM_END" }),
            };
            const minimalRegistry = {
                createMessageQueue: jest.fn().mockReturnValue(mockQueue),
                getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
                removeMessageQueue: jest.fn(),
            };

            new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

            const callback = jest.fn();
            await minimalRegistry.sendRequest(0, { body: {}, isStream: false, path: "/foo" }, callback);

            expect(mockWS.send).toHaveBeenCalled();
            expect(minimalRegistry.createMessageQueue).toHaveBeenCalled();
            expect(minimalRegistry.removeMessageQueue).toHaveBeenCalled();
            expect(callback).toHaveBeenCalledWith({ response: "success" }, true, false, expect.any(Object));
        });

        test("_sendRequestImpl processes streaming request successfully", async () => {
            const mockWS = {
                send: jest.fn(),
            };
            const mockQueue = {
                dequeue: jest
                    .fn()
                    .mockResolvedValueOnce({ data: "hello", event_type: "chunk" })
                    .mockResolvedValueOnce({ data: " world", event_type: "chunk" })
                    .mockResolvedValueOnce({ type: "STREAM_END" }),
            };
            const minimalRegistry = {
                createMessageQueue: jest.fn().mockReturnValue(mockQueue),
                getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
                removeMessageQueue: jest.fn(),
            };

            new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

            const callback = jest.fn();
            await minimalRegistry.sendRequest(0, { body: {}, isStream: true, path: "/foo" }, callback);

            expect(callback).toHaveBeenNthCalledWith(1, "hello", false, false, expect.any(Object));
            expect(callback).toHaveBeenNthCalledWith(2, " world", false, false, expect.any(Object));
            expect(callback).toHaveBeenNthCalledWith(3, null, true, false, expect.any(Object));
        });

        test("_sendRequestImpl captures response status and headers from response_headers event", async () => {
            const mockWS = { send: jest.fn() };
            const mockQueue = {
                dequeue: jest
                    .fn()
                    .mockResolvedValueOnce({ event_type: "response_headers", headers: { "x-custom-header": "value" }, status: 201 })
                    .mockResolvedValueOnce({ data: '{"ok":true}', event_type: "chunk" })
                    .mockResolvedValueOnce({ type: "STREAM_END" }),
            };
            const minimalRegistry = {
                createMessageQueue: jest.fn().mockReturnValue(mockQueue),
                getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
                removeMessageQueue: jest.fn(),
            };

            new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

            const callback = jest.fn();
            await minimalRegistry.sendRequest(0, { body: {}, isStream: false, path: "/foo" }, callback);

            expect(callback).toHaveBeenCalledWith({ ok: true }, true, false, expect.objectContaining({
                headers: { "x-custom-header": "value" },
                status: 201,
            }));
        });
    });

    test("handleGeminiRequest returns correct HTTP status and Gemini error payload for 429 rate limit", async () => {
        const mockWS = { send: jest.fn() };
        const mockQueue = {
            dequeue: jest
                .fn()
                .mockResolvedValueOnce({ event_type: "error", message: "Quota exceeded", status: 429 }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
            sendRequest: null,
        };

        const handler = new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: 429,
                message: "Quota exceeded",
                status: "RESOURCE_EXHAUSTED",
            },
        });
    });
});
