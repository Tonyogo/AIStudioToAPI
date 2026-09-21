# 响应头暴露当前请求账号标识 (X-Account-Name) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在所有 API 响应头（OpenAI / Claude / Gemini / File Upload，包含流式与非流式、标准模式与并发模式）中统一暴露 `X-Account-Name` 字段，使调用方可以准确获知每次请求具体由哪个后端 Google 账号处理。

**Architecture:** 在 `RequestHandler` 和 `ConcurrentRequestHandler` 的响应发送管道中注入 `X-Account-Name: <account_name>`，通过 `AuthSource` 获取账号名称；在 `ProxyServerSystem` 的 CORS 配置中暴露该 Header，确保客户端透明安全访问。

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- 响应头键名为 `X-Account-Name`，不改动响应 Body 结构，保持 100% 兼容现有 API 格式。
- 当未能获取到有效账号名称时，跳过注入，绝不设置 `"null"` 或 `"undefined"`。
- 在 `res.headersSent` 为 true 或客户端已断开时���避免重复写入 Header。
- 测试必须全部在 Node.js / Jest 环境中通过。

---

### Task 1: CORS 中间件暴露 X-Account-Name 响应头

**Files:**
- Modify: `src/core/ProxyServerSystem.js:391-400`
- Test: `test/routes/cors_headers.test.js`

**Interfaces:**
- Consumes: Express request / response
- Produces: `Access-Control-Expose-Headers` 包含 `x-account-name`

- [ ] **Step 1: 编写 CORS 响应头测试**

创建 `test/routes/cors_headers.test.js`:
```javascript
/* eslint-env jest */
const express = require("express");
const ProxyServerSystem = require("../../src/core/ProxyServerSystem");

describe("CORS Expose Headers", () => {
    let system;
    let app;

    beforeEach(() => {
        system = new ProxyServerSystem();
        app = system._createExpressApp();
    });

    test("includes x-account-name in Access-Control-Expose-Headers", async () => {
        const req = {
            method: "GET",
            path: "/health",
            headers: {},
        };
        const headers = {};
        const res = {
            header: (name, val) => {
                headers[name] = val;
            },
            sendStatus: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            use: jest.fn(),
        };

        // Trigger CORS middleware manually from app
        const corsMiddleware = app._router.stack.find(
            layer => layer.name === "<anonymous>" && layer.handle.length === 3
        );
        expect(corsMiddleware).toBeDefined();

        let nextCalled = false;
        corsMiddleware.handle(req, res, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(headers["Access-Control-Expose-Headers"]).toContain("x-account-name");
    });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest test/routes/cors_headers.test.js`
Expected: FAIL with `expect(received).toContain(expected)`

- [ ] **Step 3: 修改 ProxyServerSystem.js 的 CORS 配置**

在 `src/core/ProxyServerSystem.js` 的 `_createExpressApp` 中更新 `Access-Control-Expose-Headers`：
```javascript
            res.header(
                "Access-Control-Expose-Headers",
                "x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity, " +
                    "x-goog-upload-control-url, x-goog-upload-command, x-goog-upload-content-type, " +
                    "x-goog-upload-protocol, x-goog-upload-file-name, x-goog-upload-offset, " +
                    "date, content-type, content-length, location, x-account-name, X-Account-Name"
            );
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/routes/cors_headers.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/core/ProxyServerSystem.js test/routes/cors_headers.test.js
git commit -m "feat(cors): expose x-account-name in Access-Control-Expose-Headers"
```

---

### Task 2: 在 RequestHandler 中实现 _injectAccountHeader 并接入非流式与流式生成接口

**Files:**
- Modify: `src/core/RequestHandler.js`
- Test: `test/core/request_handler_account_header.test.js`

**Interfaces:**
- Produces: `RequestHandler.prototype._injectAccountHeader(res, authIndex)`
- Consumes: `this._getAccountNameForIndex(authIndex)`

- [ ] **Step 1: 编写 RequestHandler 基础注入测试**

创建 `test/core/request_handler_account_header.test.js`:
```javascript
/* eslint-env jest */
const RequestHandler = require("../../src/core/RequestHandler");

describe("RequestHandler - X-Account-Name injection", () => {
    let handler;
    let mockAuthSource;
    let mockServerSystem;

    beforeEach(() => {
        mockAuthSource = {
            accountNameMap: new Map([
                [0, "account0@gmail.com"],
                [1, "account1@gmail.com"],
            ]),
            getCanonicalIndex: jest.fn(idx => idx),
        };

        mockServerSystem = {
            usageStatsService: null,
            webRoutes: { authRoutes: { getClientIP: () => "127.0.0.1" } },
        };

        handler = new RequestHandler(
            mockServerSystem,
            {}, // connectionRegistry
            { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }, // logger
            { currentAuthIndex: 0 }, // browserManager
            {}, // config
            mockAuthSource
        );
    });

    test("_injectAccountHeader sets X-Account-Name when account name exists", () => {
        const headers = {};
        const res = {
            headersSent: false,
            setHeader: jest.fn((key, val) => {
                headers[key] = val;
            }),
        };

        handler._injectAccountHeader(res, 0);
        expect(res.setHeader).toHaveBeenCalledWith("X-Account-Name", "account0@gmail.com");
        expect(headers["X-Account-Name"]).toBe("account0@gmail.com");
    });

    test("_injectAccountHeader does nothing when headers are already sent", () => {
        const res = {
            headersSent: true,
            setHeader: jest.fn(),
        };

        handler._injectAccountHeader(res, 0);
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    test("_injectAccountHeader does nothing when account name is not found", () => {
        const res = {
            headersSent: false,
            setHeader: jest.fn(),
        };

        handler._injectAccountHeader(res, 999);
        expect(res.setHeader).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest test/core/request_handler_account_header.test.js`
Expected: FAIL with `handler._injectAccountHeader is not a function`

- [ ] **Step 3: 在 RequestHandler.js 中实现 _injectAccountHeader 并在核心生成接口中调用**

在 `src/core/RequestHandler.js` 中添加辅助方法：
```javascript
    _injectAccountHeader(res, authIndex = this.currentAuthIndex) {
        if (!res || res.headersSent) return;
        const resolvedAuthIndex = Number.isInteger(authIndex) ? authIndex : this.currentAuthIndex;
        let accountName = this._getAccountNameForIndex(resolvedAuthIndex);
        if (!accountName && this.authSource?.getCanonicalIndex) {
            const canonicalIdx = this.authSource.getCanonicalIndex(resolvedAuthIndex);
            if (canonicalIdx !== resolvedAuthIndex) {
                accountName = this._getAccountNameForIndex(canonicalIdx);
            }
        }
        if (accountName && typeof accountName === "string") {
            res.setHeader("X-Account-Name", accountName);
        }
    }
```

在以下各方法中接入 `_injectAccountHeader`：
1. `_handleNonStreamResponse(proxyRequest, messageQueue, req, res)`：发送响应前调用 `this._injectAccountHeader(res);`
2. `_sendOpenAINonStreamResponse(messageQueue, res, model, requestId)`：发送响应前调用 `this._injectAccountHeader(res);`
3. `_sendClaudeNonStreamResponse(messageQueue, res, model, requestId)`：发送响应前调用 `this._injectAccountHeader(res);`
4. `processOpenAIRequest` (Real Stream 分支)：在设置 SSE Headers（`res.status(200).set(...)`）处调用 `this._injectAccountHeader(res, currentQueueAuthIndex);`
5. `processOpenAIRequest` (Fake Stream keep-alive 分支)：在设置 SSE Headers 处调用 `this._injectAccountHeader(res);`
6. `processClaudeRequest` (Real Stream & Fake Stream 分支)：在设置 SSE Headers 处调用 `this._injectAccountHeader(res, currentQueueAuthIndex);`
7. `_handleRealStreamResponse(proxyRequest, messageQueue, req, res)`：在设置 SSE Headers 处调用 `this._injectAccountHeader(res, currentQueueAuthIndex);`
8. `_handlePseudoStreamResponse(proxyRequest, messageQueue, req, res)`：在设置 SSE Headers 处调用 `this._injectAccountHeader(res);`

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/core/request_handler_account_header.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/core/RequestHandler.js test/core/request_handler_account_header.test.js
git commit -m "feat(request): implement _injectAccountHeader for generation streams and non-stream endpoints"
```

---

### Task 3: 接入 Embeddings, Responses, Count Tokens, Upload 及 Error 响应

**Files:**
- Modify: `src/core/RequestHandler.js`
- Test: `test/core/request_handler_account_header.test.js`

**Interfaces:**
- Consumes: `_injectAccountHeader(res, authIndex)`
- Produces: 所有辅助��口与错误响应均附带 `X-Account-Name` 响应头

- [ ] **Step 1: 在测试中补充错误响应与 Embeddings / Token Count 验证用例**

在 `test/core/request_handler_account_header.test.js` 中增加测试用例：
```javascript
    test("_sendErrorResponse injects X-Account-Name header when headers are not sent", () => {
        const headers = {};
        const res = {
            headersSent: false,
            setHeader: jest.fn((key, val) => {
                headers[key] = val;
            }),
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        handler._sendErrorResponse(res, 500, "Internal Server Error");
        expect(res.setHeader).toHaveBeenCalledWith("X-Account-Name", "account0@gmail.com");
    });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest test/core/request_handler_account_header.test.js`
Expected: FAIL with `expect(jest.fn()).toHaveBeenCalledWith("X-Account-Name", "account0@gmail.com")`

- [ ] **Step 3: 在 RequestHandler.js 中完善注入调用点**

在以下方法中加入 `this._injectAccountHeader(res)`：
1. `_sendErrorResponse(res, statusCode, message, type)`：在 `if (!res || res.headersSent) return;` 之后立即调用 `this._injectAccountHeader(res);`
2. `_handleRequestError(error, res, requestId)`：在 `!res.headersSent` 的错误响应分支中调用 `this._injectAccountHeader(res);`
3. `processOpenAIEmbeddingsRequest(req, res)`：在代理请求执行与响应时确保注入
4. `processOpenAIResponseRequest(req, res)`
5. `processOpenAIResponseInputTokens(req, res)`
6. `processClaudeCountTokens(req, res)`
7. `processUploadRequest(req, res)`：在返回 upload URL / offset / 成功响应头之前调用 `this._injectAccountHeader(res);`

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/core/request_handler_account_header.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/core/RequestHandler.js test/core/request_handler_account_header.test.js
git commit -m "feat(request): inject X-Account-Name into embeddings, tokens, uploads, and error responses"
```

---

### Task 4: 并发模式 (ConcurrentRequestHandler) 接入 X-Account-Name

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `scheduler.authSource` 或 `serverSystem.authSource`
- Produces: `_sendResponseChunk` 中为所有并发流式��非流式响应注入 `X-Account-Name`

- [ ] **Step 1: 编写 ConcurrentRequestHandler 的 X-Account-Name 测试**

在 `test/concurrent/concurrent_request_handler.test.js` 中新增测试用例：
```javascript
    test("handleGeminiRequest injects X-Account-Name header on non-stream response", async () => {
        const mockAuthSource = {
            accountNameMap: new Map([[0, "concurrent-acc@gmail.com"]]),
            getCanonicalIndex: idx => idx,
        };

        const handler = new ConcurrentRequestHandler(
            mockConnectionRegistry,
            mockScheduler,
            mockLogger,
            [{ name: "models/gemini-2.5-flash" }],
            null,
            mockAuthSource
        );

        mockConnectionRegistry.sendRequest.mockImplementation(async (authIndex, payload, cb) => {
            cb({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }, true, false, { status: 200 });
        });

        const req = {
            body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
            headers: {},
            method: "POST",
            params: { 0: "gemini-2.5-flash:generateContent" },
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };

        const headers = {};
        const res = {
            headersSent: false,
            json: jest.fn(),
            setHeader: jest.fn((k, v) => {
                headers[k] = v;
            }),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(res.setHeader).toHaveBeenCalledWith("X-Account-Name", "concurrent-acc@gmail.com");
    });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: FAIL with `expect(jest.fn()).toHaveBeenCalledWith("X-Account-Name", "concurrent-acc@gmail.com")`

- [ ] **Step 3: 修改 ConcurrentRequestHandler.js 支持注入**

在 `src/concurrent/ConcurrentRequestHandler.js`:
1. `constructor` 中接收 `authSource`（或从 `scheduler.authSource` / `serverSystem.authSource` 获取）并保存：`this.authSource = authSource || scheduler?.authSource || null;`
2. 添加 `_injectAccountHeader(res, authIndex)` 辅助方法：
```javascript
    _injectAccountHeader(res, authIndex) {
        if (!res || res.headersSent) return;
        const accountName = this.authSource?.accountNameMap?.get(authIndex);
        if (accountName && typeof accountName === "string") {
            res.setHeader("X-Account-Name", accountName);
        }
    }
```
3. 在 `_sendResponseChunk` 中，写流式头或非流式响应前调用 `this._injectAccountHeader(res, meta?.authIndex ?? authIndex);`
4. 确保在 `handleGeminiRequest`、`handleOpenAIRequest`、`handleClaudeRequest` 等流程中把当前的 `authIndex` 传递给 `_sendResponseChunk` 的 meta 中。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): inject X-Account-Name into concurrent request handler responses"
```

---

### Task 5: 完整测试套件回归与验证

**Files:**
- Test: `test/routes/cors_headers.test.js`
- Test: `test/core/request_handler_account_header.test.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

- [ ] **Step 1: 运行全部相关测试套件**

Run: `npx jest test/core/ test/concurrent/ test/routes/ test/auth/`
Expected: ALL PASS

- [ ] **Step 2: 检查代码质量与 Lint**

Run: `npm run lint:js`
Expected: 0 errors

- [ ] **Step 3: 提交最终文档与测试**

```bash
git add .
git commit -m "chore: complete test suite and verification for X-Account-Name header"
```
