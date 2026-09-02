/* eslint-env jest */
const express = require("express");
const http = require("http");
const StatusRoutes = require("../../src/routes/StatusRoutes");

describe("StatusRoutes - POST /api/accounts/:index/close-context", () => {
    let app;
    let server;
    let baseUrl;
    let mockServerSystem;
    let mockBrowserManager;
    let mockConnectionRegistry;
    let mockRequestHandler;
    let mockAuthSource;
    let statusRoutes;

    beforeEach(done => {
        app = express();
        app.use(express.json());

        mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            contexts: new Map([[0, { context: {} }]]),
            currentAuthIndex: 0,
            initializingContexts: new Set(),
        };

        mockConnectionRegistry = {
            closeConnectionByAuth: jest.fn(),
            closeMessageQueuesForAuth: jest.fn(),
        };

        mockRequestHandler = {
            currentAuthIndex: 0,
            isSystemBusy: false,
        };

        mockAuthSource = {
            availableIndices: [0, 1],
            initialIndices: [0, 1],
        };

        mockServerSystem = {
            authSource: mockAuthSource,
            browserManager: mockBrowserManager,
            config: {},
            connectionRegistry: mockConnectionRegistry,
            distIndexPath: "/tmp/index.html",
            logger: {
                debug: jest.fn(),
                error: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
            },
            requestHandler: mockRequestHandler,
        };

        statusRoutes = new StatusRoutes(mockServerSystem);
        const passAuth = (req, res, next) => next();
        statusRoutes.setupRoutes(app, passAuth);

        server = http.createServer(app);
        server.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            done();
        });
    });

    afterEach(done => {
        if (server) {
            server.close(done);
        } else {
            done();
        }
    });

    test("returns 400 for invalid non-integer account index", async () => {
        const res = await fetch(`${baseUrl}/api/accounts/abc/close-context`, { method: "POST" });
        const data = await res.json();
        expect(res.status).toBe(400);
        expect(data.message).toBe("errorInvalidIndex");
    });

    test("returns 404 if account index does not exist in initialIndices", async () => {
        const res = await fetch(`${baseUrl}/api/accounts/99/close-context`, { method: "POST" });
        const data = await res.json();
        expect(res.status).toBe(404);
        expect(data.message).toBe("errorAccountNotFound");
    });

    test("returns 409 if system is busy", async () => {
        mockRequestHandler.isSystemBusy = true;
        const res = await fetch(`${baseUrl}/api/accounts/0/close-context`, { method: "POST" });
        const data = await res.json();
        expect(res.status).toBe(409);
        expect(data.message).toBe("systemBusySwitchingOrRecoveringAccounts");
    });

    test("returns 200 contextAlreadyClosed if context is not loaded and not initializing", async () => {
        mockBrowserManager.contexts.clear();
        const res = await fetch(`${baseUrl}/api/accounts/1/close-context`, { method: "POST" });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.message).toBe("contextAlreadyClosed");
        expect(data.index).toBe(1);
        expect(mockBrowserManager.closeContext).not.toHaveBeenCalled();
    });

    test("closes context for current active account and resets currentAuthIndex", async () => {
        const res = await fetch(`${baseUrl}/api/accounts/0/close-context`, { method: "POST" });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.message).toBe("closeContextSuccess");
        expect(data.index).toBe(0);

        expect(mockConnectionRegistry.closeMessageQueuesForAuth).toHaveBeenCalledWith(0, "manual_context_closed");
        expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(0);
        expect(mockConnectionRegistry.closeConnectionByAuth).toHaveBeenCalledWith(0);
        expect(mockRequestHandler.currentAuthIndex).toBe(-1);
    });

    test("closes context for non-current preloaded account without resetting currentAuthIndex", async () => {
        mockBrowserManager.contexts.set(1, { context: {} });
        mockRequestHandler.currentAuthIndex = 0;

        const res = await fetch(`${baseUrl}/api/accounts/1/close-context`, { method: "POST" });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.message).toBe("closeContextSuccess");
        expect(data.index).toBe(1);

        expect(mockConnectionRegistry.closeMessageQueuesForAuth).toHaveBeenCalledWith(1, "manual_context_closed");
        expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(1);
        expect(mockConnectionRegistry.closeConnectionByAuth).toHaveBeenCalledWith(1);
        expect(mockRequestHandler.currentAuthIndex).toBe(0);
    });
});
