# Concurrent System Resilience, Retries, Usage Stats & Image Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the concurrent multi-account subsystem with 1-minute account failure suspension (429 or 2x 5xx), seamless cross-account retries before `res.headersSent`, Web UI `UsageStatsService` tracking, and automatic base64 image-to-markdown transformation.

**Architecture:** Extend `AccountScheduler` with `failureCountMap`, `suspendedUntilMap`, `recordFailure(authIndex, statusCode)`, `recordSuccess(authIndex)`, and `isAccountSuspended(authIndex)` (filtering in `getNextAuthIndex`). Update `ConcurrentRequestHandler` to wrap dispatches in a max-2 retry loop before `res.headersSent`, call `UsageStatsService` lifecycle methods (`startRequest`, `recordAttempt`, `finishRequest`), and parse `inlineData` images into Markdown data URLs (`_processImageInResponse`). Inject `usageStatsService` in `src/concurrent/index.js`.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Add Account Failure Tracking & Suspension in AccountScheduler

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: Error status codes from failed requests.
- Produces: `recordFailure(authIndex, statusCode)`, `recordSuccess(authIndex)`, `isAccountSuspended(authIndex)`. Excludes suspended accounts in `getNextAuthIndex`.

- [ ] **Step 1: Write failing tests for failure tracking and account suspension in AccountScheduler**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("recordFailure suspends account for 1 minute on 429 error", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
    expect(scheduler.isAccountSuspended(0)).toBe(false);

    scheduler.recordFailure(0, 429);
    expect(scheduler.isAccountSuspended(0)).toBe(true);
});

test("recordFailure suspends account after 2 consecutive non-429 5xx errors", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
    expect(scheduler.isAccountSuspended(0)).toBe(false);

    scheduler.recordFailure(0, 500);
    expect(scheduler.isAccountSuspended(0)).toBe(false);

    scheduler.recordFailure(0, 500);
    expect(scheduler.isAccountSuspended(0)).toBe(true);
});

test("getNextAuthIndex skips suspended accounts", async () => {
    mockConnectionRegistry.hasConnection.mockReturnValue(true);
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
    scheduler.setAccountStatus(0, "ACTIVATED");
    scheduler.setAccountStatus(1, "ACTIVATED");

    scheduler.recordFailure(0, 429); // Account 0 is suspended
    const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
    expect(selected).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "suspends account"`
Expected: FAIL (`scheduler.recordFailure is not a function`).

- [ ] **Step 3: Implement failure tracking and suspension in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
1. In constructor, add `this.failureCountMap = new Map();` and `this.suspendedUntilMap = new Map();`.
2. Add helper methods:
```javascript
isAccountSuspended(authIndex) {
    const suspendedUntil = this.suspendedUntilMap.get(authIndex) || 0;
    return Date.now() < suspendedUntil;
}

recordFailure(authIndex, statusCode) {
    if (authIndex === undefined || authIndex < 0) return;
    const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
    this.failureCountMap.set(authIndex, currentFailures);

    if (statusCode === 429) {
        this.suspendedUntilMap.set(authIndex, Date.now() + 60000); // Suspend for 1 minute on 429
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] AuthIndex #${authIndex} suspended for 1 minute due to HTTP 429 rate limit`);
        }
    } else if (currentFailures >= 2) {
        this.suspendedUntilMap.set(authIndex, Date.now() + 60000); // Suspend for 1 minute on 2 consecutive errors
        this.failureCountMap.set(authIndex, 0);
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] AuthIndex #${authIndex} suspended for 1 minute due to 2 consecutive failures`);
        }
    }
}

recordSuccess(authIndex) {
    if (authIndex === undefined || authIndex < 0) return;
    this.failureCountMap.set(authIndex, 0);
}
```
3. Update `getNextAuthIndex(modelName)` candidate loop to skip suspended accounts:
```javascript
if (this.isAccountSuspended(candidateIdx)) {
    if (this.logger && typeof this.logger.debug === "function") {
        this.logger.debug(`[AccountScheduler] AuthIndex #${candidateIdx} skipped: account is suspended`);
    }
    continue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): add account failure tracking and 1-minute suspension logic in AccountScheduler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement Cross-Account Seamless Retry in ConcurrentRequestHandler

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `handleGeminiRequest` dispatches.
- Produces: Up to 2 dispatch attempts. If attempt 1 fails before `res.headersSent`, records failure, releases in-flight, and seamlessly retries on a different account.

- [ ] **Step 1: Write failing test in concurrent_request_handler.test.js for cross-account retry**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
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
        createMessageQueue: jest
            .fn()
            .mockReturnValueOnce(mockQueue1)
            .mockReturnValueOnce(mockQueue2),
        getConnectionByAuth: jest
            .fn()
            .mockReturnValueOnce(mockWS1)
            .mockReturnValueOnce(mockWS2),
        removeMessageQueue: jest.fn(),
    };

    mockScheduler.getNextAuthIndex = jest
        .fn()
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "seamlessly retries"`
Expected: FAIL (`res.status` called with 500 because no retry attempt occurred).

- [ ] **Step 3: Implement cross-account retry loop in ConcurrentRequestHandler.js**

In `src/concurrent/ConcurrentRequestHandler.js`:
Refactor `handleGeminiRequest(req, res)` to execute a maximum 2-attempt loop:

```javascript
async handleGeminiRequest(req, res) {
    const cleanModelName = this._extractCleanModelName(req.path);
    const maxAttempts = 2;
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
        attempt++;
        let authIndex;
        try {
            authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
            if (typeof this.scheduler.acquireInFlight === "function") {
                this.scheduler.acquireInFlight(authIndex);
            }
        } catch (err) {
            lastError = err;
            break;
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const requestAttemptId = `${requestId}_attempt_${attempt}_${Math.random().toString(36).substring(2, 8)}`;
        let isRequestCompleted = false;

        if (typeof res.on === "function") {
            res.on("close", () => {
                if (!isRequestCompleted && !res.writableEnded) {
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

        try {
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

            if (typeof this.scheduler.recordUsage === "function" && cleanModelName) {
                this.scheduler.recordUsage(authIndex, cleanModelName);
            }

            let attemptError = null;

            await this.connectionRegistry.sendRequest(
                authIndex,
                requestPayload,
                (chunk, isFinished, isError, meta = {}) => {
                    if (isFinished || isError) {
                        isRequestCompleted = true;
                    }
                    if (isError) {
                        const responseStatus = meta.status || 500;
                        const statusText =
                            responseStatus === 429
                                ? "RESOURCE_EXHAUSTED"
                                : responseStatus === 400
                                  ? "INVALID_ARGUMENT"
                                  : responseStatus === 503
                                    ? "UNAVAILABLE"
                                    : "INTERNAL";

                        attemptError = {
                            message: chunk || "Internal Error",
                            statusCode: responseStatus,
                            statusText,
                        };

                        if (!res.headersSent) {
                            if (attempt >= maxAttempts) {
                                res.status(responseStatus).json({
                                    error: { code: responseStatus, message: chunk || "Internal Error", status: statusText },
                                });
                            }
                        } else if (isStream) {
                            res.write(
                                `data: ${JSON.stringify({ error: { code: responseStatus, message: chunk || "Internal Error", status: statusText } })}\n\n`
                            );
                            res.end();
                        }
                        return;
                    }

                    if (isStream) {
                        if (!res.headersSent) {
                            res.setHeader("Content-Type", "text/event-stream");
                            res.setHeader("Cache-Control", "no-cache");
                            res.setHeader("Connection", "keep-alive");
                            res.flushHeaders?.();
                        }
                        if (chunk) {
                            const dataStr = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                            res.write(dataStr);
                        }
                        if (isFinished) {
                            res.end();
                        }
                    } else {
                        if (isFinished && !res.headersSent) {
                            const responseStatus = meta.status || 200;
                            if (meta.headers) {
                                for (const [headerName, headerVal] of Object.entries(meta.headers)) {
                                    if (
                                        headerName.toLowerCase() !== "transfer-encoding" &&
                                        headerName.toLowerCase() !== "content-encoding"
                                    ) {
                                        res.setHeader(headerName, headerVal);
                                    }
                                }
                            }
                            res.status(responseStatus).json(chunk);
                        }
                    }
                }
            );

            isRequestCompleted = true;

            if (attemptError) {
                if (typeof this.scheduler.recordFailure === "function") {
                    this.scheduler.recordFailure(authIndex, attemptError.statusCode);
                }
                lastError = attemptError;
                if (res.headersSent) {
                    break; // Cannot retry if headers already sent
                }
            } else {
                if (typeof this.scheduler.recordSuccess === "function") {
                    this.scheduler.recordSuccess(authIndex);
                }
                lastError = null;
                break; // Success!
            }
        } catch (error) {
            isRequestCompleted = true;
            if (typeof this.scheduler.recordFailure === "function") {
                this.scheduler.recordFailure(authIndex, 500);
            }
            lastError = { message: error.message, statusCode: 500, statusText: "INTERNAL" };
            if (res.headersSent) {
                break;
            }
        } finally {
            if (typeof this.scheduler.releaseInFlight === "function") {
                this.scheduler.releaseInFlight(authIndex);
            }
        }
    }

    if (lastError && !res.headersSent) {
        const statusCode = lastError.statusCode || 503;
        const statusText = lastError.statusText || (statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE");
        res.status(statusCode).json({
            error: { code: statusCode, message: lastError.message, status: statusText },
        });
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): implement cross-account seamless retries before headersSent in ConcurrentRequestHandler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Integrate UsageStatsService Tracking & Image Markdown Transformation

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Modify: `src/concurrent/index.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `usageStatsService` passed to `ConcurrentRequestHandler` constructor (from `system.usageStatsService`).
- Produces: Calls `usageStatsService` lifecycle (`startRequest`, `recordAttempt`, `finishRequest`) and transforms inline image data in non-stream responses into Markdown Data URLs (`_processImageInResponse`).

- [ ] **Step 1: Write failing tests for usageStatsService tracking and image Markdown transformation**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
test("handleGeminiRequest tracks request lifecycle in usageStatsService", async () => {
    const mockUsageStats = {
        finishRequest: jest.fn(),
        recordAttempt: jest.fn(),
        startRequest: jest.fn(),
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

    expect(mockUsageStats.startRequest).toHaveBeenCalled();
    expect(mockUsageStats.recordAttempt).toHaveBeenCalled();
    expect(mockUsageStats.finishRequest).toHaveBeenCalled();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "tracks request lifecycle"`
Expected: FAIL (`mockUsageStats.startRequest` was not called).

- [ ] **Step 3: Implement UsageStatsService integration, image process, and facade injection**

In `src/concurrent/ConcurrentRequestHandler.js`:
1. Constructor signature update:
```javascript
constructor(connectionRegistry, scheduler, logger = console, modelList = [], usageStatsService = null) {
    this.connectionRegistry = connectionRegistry;
    this.scheduler = scheduler;
    this.logger = logger;
    this.modelList = modelList;
    this.usageStatsService = usageStatsService;

    if (this.connectionRegistry && typeof this.connectionRegistry.sendRequest !== "function") {
        this.connectionRegistry.sendRequest = this._sendRequestImpl.bind(this);
    }
}
```
2. Add `_processImageInResponse` method:
```javascript
_processImageInResponse(chunk) {
    if (!chunk || typeof chunk !== "object") return chunk;
    try {
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
            const imagePartIndex = candidate.content.parts.findIndex(p => p && p.inlineData);
            if (imagePartIndex > -1) {
                const imagePart = candidate.content.parts[imagePartIndex];
                const image = imagePart.inlineData;
                candidate.content.parts[imagePartIndex] = {
                    text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
                };
            }
        }
    } catch (e) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[ConcurrentRequestHandler] Image process error: ${e.message}`);
        }
    }
    return chunk;
}
```
3. Update `handleGeminiRequest` with `usageStatsService` tracking calls and image conversion for non-stream chunks:
```javascript
this.usageStatsService?.startRequest(requestId, {
    apiFormat: "gemini",
    clientIp: req.ip || req.headers["x-forwarded-for"] || null,
    initialAuthIndex: authIndex,
    isStreaming: isStream,
    method: req.method,
    model: cleanModelName,
    path: req.path,
    requestCategory: "generation",
});
```
And inside non-stream callback:
```javascript
const processedChunk = this._processImageInResponse(chunk);
res.status(responseStatus).json(processedChunk);
```
And in `finally` / end:
```javascript
this.usageStatsService?.finishRequest(requestId, res, {
    outcome: lastError ? "error" : "success",
    statusCode: lastError ? (lastError.statusCode || 500) : 200,
});
```

In `src/concurrent/index.js`:
Pass `system.usageStatsService` when creating `ConcurrentRequestHandler`:
```javascript
const usageStatsService = system.usageStatsService || null;
const concurrentRequestHandler = new ConcurrentRequestHandler(
    connectionRegistry,
    scheduler,
    logger,
    modelList,
    usageStatsService
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js src/concurrent/index.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): integrate UsageStatsService tracking and image Markdown transformation

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
git commit -m "chore(concurrent): complete resilience, retries, stats tracking, and image process implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
