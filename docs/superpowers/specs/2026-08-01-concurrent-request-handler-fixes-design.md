# ConcurrentRequestHandler 核心异常与状态码透传修复设计 (方案 B)

**日期:** 2026-08-01  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在并发模式下，`src/concurrent/ConcurrentRequestHandler.js` 负责拦截并透传原生 Gemini API 请求。相比原系统的 `RequestHandler.js`，目前 ConcurrentRequestHandler 在响应状态码透传、异常错误码保持以及客户端断开连接取消机制上存在缺失。

本设计文档采用 **方案 B (轻量修复)**，旨在补全核心异常处理、真实 HTTP 状态码/Header 透传以及客户端断开中途取消机制，确保并发模式在请求和响应接口行为上与 Google Gemini API 规范保持一致。

---

## 2. 详细变更与设计

### 2.1 响应状态码与 Header 记录

在 `_sendRequestImpl` 的 WebSocket 消息循环中：
1. 增加 `responseStatus = 200` 和 `responseHeaders = {}` 局部变量。
2. 当收到 `message.event_type === "response_headers"` 时：
   - 解析并保存 `message.status`（若不存在则默认为 200）。
   - 保存 `message.headers`。
3. 在请求完成回调时：
   - 将 `responseStatus` 与 `responseHeaders` 传回 `handleGeminiRequest` 外部处理函数。

### 2.2 非流式与流式响应状态码设置

在 `handleGeminiRequest` 的回调处理中：
1. **非流式响应 (Non-Streaming)**：
   - 使用从 `response_headers` 中提取的真实状态码 `res.status(responseStatus).json(body)`，不再硬编码 `res.status(200)`。
2. **流式响应 (Streaming)**：
   - 若 `responseStatus >= 400`，说明后端在初始化阶段即报错（如 429 Too Many Requests / 400 Bad Request），此时若 `!res.headersSent`，直接返回对应的 JSON 错误对象与真实 HTTP 状态码，而不是输出 SSE 数据。

### 2.3 错误响应状态码与 Payload 修正

1. 当 WebSocket 收到 `message.event_type === "error"` 时：
   - 提取 `message.status`（若无则降级为 500）。
   - 回调通知 `isError = true` 并带上 `status` 码。
2. `handleGeminiRequest` 接收到错误时：
   - 若 `!res.headersSent`，返回 `res.status(status).json({ error: { code: status, message: msg, status: statusText } })`。
   - `statusText` 映射：`429` -> `RESOURCE_EXHAUSTED`，`400` -> `INVALID_ARGUMENT`，`503` -> `UNAVAILABLE`，默认 -> `INTERNAL`。

### 2.4 客户端断开连接取消机制 (Client Disconnect Handler)

在 `handleGeminiRequest` 中：
1. 监听 Express 响应对象的 `res.on("close")` 事件。
2. 如果 `!res.writableEnded` 且请求尚未收到 `isFinished` 信号（说明客户端中途主动断开/取消）：
   - 构造 `cancel_request` 消息并通过 WebSocket 发送至对应的账号 context：
     ```json
     {
       "event_type": "cancel_request",
       "request_id": requestId,
       "request_attempt_id": requestAttemptId
     }
     ```
   - 记录日志并及时清理 `MessageQueue`，通知浏览器端 AI Studio 中止后台请求，避免浪费账号额度。

---

## 3. 受影响模块与文件

* `src/concurrent/ConcurrentRequestHandler.js`：核心实现文件。
* `test/concurrent/concurrent_request_handler.test.js`：更新和扩充单元测试，覆盖状态码透传与取消逻辑。
* `test/concurrent/integration.test.js`：扩展集成测试逻辑。

---

## 4. Spec 自查与验证

* [x] **无占位符**：方案细节明确，逻辑与字段完整。
* [x] **逻辑一致**：状态码映射与原 RequestHandler 的 Gemini 格式错误结构完全一致。
* [x] **范围聚焦**：仅针对 Core Exceptions、Status Code Passthrough 及 Client Disconnect，无不相关改动。
