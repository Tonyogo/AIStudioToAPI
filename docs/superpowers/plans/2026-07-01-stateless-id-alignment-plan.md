# API 翻译无状态 ID 对齐优化（API Translation Stateless ID Alignment） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现工具调用 ID（Tool Call ID）的双向无状态对齐。在向 Claude 发包时将 Google 原生的短 `id` 拼接前缀 `toolu_g_` 编码，并在翻译回 Google 历史节点或回包时进行无状态切片还原。

**Architecture:** 
- **编码 (Downstream)**：在 `convertGoogleToClaudeNonStream` 与 `translateGoogleToClaudeStream` 中，如果 part.functionCall.id 存在，编码生成 `toolu_g_<id>`。
- **解码 (Upstream)**：在 `translateClaudeToGoogle` 的历史 Model 节点 `functionCall` 还原和历史 User 节点 `functionResponse` 还原中，截取还原 `substring(8)`。对于非法前缀进行安全透传 fallback。

**Tech Stack:** Node.js (Express), JavaScript (ESLint).

## Global Constraints

- **无状态设计**：100% 避免使用临时内存 Map，纯粹依靠字符串编码完成 ID 对齐，防止 GC 溢出。
- **完全兼容第三方**：如果 ID 不满足 `toolu_g_` 特殊标识，无条件退回使用透传，保障向下兼容。

---

### Task 1: 实现下行 Gemini -> Claude 原生 ID 专属编码

**Files:**
- Modify: `src/core/FormatConverter.js`

**Interfaces:**
- Produces:
  - `toolu_g_<id>` as Claude `tool_use` IDs inside responses

- [ ] **Step 1: 改造流式下行 translateGoogleToClaudeStream 编码算法**

  定位到 `src/core/FormatConverter.js` 的 `translateGoogleToClaudeStream` 中处理 `part.functionCall` 的分支（约 line 2835 附近）：
  ```javascript
  // 修改后（对应 src/core/FormatConverter.js）
  } else if (part.functionCall) {
      // Tool use
      const nativeId = part.functionCall.id;
      const toolUseId = (typeof nativeId === "string" && nativeId.length > 0)
          ? `toolu_g_${nativeId}`
          : `toolu_${this._generateRequestId()}`;

      events.push({
          content_block: {
              id: toolUseId,
              input: {},
              name: part.functionCall.name,
              type: "tool_use",
          },
  ```

- [ ] **Step 2: 改造非流式下行 convertGoogleToClaudeNonStream 编码算法**

  定位到 `src/core/FormatConverter.js` 的 `convertGoogleToClaudeNonStream` 中处理 `part.functionCall` 的分支（约 line 2975 附近）：
  ```javascript
  // 修改后（对应 src/core/FormatConverter.js）
  } else if (part.functionCall) {
      hasToolUse = true;
      const nativeId = part.functionCall.id;
      const toolUseId = (typeof nativeId === "string" && nativeId.length > 0)
          ? `toolu_g_${nativeId}`
          : `toolu_${this._generateRequestId()}`;

      content.push({
          id: toolUseId,
          input: part.functionCall.args || {},
          name: part.functionCall.name,
          type: "tool_use",
      });
  }
  ```

- [ ] **Step 3: 语法验证与提交**

  Run: `node -e "require('./src/core/FormatConverter.js')"`
  Expected: 无语法报错。

  ```bash
  git add src/core/FormatConverter.js
  git commit -m "feat(adapter): encode Google functionCall.id into Claude tool_use.id using toolu_g_ prefix"
  ```

---

### Task 2: 实现上行 Claude -> Gemini 历史与回包双向解码还原

**Files:**
- Modify: `src/core/FormatConverter.js`

**Interfaces:**
- Produces:
  - Decoded original `id` back into Gemini `functionCall` and `functionResponse`

- [ ] **Step 1: 改造历史 User 节点的 functionResponse.id 解码还原**

  定位到 `src/core/FormatConverter.js` 中处理 `tool_result` 且填充 `pendingToolParts` 对象的代码块（约 line 2300 附近）：
  ```javascript
  // 修改后（对应 src/core/FormatConverter.js）
  for (const toolResult of toolResults) {
      const responseContent = normalizeClaudeToolResultContent(toolResult.content);

      // Resolve function name using the map
      const toolUseId = toolResult.tool_use_id;
      let functionName = toolIdToNameMap.get(toolUseId);

      if (!functionName) {
          this.logger.warn(
              `[Adapter] Warning: Tool name resolution failed for ID: ${toolUseId}. outputting as unknown_function`
          );
          functionName = "unknown_function";
      }

      // 解码并还原原生的 functionResponse.id
      const originalId = (typeof toolUseId === "string" && toolUseId.startsWith("toolu_g_"))
          ? toolUseId.substring(8)
          : toolUseId;

      pendingToolParts.push({
          functionResponse: {
              name: functionName,
              response: responseContent,
              ...(originalId && { id: originalId }), // 注入原始 Google ID
          },
      });
  }
  ```

- [ ] **Step 2: 改造历史 Assistant 节点的 functionCall.id 解码还原**

  定位到 `src/core/FormatConverter.js` 中处理 `message.role === "assistant"` 时处理 `block.type === "tool_use"` 的对象组装区（约 line 2355 附近）：
  ```javascript
  // 修改后（对应 src/core/FormatConverter.js）
  if (block.type === "tool_use") {
      // 判定特殊标识并解码
      const originalId = (typeof block.id === "string" && block.id.startsWith("toolu_g_"))
          ? block.id.substring(8)
          : block.id;

      const functionCallPart = {
          functionCall: {
              args: block.input || {},
              name: block.name,
              ...(originalId && { id: originalId }), // 还原原生 ID
          },
      };
      if (!signatureAttachedToCall) {
          const savedSignature = this.toolIdToSignatureMap.get(block.id);
          functionCallPart.thoughtSignature = savedSignature || FormatConverter.DUMMY_THOUGHT_SIGNATURE;
          signatureAttachedToCall = true;
      }
      googleParts.push(functionCallPart);
  }
  ```

- [ ] **Step 3: 最终自愈性 Lint、测试编译与提交**

  对 `FormatConverter.js` 进行完整的 ESLint 格式及 sorting-keys 验证：
  Run: `npx eslint src/core/FormatConverter.js --fix`
  Expected: 0 错误。

  Vite 生产包编译验证：
  Run: `npm run build:ui`
  Expected: 成功打出生产包。

  ```bash
  git add src/core/FormatConverter.js
  git commit -m "feat(adapter): decode and restore original Google functionCall/functionResponse id seamlessly from Claude tool_use_id"
  ```
