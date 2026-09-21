# 响应头暴露当前请求账号标识设计文档 (X-Account-Name Design)

## 1. 概述与背景
当前 AIStudioToAPI 作为多模型（OpenAI、Claude、Gemini）代理服务，支持多账号轮询与并发调度。调用方在调用接口时，无法直接得知本次请求实际是由哪一个后端 Google 账号承载处理的，导致调用方难以针对单账号维度进行精确的使用量统计、限流管控与问题排查。

本文档设计在所有模型调用与相关接口的 HTTP 响应头中统一暴露 `X-Account-Name` 字段，以实现对调用方的无侵入式账号感知。

---

## 2. 需求与设计目标
1. **统一返回格式**：在 HTTP 响应头中返回 `X-Account-Name`，值为该请求实际使���账号的完整名称/邮箱（例如 `user@example.com`）。
2. **全协议/格式支持**：
   - 支持 OpenAI 兼容接口（`/v1/chat/completions`、`/v1/embeddings`、`/v1/responses` 等）。
   - 支持 Claude 兼容接口（`/v1/messages`、`/v1/messages/count_tokens` 等）。
   - 支持 Google Gemini 原生接口（`/v1beta/models/...:generateContent`、`:streamGenerateContent` 等）。
   - 支持 File Upload 文件上传与分块接口。
3. **支持全部传输模式**：
   - 流式响应（SSE Stream：Real Stream 与 Fake Stream）。
   - 非流式响应（JSON）。
   - 错误响应（HTTP 4xx / 5xx）。
4. **支持两种调度架构**：
   - 标准单上下文轮询模式（`RequestHandler`）。
   - 多上下文并发模式（`ConcurrentRequestHandler`）。
5. **CORS 支持**：在 `Access-Control-Expose-Headers` 中暴露 `x-account-name`，保证前端与第三方 Web 客户端能够读取该响应头。
6. **零破坏性**：完全不改动原有 JSON / SSE Body 数据结构，确保官方 SDK 100% 兼容。

---

## 3. 详细设计与实现方案

### 3.1 响应头规范
- **Header 键名**：`X-Account-Name`
- **Header 取值**：
  - 优先从 `authSource.accountNameMap` 中根据 `authIndex` 读取账号完整名称/邮箱。
  - 若未解析到有效名称，回退尝试 `authSource.getCanonicalIndex(authIndex)` 获取规范账号名称。
  - 若仍无有效值或 `authIndex` 无效，则跳过注入，绝不设置 `"null"` 或 `"undefined"`。

### 3.2 CORS 配置 (`src/core/ProxyServerSystem.js`)
在 `_createExpressApp()` 中配置 CORS 的 `Access-Control-Expose-Headers`：
```javascript
res.header(
    "Access-Control-Expose-Headers",
    "x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity, " +
        "x-goog-upload-control-url, x-goog-upload-command, x-goog-upload-content-type, " +
        "x-goog-upload-protocol, x-goog-upload-file-name, x-goog-upload-offset, " +
        "date, content-type, content-length, location, x-account-name, X-Account-Name"
);
```

### 3.3 标准模式注入 (`src/core/RequestHandler.js`)
1. **注入辅助方法**：
   ```javascript
   _injectAccountHeader(res, authIndex = this.currentAuthIndex) {
       if (!res || res.headersSent) return;
       const accountName = this._getAccountNameForIndex(authIndex);
       if (accountName && typeof accountName === "string") {
           res.setHeader("X-Account-Name", accountName);
       }
   }
   ```
2. **非流式响应（Non-Stream）**：
   - 在 `_handleNonStreamResponse`、`_sendClaudeNonStreamResponse`、`_sendOpenAINonStreamResponse` 中写响应前调用 `this._injectAccountHeader(res)`。
3. **流式响应（Stream）**：
   - **Real Stream**：在接收到第一个有效数据包准备写 SSE Headers 时，调用 `this._injectAccountHeader(res, currentQueueAuthIndex)`。
   - **Fake Stream**：在设置 SSE 头（`Content-Type: text/event-stream`）或发送 keep-alive 握手时调用 `this._injectAccountHeader(res)`。
4. **其他 API 接口**：
   - `processOpenAIEmbeddingsRequest`
   - `processOpenAIResponseRequest`
   - `processClaudeCountTokens`
   - `processUploadRequest`
   - 在向客户端发送最终数据或反向代理响应前调用 `_injectAccountHeader(res)`。
5. **错误响应**：
   - 在 `_sendErrorResponse` 与 `_handleRequestError` 中，当 headers 未发送时注入当前选定账号的 `X-Account-Name`。

### 3.4 并发模式注入 (`src/concurrent/ConcurrentRequestHandler.js`)
1. **账号名称解析**：
   - 请求经 `scheduler.acquireNextAuthIndex(...)` 获取到 `authIndex` 后，通过 `authSource` 获取其 `accountName`。
2. **响应输出**：
   - 在 `_sendResponseChunk` 中，无论是非流式 `res.status(responseStatus).json(...)` 还是流式 `res.setHeader("Content-Type", "text/event-stream")`，在 `!res.headersSent` 时设置 `res.setHeader("X-Account-Name", accountName)`。

---

## 4. 边界与异常处理
1. **账号切换/重试**：
   - 当请求触发 429 发生 `immediateStatusRetry` 或轮询切号时，确保最后返回的 `X-Account-Name` 对应的是**实际成功处理请求的最终账号**。
2. **客户端提前断开（Client Abort��**：
   - 在 `res.headersSent` 或 `res.writableEnded` 为 true 时，不进行重复 Header 写入，避免触发 `ERR_HTTP_HEADERS_SENT`。
3. **空/无效账号名**：
   - 对 `accountName` 做类型与非空校验，未获取到时不注入该 Header，避免污染响应。

---

## 5. 测试与验证计划
1. **单元测试与集成测试**：
   - `test/request_account_header.test.js`：
     - 测试 Gemini 原生非流式与流式请求返回的 `X-Account-Name`。
     - 测试 OpenAI `/v1/chat/completions`（stream=true 与 stream=false）返回的 `X-Account-Name`。
     - 测试 Claude `/v1/messages`（stream=true 与 stream=false）返回的 `X-Account-Name`。
     - 测试 Embeddings 与 Upload 请求返回的 `X-Account-Name`。
     - 测试并发模式下不同请求分发到不同账号时，各自返回正确的 `X-Account-Name`。
     - 测试 OPTIONS 请求验证 `Access-Control-Expose-Headers` 包含 `x-account-name`。
2. **手动验证**：
   - 使用 `curl -i` 发起请求，检查响应头中 `X-Account-Name` 是否正确返回。
