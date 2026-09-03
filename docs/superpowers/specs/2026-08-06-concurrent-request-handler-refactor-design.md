# Spec: ConcurrentRequestHandler.handleGeminiRequest 代码重构与去掉重试逻辑

**日期:** 2026-08-06
**状态:** 已批准 (Approved)

---

## 1. 需求与背景

目前并发模式请求处理器 `ConcurrentRequestHandler.js` 中的 `handleGeminiRequest` 函数过于臃肿（单函数近 380 行），且混合了路径解析、请求转换、重试循环、断言处理和响应转换等多重职责。

根据对原项目非并发模式（`RequestHandler.js`）的对比分析，原项目并没有服务端跨账号重试循环。为了保持设计精简与控制流清晰，我们将：
1. **彻底去掉跨账号重试逻辑**（移除 `while (attempt < maxAttempts)` 循环），请求失败时直接记录失败并向客户端返回错误。
2. **模块化重构 `handleGeminiRequest`**：将其拆分为请求构造、响应转换与主控制流三个独立私有方法，提高代码可读性与维护性。

---

## 2. 详细设计

### 2.1 拆分方法结构

在 `ConcurrentRequestHandler.js` 中新增两个私有辅助方法：

#### 1. `_buildProxyRequestPayload(req, requestId)`
负责解析原生 Gemini 请求的所有路径后缀与 Body 配置，生成规范化的 Payload：
- 提取并清理模型后缀，生成不含后缀的 `cleanPath` 和 `cleanModelName`。
- 注入 `thinkingLevel` 与 `forceThinking`。
- 调用 `ensureThoughtSignature` 和 `sanitizeGeminiTools`。
- 注入内置工具（`googleSearch` / `codeExecution` / `urlContext`）与默认安全设置（`safetySettings`）。
- 改写 `embedContent` 为 `batchEmbedContents` 并设置 `responseTransform: "batchEmbedToEmbedContent"`。
- 返回 `{ cleanModelName, cleanPath, isStream, requestBodyObj, responseTransform, streamingMode }`。

#### 2. `_sendResponseChunk(chunk, isFinished, isError, responseTransform, isStream, meta, res)`
负责响应数据的逆向还原与客户端发送：
- 若 `responseTransform === "batchEmbedToEmbedContent"`，逆向提取 `chunk.embeddings[0]`。
- 处理图片 `inlineData` Part 转换为 Markdown Data URL（同时覆盖流式与非流式）。
- 统一处理 HTTP SSE / JSON 数据分发与 Error 响应。

#### 3. 精简 `handleGeminiRequest(req, res)`
主方法精简为单次分发架构：
1. 调用 `_buildProxyRequestPayload(req, requestId)` 构造请求体。
2. 上报监控状态 `startRequest`。
3. 调用 `scheduler.getNextAuthIndex(payload.cleanModelName)` 获取一次可用账号（无重试循环）。
4. 管理在途数 `acquireInFlight` / `releaseInFlight` 与断开连接取消监听 `res.on("close")`。
5. 调用 `connectionRegistry.sendRequest`，在回调中将响应处理转交给 `_sendResponseChunk`。
6. `finally` 块中释放在途数并触发 `checkAndRetireAccount`。

---

## 3. 验证方案

1. 运行并发单元测试套件：`npx jest test/concurrent/`，确保所有 61+ 门测试全部 PASS。
2. 运行 `npm run lint:js`，确保 0 Error 完美符合 ESLint 规范。
