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

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledWith("gemini-2.5-flash", { strategy: null });
        expect(mockScheduler.recordUsage).toHaveBeenCalledWith(0, "gemini-2.5-flash");
    });

    test("handleGeminiRequest parses model suffixes and injects thinkingLevel into req.body and cleans path", async () => {
        mockConnectionRegistry.sendRequest = jest.fn((authIndex, payload, cb) => {
            cb({ candidates: [] }, true, false, { status: 200 });
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [{ parts: [{ functionCall: { name: "test" }, text: "hi" }] }] },
            method: "POST",
            path: "/v1beta/models/gemini-3-flash-preview-minimal:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledWith("gemini-3-flash-preview", { strategy: null });
        expect(mockConnectionRegistry.sendRequest).toHaveBeenCalled();
        const sendPayload = mockConnectionRegistry.sendRequest.mock.calls[0][1];

        // Assert that the cleanPath is stripped of thinkingLevel suffix
        expect(sendPayload.path).toBe("/v1beta/models/gemini-3-flash-preview:generateContent");

        const parsedBody = JSON.parse(sendPayload.body);
        expect(parsedBody.generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");

        // Assert that the thoughtSignature was properly ensured on functionCall
        expect(parsedBody.contents[0].parts[0].thoughtSignature).toBeDefined();

        // Assert default safety settings are set
        expect(parsedBody.safetySettings).toBeDefined();
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

    test("handleGeminiRequest does not retry across accounts on error and returns error directly", async () => {
        mockConnectionRegistry.sendRequest = jest.fn((authIndex, payload, cb) => {
            cb("Backend error", true, true, { status: 500 });
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [{ parts: [{ text: "hi" }] }] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledTimes(1);
        expect(mockConnectionRegistry.sendRequest).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: 500,
                message: "Backend error",
                status: "INTERNAL",
            },
        });
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

    test("handleGeminiRequest triggers checkAndRetireAccount after request completes", async () => {
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

        mockScheduler.checkAndRetireAccount = jest.fn().mockResolvedValue(false);

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

        expect(mockScheduler.checkAndRetireAccount).toHaveBeenCalledWith(0);
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

    test("handleGeminiRequest rewrites embedContent to batchEmbedContents and converts back in callback", async () => {
        const rawBatchEmbedResponse = {
            embeddings: [
                {
                    values: [0.1, 0.2, 0.3],
                },
            ],
        };

        mockConnectionRegistry.sendRequest = jest.fn((authIndex, payload, cb) => {
            cb(rawBatchEmbedResponse, true, false, { status: 200 });
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { content: { parts: [{ text: "embed me" }] } },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:embedContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledWith("gemini-2.5-flash", { strategy: null });
        expect(mockConnectionRegistry.sendRequest).toHaveBeenCalled();
        const sendPayload = mockConnectionRegistry.sendRequest.mock.calls[0][1];

        expect(sendPayload.path).toBe("/v1beta/models/gemini-2.5-flash:batchEmbedContents");
        expect(sendPayload.responseTransform).toBe("batchEmbedToEmbedContent");

        const parsedBody = JSON.parse(sendPayload.body);
        expect(parsedBody.requests[0].model).toBe("models/gemini-2.5-flash");

        expect(res.json).toHaveBeenCalledWith({
            values: [0.1, 0.2, 0.3],
        });
    });

    test("handleGeminiRequest enforces forceThinking when configured", async () => {
        mockConnectionRegistry.sendRequest = jest.fn((authIndex, payload, cb) => {
            cb({ candidates: [] }, true, false, { status: 200 });
        });

        const localScheduler = {
            ...mockScheduler,
            config: { forceThinking: true },
        };

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, localScheduler, mockLogger);

        const req = {
            body: { contents: [{ parts: [{ text: "hi" }] }] },
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

        const sendPayload = mockConnectionRegistry.sendRequest.mock.calls[0][1];
        const parsedBody = JSON.parse(sendPayload.body);
        expect(parsedBody.generationConfig.thinkingConfig.includeThoughts).toBe(true);
    });

    test("handleGeminiRequest forces built-in tools when configured or suffix specified", async () => {
        mockConnectionRegistry.sendRequest = jest.fn((authIndex, payload, cb) => {
            cb({ candidates: [] }, true, false, { status: 200 });
        });

        const localScheduler = {
            ...mockScheduler,
            config: { forceWebSearch: true },
        };

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, localScheduler, mockLogger);

        const req = {
            body: { contents: [{ parts: [{ text: "hi" }] }] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash-code:generateContent", // Suffix -code and forceWebSearch config
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        const sendPayload = mockConnectionRegistry.sendRequest.mock.calls[0][1];
        const parsedBody = JSON.parse(sendPayload.body);

        // Should have both googleSearch and codeExecution tools
        const tools = parsedBody.tools;
        expect(tools).toContainEqual({ googleSearch: {} });
        expect(tools).toContainEqual({ codeExecution: {} });
    });

    test("handleGeminiRequest uses acquireNextAuthIndex with AbortSignal", async () => {
        const mockSchedulerLocal = {
            acquireNextAuthIndex: jest.fn().mockResolvedValue(0),
            checkAndRetireAccount: jest.fn().mockResolvedValue(false),
            config: { concurrentWaitTimeoutMs: 60000 },
            releaseInFlight: jest.fn(),
        };
        const mockRegistryLocal = {
            removeMessageQueue: jest.fn(),
            sendRequest: jest.fn((authIdx, payload, cb) => cb(null, true, false, { status: 200 })),
        };

        const handler = new ConcurrentRequestHandler(mockRegistryLocal, mockSchedulerLocal, mockLogger, []);

        const req = {
            body: { contents: [] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };
        const res = {
            end: jest.fn(),
            json: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
            status: jest.fn().mockReturnThis(),
            write: jest.fn(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(mockSchedulerLocal.acquireNextAuthIndex).toHaveBeenCalledWith(
            "gemini-2.5-flash",
            expect.objectContaining({
                signal: expect.any(Object),
                timeoutMs: 60000,
            })
        );
    });

    test("handleGeminiRequest extracts x-scheduling-strategy and x-strategy header and passes to acquireNextAuthIndex", async () => {
        const mockSchedulerLocal = {
            acquireNextAuthIndex: jest.fn().mockResolvedValue(0),
            checkAndRetireAccount: jest.fn().mockResolvedValue(false),
            config: { concurrentWaitTimeoutMs: 60000 },
            releaseInFlight: jest.fn(),
        };
        const mockRegistryLocal = {
            removeMessageQueue: jest.fn(),
            sendRequest: jest.fn((authIdx, payload, cb) => cb(null, true, false, { status: 200 })),
        };

        const handler = new ConcurrentRequestHandler(mockRegistryLocal, mockSchedulerLocal, mockLogger, []);

        // 1. With x-scheduling-strategy header
        const req1 = {
            body: { contents: [] },
            headers: { "x-scheduling-strategy": "round-robin" },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };
        const res1 = {
            end: jest.fn(),
            json: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
            status: jest.fn().mockReturnThis(),
            write: jest.fn(),
        };

        await handler.handleGeminiRequest(req1, res1);

        expect(mockSchedulerLocal.acquireNextAuthIndex).toHaveBeenCalledWith(
            "gemini-2.5-flash",
            expect.objectContaining({
                strategy: "round-robin",
            })
        );

        // 2. With x-strategy header
        const req2 = {
            body: { contents: [] },
            headers: { "x-strategy": "weighted" },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };
        const res2 = {
            end: jest.fn(),
            json: jest.fn(),
            on: jest.fn(),
            removeListener: jest.fn(),
            status: jest.fn().mockReturnThis(),
            write: jest.fn(),
        };

        await handler.handleGeminiRequest(req2, res2);

        expect(mockSchedulerLocal.acquireNextAuthIndex).toHaveBeenCalledWith(
            "gemini-2.5-flash",
            expect.objectContaining({
                strategy: "weighted",
            })
        );
    });
});
