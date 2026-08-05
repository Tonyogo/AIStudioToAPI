# Spec: 并发模式下支持通过模型后缀名设置 THINKING_LEVEL

**日期:** 2026-08-05
**状态:** 已批准 (Approved)

---

## 1. 需求与背景

AIStudioToAPI 的主请求处理器 (`RequestHandler.js`) 和格式转换器 (`FormatConverter.js`) 已经支持在模型名称后缀中使用括号格式（如 `gemini-3-flash-preview(minimal)`）或连字符格式（如 `gemini-3-flash-preview-high`）来指定 `thinkingLevel`（可选值：`MINIMAL` / `LOW` / `MEDIUM` / `HIGH`）。

但在并发模式下（`ENABLE_CONCURRENT=true`），`ConcurrentRequestHandler.js` 在提取清洁模型名后，未将解析出的 `thinkingLevel` 以及内置工具后缀（`forceWebSearch` / `forceCodeExecution`）注入回原生 Gemini API 的请求体（`req.body`）中，导致并发请求无法通过模型名称后缀灵活切换思考等级。

本设计旨在补齐 `ConcurrentRequestHandler.js` 中的该功能，使其在并发转发原生 Gemini 请求时行为与单账号模式完全一致。

---

## 2. 详细设计

### 2.1 修改 `src/concurrent/ConcurrentRequestHandler.js`

1. **改造 `_extractCleanModelName` 及后缀解析逻辑**：
   在 `handleGeminiRequest(req, res)` 中，直接解析 `req.path` 的模型后缀信息：
   ```javascript
   const {
       cleanModelName: toolStripped,
       forceCodeExecution: modelForceCodeExecution,
       forceWebSearch: modelForceWebSearch,
   } = FormatConverter.parseModelBuiltInToolSuffixes(req.path);
   const { cleanModelName: streamStripped } = FormatConverter.parseModelStreamingModeSuffix(toolStripped);
   const { cleanModelName, thinkingLevel: modelThinkingLevel } = FormatConverter.parseModelThinkingLevel(streamStripped);
   ```

2. **注入 `thinkingLevel` 到请求体**：
   在序列化 `requestBodyStr` 前，如果解析到了 `modelThinkingLevel`，则更新 `req.body`：
   ```javascript
   if (req.method === "POST" && req.body && typeof req.body === "object") {
       if (modelThinkingLevel) {
           if (!req.body.generationConfig) {
               req.body.generationConfig = {};
           }
           if (!req.body.generationConfig.thinkingConfig) {
               req.body.generationConfig.thinkingConfig = {};
           }
           req.body.generationConfig.thinkingConfig.thinkingLevel = modelThinkingLevel;
       }
   }
   ```

3. **同步支持工具后缀标志（`forceWebSearch` / `forceCodeExecution`）**：
   若包含 `-search` 或 `-code` 后缀，同样在 `req.body.tools` 中注入对应的工具配置，确保全面对齐 `RequestHandler.js` 的行为。

---

## 3. 验证方案

1. 在 `test/concurrent/concurrent_request_handler.test.js` 中增加针对带思考等级后缀（如 `/v1beta/models/gemini-3-flash-preview-minimal:generateContent`）的单元测试。
2. 验证 WebSocket 发送的请求 payload 中：
   - 包含 `"generationConfig": { "thinkingConfig": { "thinkingLevel": "MINIMAL" } }`。
   - 调度给 `AccountScheduler` 的模型名称为纯净的 `gemini-3-flash-preview`。
3. 运行 `npx jest test/concurrent/` 确保所有用例通过。
4. 运行 `npm run lint:js` 保证 0 错误。
