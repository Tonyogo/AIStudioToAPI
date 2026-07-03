# 系统设计规格说明书（System Design Spec）：API 翻译思想签名缓存控制优化

本文档详细规划了 **AIStudioToAPI** 服务中，针对 Google Gemini 3.5 思想签名（`thoughtSignature`）缓存机制的开关控制优化设计。该设计支持通过环境变量 `ENABLE_SIGNATURE_CACHE` 动态控制是否在多轮对话中记录并注入真实签名，在开关关闭（默认）时，上行请求彻底不传入 `thoughtSignature` 字段，实现最高兼容性的纯净数据结构。

## 一、 系统架构与流程（Toggle Logic Design）

系统根据 `enableSignatureCache` 全局配置，对 FormatConverter 转换引擎的上行和下行流向实施分流拦截：

```
+------------------------------------------------------------------------+
|                                  ConfigLoader.js                       |
|                                                                        |
|                 Loads ENABLE_SIGNATURE_CACHE from .env                 |
|                   (defaults to false / Disabled)                       |
+------------------------------------------------------------------------+
                                  |
                                  v Exposes config.enableSignatureCache
+------------------------------------------------------------------------+
|                               FormatConverter.js                       |
|                                                                        |
|  - In translateGoogleToClaudeStream / convertGoogleToClaudeNonStream:  |
|    IF enableSignatureCache is true:                                    |
|       Store part.thoughtSignature into toolIdToSignatureMap            |
|                                                                        |
|  - In translateClaudeToGoogle:                                         |
|    IF enableSignatureCache is true:                                    |
|       Retrieve signature from toolIdToSignatureMap or fallback         |
|    ELSE:                                                               |
|       Completely omit thoughtSignature field (do not send)             |
+------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

### 1. 后端：系统配置读取与状态同步 (`ConfigLoader.js` & `StatusRoutes.js`)

*   **配置属性扩展 (`src/utils/ConfigLoader.js`)**：
    *   在默认配置字典中声明：`enableSignatureCache: false`（**默认关闭**）。
    *   在 `loadConfiguration()` 方法内读取并解析环境变量 `ENABLE_SIGNATURE_CACHE`：
        ```javascript
        if (process.env.ENABLE_SIGNATURE_CACHE) {
            config.enableSignatureCache = process.env.ENABLE_SIGNATURE_CACHE.toLowerCase() === "true";
        }
        ```
    *   在 `_printConfiguration()` 打印阶段中输出当前状态：`Signature Cache: Enabled/Disabled`。
*   **状态同步路由 (`src/routes/StatusRoutes.js`)**：
    *   在 `_getStatusData()` 的 `status` 返回体中新增 `enableSignatureCache: config.enableSignatureCache`，保持状态响应。

---

### 2. 后端：数据流转换开关拦截分流 (`src/core/FormatConverter.js`)

在下行缓存阶段与上行历史节点还原阶段，挂载开关分流器：

*   **下行写入阶段拦截**（流式 `translateGoogleToClaudeStream` 与非流式 `convertGoogleToClaudeNonStream`）：
    ```javascript
    const enableCache = this.serverSystem.config.enableSignatureCache;
    if (enableCache && typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
        this.toolIdToSignatureMap.set(toolUseId, part.thoughtSignature);
    }
    ```
*   **上行读取还原阶段拦截**（`translateClaudeToGoogle`）：
    在还原助理历史消息 `block.type === "tool_use"` 组装 `functionCall` 结构时：
    ```javascript
    if (block.type === "tool_use") {
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

        // 开关分流拦截
        const enableCache = this.serverSystem.config.enableSignatureCache;
        if (enableCache) {
            const savedSignature = this.toolIdToSignatureMap.get(block.id);
            functionCallPart.thoughtSignature = savedSignature || FormatConverter.DUMMY_THOUGHT_SIGNATURE;
        }
        // 注意：若 enableCache 为 false，则 functionCallPart.thoughtSignature 属性完全不声明，即彻底不传入该字段
        
        googleParts.push(functionCallPart);
    }
    ```

---

## 三、 验证与测试（Verification & Test）

1.  **开关关闭测试（默认行为）**：
    不配置 `.env` 环境变量，向服务发起翻译请求。
    *   验证控制台打印：`Signature Cache: false`。
    *   通过 API 翻译对照调试器查看 `gem_req`（Gemini 历史发包），验证其 `contents` 下的历史 `model` 消息中**完全没有 `thoughtSignature` 字段**。
2.  **开关开启测试**：
    配置 `ENABLE_SIGNATURE_CACHE=true` 启动服务，发起翻译请求。
    *   验证控制台打印：`Signature Cache: true`。
    *   通过 API 翻译对照调试器查看 `gem_req`，验证其历史 `model` 消息中**含有与其本轮生成完全一致的、动态拉取而出的 `thoughtSignature`**。
3.  **代码合规性检验**：
    运行 `npx eslint` 确保修改后文件的格式及 Props 参数字母序排列完美通过。
