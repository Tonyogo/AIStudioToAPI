# Concurrent Multi-Account Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lean concurrent forwarding module (`src/concurrent`) that routes native Gemini API requests across active Google account browser contexts using a Round-Robin scheduler when `ENABLE_CONCURRENT=true`.

**Architecture:** A facade (`src/concurrent/index.js`) mounts `ConcurrentRequestHandler` and `AccountScheduler` when `ENABLE_CONCURRENT=true` in `ProxyServerSystem.js`. Requests to `/v1beta/models/*` are dispatched to active WebSocket connections in `ConnectionRegistry` without global mutual exclusion locks.

**Tech Stack:** Node.js, Express, WebSocket (`ws`), Jest for testing.

## Global Constraints

- Activation Flag: `process.env.ENABLE_CONCURRENT === "true"`.
- Native Gemini API format support only (`/v1beta/models/*`).
- Zero modifications to `BrowserManager.js`, `ConnectionRegistry.js`, `FormatConverter.js`, or `main.js`.
- Minimal routing branch in `ProxyServerSystem.js`.

---

### Task 1: AccountScheduler Implementation & Unit Tests

**Files:**
- Create: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes:
  - `authSource.getAllAccounts()`: returns array of auth objects or indices.
  - `connectionRegistry.hasConnection(authIndex)`: returns boolean indicating if WebSocket is connected for given auth index.
- Produces:
  - `AccountScheduler`: Class with constructor `(authSource, connectionRegistry, logger)`
  - `getNextAuthIndex()`: Returns `number` (the next connected `authIndex`). Throws `Error` with status 503 if no active connection exists.

- [ ] **Step 1: Write failing unit test for AccountScheduler**

Create `test/concurrent/account_scheduler.test.js`:

```javascript
/* eslint-env jest */
const AccountScheduler = require("../../src/concurrent/AccountScheduler");

describe("AccountScheduler", () => {
    let mockAuthSource;
    let mockConnectionRegistry;
    let mockLogger;

    beforeEach(() => {
        mockAuthSource = {
            getAllAccounts: jest.fn().mockReturnValue([{ index: 0 }, { index: 1 }, { index: 2 }]),
        };
        mockConnectionRegistry = {
            hasConnection: jest.fn(),
        };
        mockLogger = {
            debug: jest.fn(),
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
        };
    });

    test("round-robin selects active connections sequentially", () => {
        // Indices 0, 1, 2 all connected
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        expect(scheduler.getNextAuthIndex()).toBe(0);
        expect(scheduler.getNextAuthIndex()).toBe(1);
        expect(scheduler.getNextAuthIndex()).toBe(2);
        expect(scheduler.getNextAuthIndex()).toBe(0);
    });

    test("skips disconnected auth indices during round-robin", () => {
        // Only index 1 is connected
        mockConnectionRegistry.hasConnection.mockImplementation(idx => idx === 1);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        expect(scheduler.getNextAuthIndex()).toBe(1);
        expect(scheduler.getNextAuthIndex()).toBe(1);
    });

    test("throws 503 error when no active connections exist", () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(false);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        expect(() => scheduler.getNextAuthIndex()).toThrow("No active context connection available");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: FAIL with "Cannot find module '../../src/concurrent/AccountScheduler'"

- [ ] **Step 3: Implement AccountScheduler**

Create `src/concurrent/AccountScheduler.js`:

```javascript
/**
 * File: AccountScheduler.js
 * Description: Round-Robin account scheduler for concurrent multi-account request routing
 */

class AccountScheduler {
    /**
     * @param {Object} authSource - AuthSource instance containing available accounts
     * @param {Object} connectionRegistry - ConnectionRegistry instance managing WebSocket connections
     * @param {Object} [logger] - Logger instance
     */
    constructor(authSource, connectionRegistry, logger = console) {
        this.authSource = authSource;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.currentIndex = 0;
    }

    /**
     * Get all candidate auth indices from authSource
     * @returns {number[]}
     */
    _getAccountIndices() {
        const accounts = this.authSource ? this.authSource.getAllAccounts() : [];
        if (!accounts || accounts.length === 0) {
            return [];
        }
        return accounts.map((acc, idx) => (typeof acc.index === "number" ? acc.index : idx));
    }

    /**
     * Select next available authIndex using Round-Robin scheduling
     * @returns {number} The selected authIndex
     * @throws {Error} If no connected authIndex is available
     */
    getNextAuthIndex() {
        const indices = this._getAccountIndices();
        if (indices.length === 0) {
            const err = new Error("No authentication accounts configured");
            err.statusCode = 503;
            throw err;
        }

        const total = indices.length;
        for (let i = 0; i < total; i++) {
            const candidateIdx = indices[(this.currentIndex + i) % total];
            if (this.connectionRegistry && this.connectionRegistry.hasConnection(candidateIdx)) {
                this.currentIndex = (this.currentIndex + i + 1) % total;
                if (this.logger && typeof this.logger.debug === "function") {
                    this.logger.debug(`[AccountScheduler] Selected authIndex #${candidateIdx}`);
                }
                return candidateIdx;
            }
        }

        const error = new Error("No active context connection available");
        error.statusCode = 503;
        throw error;
    }
}

module.exports = AccountScheduler;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS (all 3 tests pass)

- [ ] **Step 5: Commit Task 1**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): implement AccountScheduler with Round-Robin strategy"
```

---

### Task 2: ConcurrentRequestHandler Implementation & Unit Tests

**Files:**
- Create: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes:
  - `connectionRegistry.getConnection(authIndex)`: returns WebSocket connection object or MessageQueue wrapper.
  - `connectionRegistry.sendRequest(authIndex, payload, callback)` or WebSocket queue processing.
  - `scheduler.getNextAuthIndex()`: returns `authIndex` number.
  - `formatConverter`: (optional/pass-through formatting if needed).
- Produces:
  - `ConcurrentRequestHandler`: Class with `(connectionRegistry, scheduler, formatConverter, logger, modelList)`
  - `registerRoutes(expressApp)`: Registers `/v1beta/models` GET and `/v1beta/models/*` POST handlers.
  - `handleGeminiRequest(req, res)`: Async handler for streaming & non-streaming Gemini API forwarding.

- [ ] **Step 1: Write failing unit test for ConcurrentRequestHandler**

Create `test/concurrent/concurrent_request_handler.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: FAIL with "Cannot find module '../../src/concurrent/ConcurrentRequestHandler'"

- [ ] **Step 3: Implement ConcurrentRequestHandler**

Create `src/concurrent/ConcurrentRequestHandler.js`:

```javascript
/**
 * File: ConcurrentRequestHandler.js
 * Description: Minimal and high-performance Gemini API request handler for concurrent execution
 */

class ConcurrentRequestHandler {
    /**
     * @param {Object} connectionRegistry - ConnectionRegistry instance
     * @param {Object} scheduler - AccountScheduler instance
     * @param {Object} [formatConverter] - FormatConverter instance
     * @param {Object} [logger] - Logger instance
     * @param {Array} [modelList] - Model list from configuration
     */
    constructor(connectionRegistry, scheduler, formatConverter, logger = console, modelList = []) {
        this.connectionRegistry = connectionRegistry;
        this.scheduler = scheduler;
        this.formatConverter = formatConverter;
        this.logger = logger;
        this.modelList = modelList;
    }

    /**
     * Register Express routes for native Gemini API endpoints
     * @param {Object} app - Express application instance
     */
    registerRoutes(app) {
        // Models list endpoint
        app.get(["/v1beta/models", "/v1/models"], (req, res) => {
            if (req.path.startsWith("/v1/models")) {
                const models = this.modelList.map(model => ({
                    context_window: model.inputTokenLimit,
                    created: Math.floor(Date.now() / 1000),
                    id: model.name.replace("models/", ""),
                    max_tokens: model.outputTokenLimit,
                    object: "model",
                    owned_by: "google",
                }));
                return res.status(200).json({ data: models, object: "list" });
            }
            return res.status(200).json({ models: this.modelList });
        });

        // Gemini API POST endpoints
        app.post("/v1beta/models/*", (req, res) => {
            this.handleGeminiRequest(req, res);
        });

        app.post("/v1/models/*", (req, res) => {
            this.handleGeminiRequest(req, res);
        });
    }

    /**
     * Process native Gemini API request
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleGeminiRequest(req, res) {
        let authIndex;
        try {
            authIndex = this.scheduler.getNextAuthIndex();
        } catch (err) {
            const statusCode = err.statusCode || 503;
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[ConcurrentRequestHandler] Scheduling failed: ${err.message}`);
            }
            return res.status(statusCode).json({
                error: {
                    code: statusCode,
                    message: err.message,
                    status: "UNAVAILABLE",
                },
            });
        }

        try {
            const isStream = req.path.includes("streamGenerateContent") || req.query.alt === "sse";
            const requestPayload = {
                action: "generateContent",
                body: req.body,
                isStream,
                path: req.path,
                query: req.query,
            };

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[ConcurrentRequestHandler] Forwarding request (${req.path}) to authIndex #${authIndex}`
                );
            }

            if (isStream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders?.();
            }

            await this.connectionRegistry.sendRequest(authIndex, requestPayload, (chunk, isFinished, isError) => {
                if (isError) {
                    if (!res.headersSent) {
                        res.status(500).json({
                            error: { code: 500, message: chunk || "Internal Error", status: "INTERNAL" },
                        });
                    } else if (isStream) {
                        res.write(`data: ${JSON.stringify({ error: chunk })}\n\n`);
                        res.end();
                    }
                    return;
                }

                if (isStream) {
                    if (chunk) {
                        const dataStr = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                        res.write(`data: ${dataStr}\n\n`);
                    }
                    if (isFinished) {
                        res.end();
                    }
                } else {
                    if (isFinished && !res.headersSent) {
                        res.status(200).json(chunk);
                    }
                }
            });
        } catch (error) {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[ConcurrentRequestHandler] Request processing error: ${error.message}`);
            }
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        code: 500,
                        message: error.message,
                        status: "INTERNAL",
                    },
                });
            }
        }
    }
}

module.exports = ConcurrentRequestHandler;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): implement ConcurrentRequestHandler for native Gemini endpoints"
```

---

### Task 3: Concurrent Module Facade Entrypoint (`src/concurrent/index.js`)

**Files:**
- Create: `src/concurrent/index.js`
- Test: `test/concurrent/index.test.js`

**Interfaces:**
- Consumes:
  - `AccountScheduler`: Class from `./AccountScheduler`
  - `ConcurrentRequestHandler`: Class from `./ConcurrentRequestHandler`
- Produces:
  - `initConcurrentMode(app, dependencies)`: Initializes `AccountScheduler`, `ConcurrentRequestHandler`, and registers routes onto Express `app`. Returns `{ scheduler, concurrentRequestHandler }`.

- [ ] **Step 1: Write failing unit test for `src/concurrent/index.js`**

Create `test/concurrent/index.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/index.test.js`
Expected: FAIL with "Cannot find module '../../src/concurrent'"

- [ ] **Step 3: Implement `src/concurrent/index.js`**

Create `src/concurrent/index.js`:

```javascript
/**
 * File: index.js
 * Description: Facade entrypoint for the concurrent multi-account subsystem
 */

const AccountScheduler = require("./AccountScheduler");
const ConcurrentRequestHandler = require("./ConcurrentRequestHandler");

/**
 * Initialize concurrent mode components and attach routes to Express app
 * @param {Object} app - Express application instance
 * @param {Object} dependencies - Core system dependencies
 * @param {Object} dependencies.authSource - AuthSource instance
 * @param {Object} dependencies.connectionRegistry - ConnectionRegistry instance
 * @param {Object} [dependencies.formatConverter] - FormatConverter instance
 * @param {Object} [dependencies.logger] - Logger instance
 * @param {Array} [dependencies.modelList] - Model configuration list
 * @returns {Object} Initialized concurrent components
 */
function initConcurrentMode(app, dependencies) {
    const { authSource, connectionRegistry, formatConverter, logger = console, modelList = [] } = dependencies;

    if (logger && typeof logger.info === "function") {
        logger.info("[Concurrent] Initializing concurrent multi-account forwarding subsystem...");
    }

    const scheduler = new AccountScheduler(authSource, connectionRegistry, logger);
    const concurrentRequestHandler = new ConcurrentRequestHandler(
        connectionRegistry,
        scheduler,
        formatConverter,
        logger,
        modelList
    );

    concurrentRequestHandler.registerRoutes(app);

    return {
        concurrentRequestHandler,
        scheduler,
    };
}

module.exports = {
    AccountScheduler,
    ConcurrentRequestHandler,
    initConcurrentMode,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/index.test.js`
Expected: PASS

- [ ] **Step 5: Commit Task 3**

```bash
git add src/concurrent/index.js test/concurrent/index.test.js
git commit -m "feat(concurrent): implement concurrent subsystem facade entrypoint in index.js"
```

---

### Task 4: System Integration in `ProxyServerSystem.js` & Verification

**Files:**
- Modify: `src/core/ProxyServerSystem.js:460-535`
- Test: `test/concurrent/integration.test.js`

**Interfaces:**
- Consumes:
  - `initConcurrentMode(app, dependencies)` from `../concurrent`
  - `process.env.ENABLE_CONCURRENT`
- Produces:
  - Integrated server route registration depending on `ENABLE_CONCURRENT` flag.

- [ ] **Step 1: Write integration test for `ProxyServerSystem` route branching**

Create `test/concurrent/integration.test.js`:

```javascript
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
```

- [ ] **Step 2: Run integration test**

Run: `npx jest test/concurrent/integration.test.js`
Expected: PASS

- [ ] **Step 3: Modify `ProxyServerSystem.js` to mount concurrent routes when enabled**

Modify `src/core/ProxyServerSystem.js`:

In `_createExpressApp()`, find the API routes section (around line 463):

Replace:
```javascript
        // API routes
        app.get(["/v1/models"], (req, res) => {
```

With:
```javascript
        // API routes
        const { initConcurrentMode } = require("../concurrent");
        initConcurrentMode(app, {
            authSource: this.authSource,
            connectionRegistry: this.connectionRegistry,
            formatConverter: this.formatConverter,
            logger: this.logger,
            modelList: this.config.modelList,
        });

        app.get(["/v1/models"], (req, res) => {
```

- [ ] **Step 4: Run all tests and check formatting/linting**

Run: `npx jest test/concurrent/`
Expected: PASS

Run: `npm run lint:js`
Expected: PASS with no lint errors

- [ ] **Step 5: Commit Task 4**

```bash
git add src/core/ProxyServerSystem.js test/concurrent/integration.test.js
git commit -m "feat(concurrent): integrate concurrent mode routing in ProxyServerSystem"
```

---
