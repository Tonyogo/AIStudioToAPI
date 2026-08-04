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

    test("handleGeminiRequest returns 429 RESOURCE_EXHAUSTED when scheduler throws 429 quota error", async () => {
        mockScheduler.getNextAuthIndex.mockImplementation(async () => {
            const err = new Error('All accounts reached daily limit of 50 requests for model "gemini-2.5-pro"');
            err.statusCode = 429;
            err.statusText = "RESOURCE_EXHAUSTED";
            throw err;
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-pro:generateContent",
            query: {},
        };

        const res = {
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: 429,
                message: 'All accounts reached daily limit of 50 requests for model "gemini-2.5-pro"',
                status: "RESOURCE_EXHAUSTED",
            },
        });
    });

    test("handleGeminiRequest acquires and releases in-flight request count", async () => {
        const mockWS = { send: jest.fn() };
        const mockQueue = {
            dequeue: jest
                .fn()
                .mockResolvedValueOnce({ data: '{"ok":true}', event_type: "chunk" })
                .mockResolvedValueOnce({ type: "STREAM_END" }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
        };

        mockScheduler.getNextAuthIndex = jest.fn().mockResolvedValue(0);
        mockScheduler.acquireInFlight = jest.fn();
        mockScheduler.releaseInFlight = jest.fn();

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

        expect(mockScheduler.acquireInFlight).toHaveBeenCalledWith(0);
        expect(mockScheduler.releaseInFlight).toHaveBeenCalledWith(0);
    });

    test("handleGeminiRequest passes clean model name to scheduler and records usage", async () => {
        const mockWS = { send: jest.fn() };
        const mockQueue = {
            dequeue: jest
                .fn()
                .mockResolvedValueOnce({ data: '{"ok":true}', event_type: "chunk" })
                .mockResolvedValueOnce({ type: "STREAM_END" }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
        };

        mockScheduler.getNextAuthIndex = jest.fn().mockResolvedValue(0);
        mockScheduler.recordUsage = jest.fn();

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

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledWith("gemini-2.5-flash");
        expect(mockScheduler.recordUsage).toHaveBeenCalledWith(0, "gemini-2.5-flash");
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
                    .mockResolvedValueOnce({
                        event_type: "response_headers",
                        headers: { "x-custom-header": "value" },
                        status: 201,
                    })
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

            expect(callback).toHaveBeenCalledWith(
                { ok: true },
                true,
                false,
                expect.objectContaining({
                    headers: { "x-custom-header": "value" },
                    status: 201,
                })
            );
        });
    });

    test("handleGeminiRequest returns correct HTTP status and Gemini error payload for 429 rate limit", async () => {
        const mockWS = { send: jest.fn() };
        const mockQueue = {
            dequeue: jest.fn().mockResolvedValueOnce({ event_type: "error", message: "Quota exceeded", status: 429 }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
            sendRequest: null,
        };

        const mockSchedulerLocal = {
            acquireInFlight: jest.fn(),
            getNextAuthIndex: jest.fn().mockResolvedValue(0),
            recordFailure: jest.fn(),
            recordSuccess: jest.fn(),
            releaseInFlight: jest.fn(),
        };

        const handler = new ConcurrentRequestHandler(minimalRegistry, mockSchedulerLocal, mockLogger);

        const req = {
            body: { contents: [] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            on: jest.fn(),
            status: jest.fn().mockReturnThis(),
            writableEnded: false,
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

    test("handleGeminiRequest sends cancel_request when client disconnects early", async () => {
        const mockWS = { send: jest.fn() };
        let closeListener;
        const mockQueue = {
            dequeue: jest.fn().mockImplementation(() => {
                // Trigger client disconnect while waiting
                if (closeListener) closeListener();
                return new Promise(() => {}); // hang
            }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
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
            on: jest.fn((event, fn) => {
                if (event === "close") closeListener = fn;
            }),
            status: jest.fn().mockReturnThis(),
            writableEnded: false,
        };

        // Run handleGeminiRequest asynchronously
        handler.handleGeminiRequest(req, res);

        // Wait a tick for queue dequeue to run and trigger closeListener
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(mockWS.send).toHaveBeenCalledWith(expect.stringContaining('"event_type":"cancel_request"'));
        expect(minimalRegistry.removeMessageQueue).toHaveBeenCalledWith(expect.any(String), "client_disconnect");
    });

    test("handleGeminiRequest seamlessly retries on a different account when attempt 1 fails before headersSent", async () => {
        const mockWS1 = { send: jest.fn() };
        const mockQueue1 = {
            dequeue: jest.fn().mockResolvedValueOnce({ event_type: "error", message: "Account 0 failed", status: 500 }),
        };
        const mockWS2 = { send: jest.fn() };
        const mockQueue2 = {
            dequeue: jest
                .fn()
                .mockResolvedValueOnce({ data: '{"ok":true}', event_type: "chunk" })
                .mockResolvedValueOnce({ type: "STREAM_END" }),
        };

        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValueOnce(mockQueue1).mockReturnValueOnce(mockQueue2),
            getConnectionByAuth: jest.fn().mockReturnValueOnce(mockWS1).mockReturnValueOnce(mockWS2),
            removeMessageQueue: jest.fn(),
            sendRequest: null,
        };

        mockScheduler.getNextAuthIndex = jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
        mockScheduler.acquireInFlight = jest.fn();
        mockScheduler.releaseInFlight = jest.fn();
        mockScheduler.recordFailure = jest.fn();
        mockScheduler.recordSuccess = jest.fn();

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

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledTimes(2);
        expect(mockScheduler.recordFailure).toHaveBeenCalledWith(0, 500);
        expect(mockScheduler.recordSuccess).toHaveBeenCalledWith(1);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ ok: true });
    });

    test("handleGeminiRequest tracks request lifecycle in usageStatsService", async () => {
        const mockUsageStats = {
            finishRequest: jest.fn(),
            recordAttempt: jest.fn(),
            startRequest: jest.fn(),
            updateRequest: jest.fn(),
        };
        const mockWS = { send: jest.fn() };
        const mockQueue = {
            dequeue: jest
                .fn()
                .mockResolvedValueOnce({ data: '{"ok":true}', event_type: "chunk" })
                .mockResolvedValueOnce({ type: "STREAM_END" }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
        };

        const handler = new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger, [], mockUsageStats);

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

        expect(mockUsageStats.startRequest).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                apiFormat: "gemini",
                isStreaming: false,
                model: "gemini-2.5-flash",
                streamMode: null,
            })
        );
        expect(mockUsageStats.recordAttempt).toHaveBeenCalledWith(expect.any(String), 0, null);
        expect(mockUsageStats.finishRequest).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                finalAuthIndex: 0,
                outcome: "success",
                statusCode: 200,
            })
        );
    });

    test("handleGeminiRequest converts inline image data to Markdown in non-stream responses", async () => {
        const rawImageBody = {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                inlineData: {
                                    data: "base64data",
                                    mimeType: "image/png",
                                },
                            },
                        ],
                    },
                },
            ],
        };
        const mockWS = { send: jest.fn() };
        const mockQueue = {
            dequeue: jest
                .fn()
                .mockResolvedValueOnce({ data: JSON.stringify(rawImageBody), event_type: "chunk" })
                .mockResolvedValueOnce({ type: "STREAM_END" }),
        };
        const minimalRegistry = {
            createMessageQueue: jest.fn().mockReturnValue(mockQueue),
            getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
            removeMessageQueue: jest.fn(),
        };

        const handler = new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash-image:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(res.json).toHaveBeenCalledWith({
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: "![Generated Image](data:image/png;base64,base64data)",
                            },
                        ],
                    },
                },
            ],
        });
    });
});
