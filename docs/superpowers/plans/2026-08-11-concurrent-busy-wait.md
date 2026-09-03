# Concurrent Busy Wait & Polling Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement non-blocking busy wait with 3000ms polling retry for concurrent request dispatch when all accounts are busy, with configurable timeout (default 60s) and client abort awareness.

**Architecture:** Add `CONCURRENT_WAIT_TIMEOUT_MS` config in `ConfigLoader.js`. Add `acquireNextAuthIndex(modelName, options)` to `AccountScheduler.js` that polls `getNextAuthIndex` every 3000ms until available, timeout reached, or client abort. Update `ConcurrentRequestHandler.js` to call `acquireNextAuthIndex` with client disconnect abort signal.

**Tech Stack:** Node.js CommonJS, AbortController, Express.js, Jest.

## Global Constraints

- Wait timeout environment variable: `CONCURRENT_WAIT_TIMEOUT_MS` (default 60000)
- Polling retry interval: 3000ms
- Error code on timeout: 503 (`All available accounts are busy`)

---

### Task 1: Add CONCURRENT_WAIT_TIMEOUT_MS to ConfigLoader

**Files:**
- Modify: `src/utils/ConfigLoader.js:20-60`
- Test: `test/utils/config_loader.test.js` (or inline check in `account_scheduler.test.js`)

**Interfaces:**
- Consumes: `process.env.CONCURRENT_WAIT_TIMEOUT_MS`
- Produces: `config.concurrentWaitTimeoutMs` (number, default 60000)

- [ ] **Step 1: Write the failing test**

In `test/concurrent/account_scheduler.test.js` or `test/utils/config_loader.test.js`, add test verifying `concurrentWaitTimeoutMs`:

```javascript
test("ConfigLoader parses CONCURRENT_WAIT_TIMEOUT_MS or defaults to 60000", () => {
    const ConfigLoader = require("../../src/utils/ConfigLoader");
    const loader = new ConfigLoader(console);
    
    delete process.env.CONCURRENT_WAIT_TIMEOUT_MS;
    let config = loader.loadConfiguration();
    expect(config.concurrentWaitTimeoutMs).toBe(60000);

    process.env.CONCURRENT_WAIT_TIMEOUT_MS = "30000";
    config = loader.loadConfiguration();
    expect(config.concurrentWaitTimeoutMs).toBe(30000);
    delete process.env.CONCURRENT_WAIT_TIMEOUT_MS;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "ConfigLoader parses CONCURRENT_WAIT_TIMEOUT_MS"`
Expected: FAIL (`config.concurrentWaitTimeoutMs` is `undefined`)

- [ ] **Step 3: Write minimal implementation**

In `src/utils/ConfigLoader.js`:

```javascript
// Inside loadConfiguration() config object definition:
concurrentWaitTimeoutMs: parseInt(process.env.CONCURRENT_WAIT_TIMEOUT_MS, 10) || 60000,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "ConfigLoader parses CONCURRENT_WAIT_TIMEOUT_MS"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/ConfigLoader.js test/concurrent/account_scheduler.test.js
git commit -m "feat(config): add CONCURRENT_WAIT_TIMEOUT_MS setting

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement acquireNextAuthIndex with Polling Retry in AccountScheduler

**Files:**
- Modify: `src/concurrent/AccountScheduler.js:500-640`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `this.getNextAuthIndex(modelName)`, `this.acquireInFlight(authIndex)`, `options.timeoutMs`, `options.signal`
- Produces: `async acquireNextAuthIndex(modelName, options)` returning `Promise<number>` (authIndex)

- [ ] **Step 1: Write failing unit tests for acquireNextAuthIndex**

In `test/concurrent/account_scheduler.test.js`, add:

```javascript
describe("acquireNextAuthIndex", () => {
    test("returns authIndex immediately when account is free", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.setAccountStatus(0, "ACTIVATED");

        const authIndex = await scheduler.acquireNextAuthIndex("gemini-2.5-flash");
        expect(authIndex).toBe(0);
        expect(scheduler.getInFlightCount(0)).toBe(1);
    });

    test("polls and resolves when account becomes free within timeout", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        mockAuthSource.availableIndices = [0];
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.setAccountStatus(0, "ACTIVATED");

        // Lock account 0 completely
        scheduler.acquireInFlight(0);
        scheduler.acquireInFlight(0);

        // Release in-flight after 100ms
        setTimeout(() => {
            scheduler.releaseInFlight(0);
            scheduler.releaseInFlight(0);
        }, 100);

        const authIndex = await scheduler.acquireNextAuthIndex("gemini-2.5-flash", { timeoutMs: 1000 });
        expect(authIndex).toBe(0);
    });

    test("throws 503 error after timeout if all accounts remain busy", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        mockAuthSource.availableIndices = [0];
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.setAccountStatus(0, "ACTIVATED");

        // Lock account 0 completely
        scheduler.acquireInFlight(0);
        scheduler.acquireInFlight(0);

        await expect(
            scheduler.acquireNextAuthIndex("gemini-2.5-flash", { timeoutMs: 100 })
        ).rejects.toMatchObject({
            message: expect.stringContaining("All available accounts are busy"),
            statusCode: 503,
        });
    });

    test("aborts immediately when signal is triggered during poll sleep", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        mockAuthSource.availableIndices = [0];
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.setAccountStatus(0, "ACTIVATED");

        scheduler.acquireInFlight(0);
        scheduler.acquireInFlight(0);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);

        await expect(
            scheduler.acquireNextAuthIndex("gemini-2.5-flash", { timeoutMs: 2000, signal: controller.signal })
        ).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "acquireNextAuthIndex"`
Expected: FAIL (`scheduler.acquireNextAuthIndex is not a function`)

- [ ] **Step 3: Write minimal implementation in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:

```javascript
    /**
     * Sleep helper supporting AbortSignal
     * @private
     */
    _sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                const err = new Error("Client request aborted during wait");
                err.name = "AbortError";
                return reject(err);
            }

            let timer = null;
            let onAbort = null;

            if (signal) {
                onAbort = () => {
                    if (timer) clearTimeout(timer);
                    const err = new Error("Client request aborted during wait");
                    err.name = "AbortError";
                    reject(err);
                };
                signal.addEventListener("abort", onAbort, { once: true });
            }

            timer = setTimeout(() => {
                if (signal && onAbort) {
                    signal.removeEventListener("abort", onAbort);
                }
                resolve();
            }, ms);
        });
    }

    /**
     * Acquire next available auth index with polling wait and timeout handling
     * @param {string} modelName
     * @param {Object} [options]
     * @param {number} [options.timeoutMs]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<number>} Selected authIndex
     */
    async acquireNextAuthIndex(modelName, options = {}) {
        const timeoutMs = options.timeoutMs || this.config?.concurrentWaitTimeoutMs || 60000;
        const signal = options.signal || null;
        const POLL_INTERVAL_MS = 3000;
        const start = Date.now();

        while (true) {
            if (signal?.aborted) {
                const err = new Error("Client request aborted during wait");
                err.name = "AbortError";
                throw err;
            }

            try {
                const authIndex = await this.getNextAuthIndex(modelName);
                this.acquireInFlight(authIndex);
                return authIndex;
            } catch (err) {
                const elapsed = Date.now() - start;
                const remaining = timeoutMs - elapsed;

                if (remaining <= 0) {
                    const timeoutErr = new Error(`All available accounts are busy (waited ${Math.round(elapsed / 1000)}s)`);
                    timeoutErr.statusCode = 503;
                    timeoutErr.statusText = "UNAVAILABLE";
                    throw timeoutErr;
                }

                const sleepDuration = Math.min(POLL_INTERVAL_MS, remaining);
                await this._sleep(sleepDuration, signal);
            }
        }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "acquireNextAuthIndex"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): implement acquireNextAuthIndex with 3000ms polling wait and timeout

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Integrate acquireNextAuthIndex into ConcurrentRequestHandler

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js:250-380`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `this.scheduler.acquireNextAuthIndex(cleanModelName, { signal, timeoutMs })`
- Produces: Asynchronous wait and request dispatch in Express handler

- [ ] **Step 1: Write failing test in concurrent_request_handler.test.js**

In `test/concurrent/concurrent_request_handler.test.js`, add test verifying polling wait integration:

```javascript
test("handleGeminiRequest uses acquireNextAuthIndex with AbortSignal", async () => {
    const mockScheduler = {
        acquireNextAuthIndex: jest.fn().mockResolvedValue(0),
        config: { concurrentWaitTimeoutMs: 60000 },
        releaseInFlight: jest.fn(),
        checkAndRetireAccount: jest.fn().mockResolvedValue(false),
    };
    const mockRegistry = {
        sendRequest: jest.fn((authIdx, payload, cb) => cb(null, true, false, { status: 200 })),
        removeMessageQueue: jest.fn(),
    };

    const handler = new ConcurrentRequestHandler(mockRegistry, mockScheduler, console, []);

    const req = {
        path: "/v1beta/models/gemini-2.5-flash:generateContent",
        method: "POST",
        body: { contents: [] },
    };
    const res = {
        on: jest.fn(),
        removeListener: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
    };

    await handler.handleGeminiRequest(req, res);

    expect(mockScheduler.acquireNextAuthIndex).toHaveBeenCalledWith("gemini-2.5-flash", expect.objectContaining({
        timeoutMs: 60000,
        signal: expect.any(Object),
    }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "uses acquireNextAuthIndex"`
Expected: FAIL (`mockScheduler.acquireNextAuthIndex` was not called)

- [ ] **Step 3: Update ConcurrentRequestHandler.js**

In `src/concurrent/ConcurrentRequestHandler.js`, update `handleGeminiRequest`:

```javascript
        const abortController = new AbortController();
        const onClientClose = () => {
            abortController.abort();
        };
        res.on("close", onClientClose);

        let authIndex;
        try {
            authIndex = await this.scheduler.acquireNextAuthIndex(cleanModelName, {
                signal: abortController.signal,
                timeoutMs: this.scheduler.config?.concurrentWaitTimeoutMs || 60000,
            });
        } catch (error) {
            res.removeListener("close", onClientClose);
            if (abortController.signal.aborted) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info("[ConcurrentRequestHandler] Request aborted by client during account wait");
                }
                return;
            }
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[ConcurrentRequestHandler] Failed to acquire account: ${error.message}`);
            }
            return res.status(error.statusCode || 503).json({
                error: {
                    code: error.statusCode || 503,
                    message: error.message,
                    status: error.statusText || "UNAVAILABLE",
                },
            });
        }
```

Ensure `this.scheduler.acquireInFlight(authIndex)` is NOT redundantly called if `acquireNextAuthIndex` already called it (Note: `acquireNextAuthIndex` calls `acquireInFlight`, so remove manual `acquireInFlight` call from `handleGeminiRequest`).

- [ ] **Step 4: Run test to verify it passes and full suite passes**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): integrate acquireNextAuthIndex with client abort signal into RequestHandler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update Documentation and Run Full Verification

**Files:**
- Modify: `src/concurrent/README.md`

- [ ] **Step 1: Update README.md with busy wait mechanism details**

Update `src/concurrent/README.md` to reflect `acquireNextAuthIndex`, 3000ms polling interval, and `CONCURRENT_WAIT_TIMEOUT_MS`.

- [ ] **Step 2: Run entire test suite and lint check**

Run: `npx jest test/concurrent/ && npm run lint:js`
Expected: 0 Errors, 0 ESLint warnings.

- [ ] **Step 3: Commit**

```bash
git add src/concurrent/README.md
git commit -m "docs(concurrent): update documentation for busy wait polling retry mechanism

Co-Authored-By: Claude <noreply@anthropic.com>"
```
