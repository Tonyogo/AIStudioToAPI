# 30s Activation Cooldown & Max In-Flight Concurrency Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a 30-second global activation cooldown to prevent rapid context switches and cap per-account in-flight concurrent requests at 2, spreading concurrent requests across available accounts.

**Architecture:** Add `lastGlobalActivationAt` (cooldown check) and `inFlightMap` (`acquireInFlight`/`releaseInFlight` methods) to `AccountScheduler`. In `getNextAuthIndex`, filter candidates where `inFlight >= 2`, sort primary by `inFlightCount` ascending (scatter load), and throw a 503 `UNAVAILABLE` error when all accounts reach max concurrency. Pair `acquireInFlight` and `releaseInFlight` using `try ... finally` in `ConcurrentRequestHandler`.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Implement 30s Global Activation Cooldown in AccountScheduler

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `activateAccount(authIndex)` calls.
- Produces: Enforces `Date.now() - lastGlobalActivationAt >= 30000`. Returns `false` and skips activation if cooldown is active.

- [ ] **Step 1: Write failing test for 30s global activation cooldown**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("activateAccount skips activation if 30s global cooldown has not elapsed", async () => {
    const mockBrowserManager = {
        _sendActiveTrigger: jest.fn(),
        launchOrSwitchContext: jest.fn().mockResolvedValue(),
    };
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

    // First activation succeeds
    const first = await scheduler.activateAccount(0);
    expect(first).toBe(true);

    // Immediate second activation should be skipped due to cooldown
    const second = await scheduler.activateAccount(1);
    expect(second).toBe(false);
    expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "skips activation if 30s global cooldown"`
Expected: FAIL (`second` returned `true` and `launchOrSwitchContext` was called twice).

- [ ] **Step 3: Implement 30s cooldown check in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
1. In constructor, add `this.lastGlobalActivationAt = 0;` and `this.activationCooldownMs = 30000;`.
2. Update `activateAccount(authIndex)`:
```javascript
async activateAccount(authIndex) {
    if (!this.browserManager) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(
                `[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`
            );
        }
        return false;
    }

    const elapsed = Date.now() - this.lastGlobalActivationAt;
    if (this.lastGlobalActivationAt > 0 && elapsed < this.activationCooldownMs) {
        const remaining = Math.ceil((this.activationCooldownMs - elapsed) / 1000);
        if (this.logger && typeof this.logger.debug === "function") {
            this.logger.debug(
                `[AccountScheduler] Skipping activation for account #${authIndex}: 30s global cooldown active (${remaining}s remaining)`
            );
        }
        return false;
    }

    this.setAccountStatus(authIndex, "ACTIVATING");
    try {
        await this.browserManager.launchOrSwitchContext(authIndex);
        this.lastGlobalActivationAt = Date.now();
        const page = this.browserManager.page;
        if (typeof this.browserManager._sendActiveTrigger === "function") {
            this.browserManager._sendActiveTrigger("[AccountScheduler]", page);
        }
        this.setAccountStatus(authIndex, "ACTIVATED");
        if (this.logger && typeof this.logger.info === "function") {
            this.logger.info(`[AccountScheduler] Account #${authIndex} successfully activated`);
        }
        return true;
    } catch (error) {
        this.setAccountStatus(authIndex, "INACTIVE");
        if (this.logger && typeof this.logger.error === "function") {
            this.logger.error(`[AccountScheduler] Failed to activate account #${authIndex}: ${error.message}`);
        }
        return false;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): enforce 30s global activation cooldown in AccountScheduler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement In-Flight Request Tracking and Max Concurrency Control (Max = 2)

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `acquireInFlight(authIndex)`, `releaseInFlight(authIndex)`.
- Produces: `inFlightMap`, `getInFlightCount(authIndex)`, `acquireInFlight(authIndex)`, `releaseInFlight(authIndex)`. In `getNextAuthIndex`: filters candidates with `inFlight >= 2`, sorts primary by `inFlightCount` ascending, and throws 503 `UNAVAILABLE` when all online accounts reach max in-flight limit.

- [ ] **Step 1: Write failing tests for in-flight tracking, sorting, and 503 all-busy error**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("tracks in-flight requests and enforces acquire/release", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
    expect(scheduler.getInFlightCount(0)).toBe(0);

    scheduler.acquireInFlight(0);
    expect(scheduler.getInFlightCount(0)).toBe(1);

    scheduler.acquireInFlight(0);
    expect(scheduler.getInFlightCount(0)).toBe(2);

    scheduler.releaseInFlight(0);
    expect(scheduler.getInFlightCount(0)).toBe(1);
});

test("getNextAuthIndex prioritizes accounts with lower inFlightCount to spread load", async () => {
    mockConnectionRegistry.hasConnection.mockReturnValue(true);
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

    scheduler.setAccountStatus(0, "ACTIVATED");
    scheduler.setAccountStatus(1, "ACTIVATED");

    scheduler.acquireInFlight(0); // Account 0 has 1 in-flight
    // Account 1 has 0 in-flight

    const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
    expect(selected).toBe(1);
});

test("getNextAuthIndex throws 503 when all online accounts have 2 in-flight requests", async () => {
    mockConnectionRegistry.hasConnection.mockReturnValue(true);
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

    scheduler.setAccountStatus(0, "ACTIVATED");
    scheduler.setAccountStatus(1, "ACTIVATED");

    scheduler.acquireInFlight(0);
    scheduler.acquireInFlight(0); // Account 0 has 2 in-flight
    scheduler.acquireInFlight(1);
    scheduler.acquireInFlight(1); // Account 1 has 2 in-flight

    await expect(scheduler.getNextAuthIndex("gemini-2.5-flash")).rejects.toMatchObject({
        message: expect.stringContaining("All available accounts are busy"),
        statusCode: 503,
        statusText: "UNAVAILABLE",
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "in-flight"`
Expected: FAIL (`scheduler.getInFlightCount is not a function`).

- [ ] **Step 3: Implement in-flight methods and update getNextAuthIndex in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
1. In constructor, initialize `this.inFlightMap = new Map();` and `this.maxInFlightPerAccount = 2;`.
2. Add in-flight methods:
```javascript
getInFlightCount(authIndex) {
    return this.inFlightMap.get(authIndex) || 0;
}

acquireInFlight(authIndex) {
    if (authIndex === undefined || authIndex < 0) return;
    const current = this.getInFlightCount(authIndex);
    this.inFlightMap.set(authIndex, current + 1);
}

releaseInFlight(authIndex) {
    if (authIndex === undefined || authIndex < 0) return;
    const current = this.getInFlightCount(authIndex);
    this.inFlightMap.set(authIndex, Math.max(0, current - 1));
}
```
3. Update `getNextAuthIndex(modelName)`:
```javascript
async getNextAuthIndex(modelName = null) {
    this.lastSystemActivityAt = Date.now();
    const indices = this._getAccountIndices();
    if (indices.length === 0) {
        const err = new Error("No authentication accounts configured");
        err.statusCode = 503;
        throw err;
    }

    const limit = this.getModelDailyLimit(modelName);
    const total = indices.length;

    let onlineAccountCount = 0;
    let cappedOnlineAccountCount = 0;
    let busyOnlineAccountCount = 0;

    const candidateList = [];
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
            onlineAccountCount++;
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
            if (usage >= limit) {
                cappedOnlineAccountCount++;
                continue;
            }
            const inFlight = this.getInFlightCount(candidateIdx);
            if (inFlight >= this.maxInFlightPerAccount) {
                busyOnlineAccountCount++;
                continue;
            }
            if (this.getAccountStatus(candidateIdx) === "ACTIVATED") {
                candidateList.push({ idx: candidateIdx, inFlight, order: i, usage });
            }
        }
    }

    if (candidateList.length > 0) {
        // Sort primary by inFlight ascending (spread concurrency), secondary by usage ascending, tertiary by Round-Robin order
        candidateList.sort((a, b) => {
            if (a.inFlight !== b.inFlight) {
                return a.inFlight - b.inFlight;
            }
            if (a.usage !== b.usage) {
                return a.usage - b.usage;
            }
            return a.order - b.order;
        });

        const selectedIdx = candidateList[0].idx;
        const selectedOrder = candidateList[0].order;
        this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

        if (this.logger && typeof this.logger.debug === "function") {
            this.logger.debug(
                `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (inFlight=${candidateList[0].inFlight}, usage=${candidateList[0].usage}/${limit})`
            );
        }
        return selectedIdx;
    }

    // Fallback: Find first online INACTIVE account that is NOT capped and NOT busy, and activate it synchronously
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
            if (usage >= limit) continue;
            const inFlight = this.getInFlightCount(candidateIdx);
            if (inFlight >= this.maxInFlightPerAccount) continue;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] No ACTIVATED accounts available, synchronously activating authIndex #${candidateIdx}...`
                );
            }
            const activated = await this.activateAccount(candidateIdx);
            if (activated) {
                this.currentIndex = (this.currentIndex + i + 1) % total;
                return candidateIdx;
            }
        }
    }

    // Error classification
    if (onlineAccountCount > 0 && cappedOnlineAccountCount >= onlineAccountCount) {
        const error = new Error(
            `All accounts reached daily limit of ${limit} requests for model "${modelName}"`
        );
        error.statusCode = 429;
        error.statusText = "RESOURCE_EXHAUSTED";
        throw error;
    }

    if (onlineAccountCount > 0 && (busyOnlineAccountCount + cappedOnlineAccountCount) >= onlineAccountCount) {
        const error = new Error(
            `All available accounts are busy at maximum concurrency limit (${this.maxInFlightPerAccount}/${this.maxInFlightPerAccount})`
        );
        error.statusCode = 503;
        error.statusText = "UNAVAILABLE";
        throw error;
    }

    const error = new Error("No active context connection available");
    error.statusCode = 503;
    throw error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): add in-flight request tracking, max concurrency cap of 2, and load spreading

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Integrate In-Flight Acquire and Release Pair in ConcurrentRequestHandler

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `scheduler.acquireInFlight(authIndex)` and `scheduler.releaseInFlight(authIndex)`.
- Produces: Calls `acquireInFlight` after `getNextAuthIndex` and guarantees `releaseInFlight` in a `try ... finally` block.

- [ ] **Step 1: Write failing test in concurrent_request_handler.test.js for in-flight acquire/release pairing**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "acquires and releases in-flight"`
Expected: FAIL (`mockScheduler.acquireInFlight` not called).

- [ ] **Step 3: Update handleGeminiRequest in ConcurrentRequestHandler.js**

In `src/concurrent/ConcurrentRequestHandler.js`:
```javascript
async handleGeminiRequest(req, res) {
    const cleanModelName = this._extractCleanModelName(req.path);
    let authIndex;
    try {
        authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
        if (typeof this.scheduler.acquireInFlight === "function") {
            this.scheduler.acquireInFlight(authIndex);
        }
    } catch (err) {
        const statusCode = err.statusCode || 503;
        const statusText = err.statusText || (statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE");
        if (this.logger && typeof this.logger.error === "function") {
            this.logger.error(`[ConcurrentRequestHandler] Scheduling failed: ${err.message}`);
        }
        return res.status(statusCode).json({
            error: {
                code: statusCode,
                message: err.message,
                status: statusText,
            },
        });
    }

    try {
        if (typeof this.scheduler.recordUsage === "function" && cleanModelName) {
            this.scheduler.recordUsage(authIndex, cleanModelName);
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const requestAttemptId = `${requestId}_attempt_1_${Math.random().toString(36).substring(2, 8)}`;
        let isRequestCompleted = false;

        if (typeof res.on === "function") {
            res.on("close", () => {
                if (!isRequestCompleted && !res.writableEnded) {
                    if (this.logger && typeof this.logger.warn === "function") {
                        this.logger.warn(
                            `[ConcurrentRequestHandler] Client closed connection prematurely for request #${requestId}`
                        );
                    }
                    const connection = this.connectionRegistry.getConnectionByAuth(authIndex);
                    if (connection) {
                        connection.send(
                            JSON.stringify({
                                event_type: "cancel_request",
                                request_attempt_id: requestAttemptId,
                                request_id: requestId,
                            })
                        );
                    }
                    this.connectionRegistry.removeMessageQueue(requestId, "client_disconnect");
                }
            });
        }

        const isStream = req.path.includes("streamGenerateContent") || req.query.alt === "sse";
        const requestBodyStr = req.method !== "GET" ? JSON.stringify(req.body) : undefined;

        const requestPayload = {
            action: "generateContent",
            body: requestBodyStr,
            headers: req.headers,
            isStream,
            method: req.method,
            path: req.path,
            query: req.query,
            requestAttemptId,
            requestId,
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

        await this.connectionRegistry.sendRequest(authIndex, requestPayload, (chunk, isFinished, isError, responseMeta) => {
            if (isError) {
                isRequestCompleted = true;
                const errStatus = (responseMeta && responseMeta.status) || 500;
                const statusText =
                    errStatus === 429
                        ? "RESOURCE_EXHAUSTED"
                        : errStatus === 400
                          ? "INVALID_ARGUMENT"
                          : errStatus === 503
                            ? "UNAVAILABLE"
                            : "INTERNAL";

                if (!res.headersSent) {
                    res.status(errStatus).json({
                        error: {
                            code: errStatus,
                            message: chunk || "Internal Error",
                            status: statusText,
                        },
                    });
                } else if (isStream) {
                    res.write(
                        `data: ${JSON.stringify({
                            error: {
                                code: errStatus,
                                message: chunk || "Internal Error",
                                status: statusText,
                            },
                        })}\n\n`
                    );
                    res.end();
                }
                return;
            }

            const responseStatus = (responseMeta && responseMeta.status) || 200;
            const responseHeaders = (responseMeta && responseMeta.headers) || {};

            if (isStream) {
                if (chunk) {
                    const dataStr = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                    res.write(dataStr);
                }
                if (isFinished) {
                    isRequestCompleted = true;
                    res.end();
                }
            } else {
                if (isFinished) {
                    isRequestCompleted = true;
                    if (!res.headersSent) {
                        const forbiddenHeaders = [
                            "transfer-encoding",
                            "content-encoding",
                            "access-control-allow-origin",
                            "access-control-allow-methods",
                            "access-control-allow-headers",
                        ];
                        Object.entries(responseHeaders).forEach(([hName, hVal]) => {
                            if (!forbiddenHeaders.includes(hName.toLowerCase())) {
                                res.setHeader(hName, hVal);
                            }
                        });
                        res.status(responseStatus).json(chunk);
                    }
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
    } finally {
        if (typeof this.scheduler.releaseInFlight === "function") {
            this.scheduler.releaseInFlight(authIndex);
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): acquire and release in-flight request count in ConcurrentRequestHandler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Full Suite Verification & Linting

**Files:**
- Modify/Verify: `src/concurrent/*`, `test/concurrent/*`

- [ ] **Step 1: Run all concurrent unit tests**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 2: Run linter on JS files**

Run: `npm run lint:js`
Expected: PASS (0 errors)

- [ ] **Step 3: Commit formatting or lint fixes**

```bash
git add .
git commit -m "chore(concurrent): complete 30s activation cooldown and in-flight concurrency control implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
