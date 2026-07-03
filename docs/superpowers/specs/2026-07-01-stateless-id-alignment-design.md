# 系统设计规格说明书（System Design Spec）：API 翻译无状态 ID 对齐优化

本文档详细规划了 **AIStudioToAPI** 服务中，针对 Google Gemini 与 Claude 协议转换中工具调用 ID（Tool Call ID）的双向无状态对齐方案。该功能通过将 Google 原生 `id` 编码进 Claude 的 `tool_use_id` 并辅以 `toolu_g_` 专属标识，实现了 100% 内存干净、防止垃圾回收泄露的高可用代理网关架构。

## 一、 系统架构与编解码流程（Stateless Codec Flow）

由于 Claude 的工具执行返回 `tool_result` 会在下一轮请求中原封不动地将 `tool_use_id` 吐回。我们无需在后端分配任何有状态的 Map，而是直接通过在 ID 字符串内嵌套 Google 真实短 ID 的方式完成数据流闭环：

```
+-------------------------------------------------------------------------+
|                              下行翻译 (Downstream)                      |
|                                                                         |
|    Gemini FunctionCall (id: "kc0e8m7m")                                 |
|                     |                                                   |
|                     v Encode: "toolu_g_" + id                           |
|    Claude ToolUse (id: "toolu_g_kc0e8m7m")                              |
+-------------------------------------------------------------------------+
                                  |
                                  | Returned by Client on next turn
                                  v
+-------------------------------------------------------------------------+
|                              上行翻译 (Upstream)                        |
|                                                                         |
|    Claude ToolResult (tool_use_id: "toolu_g_kc0e8m7m")                  |
|                     |                                                   |
|                     v Decode: Starts with "toolu_g_" ? substring(8)     |
|    Gemini FunctionResponse (id: "kc0e8m7m")                             |
+-------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

我们仅需要对 `/Users/yogo/WebstormProjects/AIStudioToAPI/src/core/FormatConverter.js` 的编解码算法进行修改。

### 1. 编码模块设计（Google -> Claude）

在下行返回中，我们将 Gemini 签发的原生 `id`（一串随机短字母，例如 `kc0e8m7m`）提取出来，并编码至 `tool_use_id`。

*   **非流式转换 `convertGoogleToClaudeNonStream` 改造**：
    ```javascript
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
*   **流式分块转换 `translateGoogleToClaudeStream` 改造**：
    ```javascript
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
            index: streamState.contentBlockIndex,
            type: "content_block_start",
        });
        // ...
    }
    ```

### 2. 解码模块设计（Claude -> Google）

在上行协议转换中，我们通过前缀字符串校验来判断该 `tool_use_id` 是否是由本系统代理转换而出的。如果是，进行无状态切片；如果是第三方传入或降级，进行安全透传。

*   **User 消息还原 `translateClaudeToGoogle` 改造**：
    当把客户端发回的 `tool_result` 转换为 Gemini 的 `functionResponse` 时：
    ```javascript
    const toolUseId = toolResult.tool_use_id;
    // 使用 toolu_g_ 特殊标识无状态解码
    const originalId = (typeof toolUseId === "string" && toolUseId.startsWith("toolu_g_"))
        ? toolUseId.substring(8)
        : toolUseId;

    pendingToolParts.push({
        functionResponse: {
            name: functionName,
            response: responseContent,
            ...(originalId && { id: originalId }), // 注入还原后的 Google id
        },
    });
    ```
*   **Model 历史消息还原 `translateClaudeToGoogle` 改造**：
    当把历史 Assistant 发出的 `tool_use` 重新转换为 Gemini 的历史 `functionCall` 时进行双向对齐：
    ```javascript
    if (block.type === "tool_use") {
        // 使用 toolu_g_ 特殊标识无状态解码
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
    ```

---

## 三、 验证与测试（Verification & Test）

1.  **高并发自愈测试**：
    在一轮对话中触发 10 次并行的 Tool calls 模拟，验证所有的 `functionResponse.id` 能完美与 `functionCall.id` 一一配对，Gemini 3.5 正常响应且不返回任何 empty blocks。
2.  **第三方降级透传测试**：
    传入未包含 `toolu_g_` 前缀的自定义字符串 ID，验证在还原时正常透传该 ID 原值且后端不发生任何数组越界或字符串切片崩溃错误。
