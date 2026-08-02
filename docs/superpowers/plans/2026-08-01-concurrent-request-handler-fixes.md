# ConcurrentRequestHandler Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `ConcurrentRequestHandler.js` in the concurrent subsystem to correctly pass through HTTP status codes/headers, map Gemini error formats, and cancel pending requests when clients disconnect early.

**Architecture:** Update `_sendRequestImpl` and `handleGeminiRequest` in `ConcurrentRequestHandler.js` to parse `response_headers` and error statuses from WebSocket messages, forward them to the Express response, and register a `res.on("close")` event listener for client cancellation.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/ConcurrentRequestHandler.js`.
- Keep modifications self-contained in `src/concurrent/ConcurrentRequestHandler.js` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Support Response Status & Header Passthrough

**Files:**

- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**

- Consumes: WebSocket messages with `event_type === "response_headers"` containing `status` and `headers`.
- Produces: `callback(chunk, isFinished, isError, responseMeta)` where `responseMeta` holds `{ status, headers }`.

- [ ] **Step 1: Write failing tests for response status and header passthrough**

Edit `test/concurrent/concurrent_request_handler.test.js` to add tests for `response_headers` processing and `res.status()` setting for non-stream responses.

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "captures response status and headers"`
Expected: FAIL (callback was called with 3 arguments instead of 4, or fourth argument was missing status/headers).

- [ ] **Step 3: Implement response status and header passthrough in ConcurrentRequestHandler.js**

In `src/concurrent/ConcurrentRequestHandler.js`:

1. In `_sendRequestImpl`, define `let responseStatus = 200;` and `let responseHeaders = {};`.
2. When handling `message.event_type === "response_headers"`:
   - Update `if (message.status) responseStatus = Number(message.status);`
   - Update `if (message.headers) responseHeaders = message.headers;`
3. Pass `responseMeta = { headers: responseHeaders, status: responseStatus }` as the fourth argument to `callback` on `STREAM_END` and chunk delivery.
4. In `handleGeminiRequest`, extract `responseStatus = meta.status || 200` from callback and use `res.status(responseStatus)` for non-streaming response.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): capture and pass through response status and headers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement Gemini Error Status & Format Passthrough

**Files:**

- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**

- Consumes: WebSocket error messages containing `status` and `message`.
- Produces: Express error response JSON with correct status code (e.g., 429, 400, 503) and Gemini `status` text (`RESOURCE_EXHAUSTED`, `INVALID_ARGUMENT`, `UNAVAILABLE`, `INTERNAL`).

- [ ] **Step 1: Write failing tests for Gemini error status and statusText mapping**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "returns correct HTTP status and Gemini error payload"`
Expected: FAIL (res.status was called with 500 instead of 429, status was "INTERNAL" instead of "RESOURCE_EXHAUSTED").

- [ ] **Step 3: Implement Gemini error status and statusText mapping**

In `src/concurrent/ConcurrentRequestHandler.js`:

1. In `_sendRequestImpl`, when `message.event_type === "error"`, extract `const errStatus = message.status || 500;` and invoke `callback(message.message || "Request failed", true, true, { status: errStatus });`.
2. In `handleGeminiRequest`, map `responseStatus`:
   ```javascript
   const statusText =
     responseStatus === 429
       ? "RESOURCE_EXHAUSTED"
       : responseStatus === 400
         ? "INVALID_ARGUMENT"
         : responseStatus === 503
           ? "UNAVAILABLE"
           : "INTERNAL";
   ```
3. Update error response formatting to use `res.status(responseStatus).json({ error: { code: responseStatus, message: chunk || "Internal Error", status: statusText } })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "fix(concurrent): map Gemini error statuses and statusText correctly

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Implement Client Disconnect Cancellation Mechanism

**Files:**

- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**

- Consumes: Express `res.on("close")` event.
- Produces: `cancel_request` WebSocket message to the browser context if client disconnects before completion.

- [ ] **Step 1: Write failing tests for client disconnect handling**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "sends cancel_request when client disconnects early"`
Expected: FAIL (res.on was not called or cancel_request message was not sent).

- [ ] **Step 3: Implement client disconnect handling in handleGeminiRequest**

In `src/concurrent/ConcurrentRequestHandler.js`:

1. Generate `requestId` and `requestAttemptId` inside `handleGeminiRequest`.
2. Pass `requestId` and `requestAttemptId` in `requestPayload`.
3. Track completion state with `let isRequestCompleted = false;`.
4. Register `res.on("close", ...)`:
   ```javascript
   res.on("close", () => {
     if (!isRequestCompleted && !res.writableEnded) {
       if (this.logger && typeof this.logger.warn === "function") {
         this.logger.warn(`[ConcurrentRequestHandler] Client closed connection prematurely for request #${requestId}`);
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
   ```
5. Set `isRequestCompleted = true` when streaming finishes or non-stream response is sent.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): send cancel_request on client disconnect

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Full Suite & Lint Verification

**Files:**

- Modify/Verify: `src/concurrent/ConcurrentRequestHandler.js`, `test/concurrent/*`

- [ ] **Step 1: Run all concurrent tests**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 2: Run linter on JS files**

Run: `npm run lint:js`
Expected: PASS (0 errors)

- [ ] **Step 3: Commit any formatting or lint fixes**

```bash
git add .
git commit -m "chore(concurrent): complete ConcurrentRequestHandler fixes and passing tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```
