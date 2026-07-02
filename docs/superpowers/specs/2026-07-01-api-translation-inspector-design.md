# 系统设计规格说明书（System Design Spec）：API 翻译对照调试器

本文档详细规划了 **AIStudioToAPI** 服务中，针对客户端原始请求与 Gemini 翻译转换链路的全链路 Payload 捕获及可视化对照调试器设计。该功能在允许 UI 面板中动态一键开启/关闭的同时，通过后端单 JSON 文件落盘设计与专属的 DELETE 清理接口，确保系统运行的高性能与磁盘自愈能力。

## 一、 系统架构与流程（Architecture & Control Flow）

本项目采用的架构旨在避免产生分散、零碎的小磁盘碎片。通过在请求生命周期（Response Lifecycle）暂存翻译片段，在请求结束时单次异步落盘完成。

```
+------------------------------------------------------------------------+
|                                  Frontend (Vue 3 UI)                   |
|                                                                        |
|  +--------------------+   +-----------------------+                    |
|  |  Inspector Switch  |   |   Inspector Dialog    |                    |
|  | [Enable/Disable]   |   | (4-pane VS Code View) |                    |
|  +---------+----------+   +-----------+-----------+                    |
+------------|--------------------------|--------------------------------+
             | PUT (Switch)             | GET (Read Payload)
             v                          v
+------------|--------------------------|--------------------------------+
|            v                          |                                |
|  +---------+----------+               |                                |
|  | /api/settings/...  |               |                                |
|  | /transactions/:id  | <-------------+                                |
|  +---------+----------+                                                |
|            |                                                           |
|            v Updates enableTranslationLogging                          |
|  +---------+----------+                                                |
|  |   RequestHandler   |                                                |
|  | (res.__transData)  |                                                |
|  +---------+----------+                                                |
|            |                                                           |
|            v Save single JSON (when done)                              |
|  +---------+----------+                                                |
|  |     Disk (JSON)    | <------------- DELETE /api/transactions        |
|  | (data/debug/*.json)|                (Purge all transaction logs)    |
|  +--------------------+                                                |
|                                                                        |
|                               Backend (Node.js)                        |
+------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

### 1. 后端：日志开关配置与热切换管理 (`ConfigLoader.js` & `StatusRoutes.js`)

在系统全局配置中引入 `enableTranslationLogging` 环境变量与控制开关，默认设为关闭，确保极佳的生产环境纯净性能。

*   **配置载入与环境隔离 (`src/utils/ConfigLoader.js`)**：
    *   在构造的默认配置字典中声明：`enableTranslationLogging: false`。
    *   在 `loadConfiguration()` 方法内读取并解析环境变量 `ENABLE_TRANSLATION_LOGGING`：
        ```javascript
        if (process.env.ENABLE_TRANSLATION_LOGGING) {
            config.enableTranslationLogging = process.env.ENABLE_TRANSLATION_LOGGING.toLowerCase() === "true";
        }
        ```
    *   在 `_printConfiguration()` 打印阶段中输出当前状态：`Translation Logging: Enabled/Disabled`。
*   **API 动态控制路由 (`src/routes/StatusRoutes.js`)**：
    *   **新增 API 路由 `PUT /api/settings/enable-translation-logging`**：
        用于接收前端请求，一键切换该全局变量的值，并输出日志：
        ```javascript
        app.put("/api/settings/enable-translation-logging", isAuthenticated, (req, res) => {
            this.config.enableTranslationLogging = !this.config.enableTranslationLogging;
            const statusText = this.config.enableTranslationLogging;
            this.logger.info(`[WebUI] Translation logging hot-switched to: ${statusText}`);
            res.status(200).json({ message: "settingUpdateSuccess", setting: "enableTranslationLogging", value: statusText });
        });
        ```
    *   在 `_getStatusData()` 的 `status` 返回体中新增 `enableTranslationLogging: config.enableTranslationLogging`，确保前端轮询时状态完全同步。

---

### 2. 后端：单 JSON 全生命周期捕获与落盘机制 (`src/core/RequestHandler.js`)

在客户端请求发起时动态建立挂载于 `res` 的内存字典，请求终结（触发 `finish` 或 `close` 事件，或者在 `STREAM_END` 后）时一次性完成异步序列化落盘，磁盘小碎片数减少为原本的 $1/4$。

*   **暂存字典初始化**：
    在 `RequestHandler` 的各个路由入口方法（如 `processOpenAIRequest`, `processClaudeRequest` 等）确定并生成 `requestId` 的第一步，挂载并预置以下结构于 `res`：
    ```javascript
    res.__transactionData = {
        client_req: req.body, // 客户端原始发包，自动记录
        gem_req: null,        // 转换后的 Google / Gemini 请求参数体
        gem_res: "",          // Gemini 的原生响应（非流式为完整 JSON / 流式为累加字符文本）
        client_res: ""        // 吐回给客户端的响应（非流式为完整 JSON / 流式为累加的 SSE 字符文本）
    };
    ```
*   **不同链路阶段数据写入**：
    *   **请求转换**：格式翻译（`FormatConverter.translate*`）成功后，将 `googleBody` 写入 `res.__transactionData.gem_req`。
    *   **流式响应（Real-stream / Fake-stream）**：
        在处理 SSE 分块迭代的循环（`_streamOpenAIResponse`, `_streamClaudeResponse` 等）中：
        *   当从 `messageQueue` 中拉取到 Gemini 原生数据块时，将其累加追加至 `res.__transactionData.gem_res`。
        *   当我们向客户端 `res.write` 吐出最终 translated chunk 文本时，将其累加追加至 `res.__transactionData.client_res`。
    *   **非流式响应**：
        当得到完整的 Google Response 时，直接赋值给 `gem_res`。
        当格式转换（如 `convertGoogleToOpenAINonStream`）完成准备发送（`res.send`）之前，直接赋值给 `client_res`。
*   **优雅关闭与异步落盘**：
    我们为 `res` 绑定一个 `finish` 或者是流结束的处理函数（如 `_finalizeTransaction(requestId, res)`）：
    ```javascript
    _saveTransactionPayload(requestId, res) {
        if (!this.config.enableTranslationLogging || !res.__transactionData) {
            return;
        }
        try {
            const debugDir = path.join(process.cwd(), "data", "debug");
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir, { recursive: true });
            }
            const filePath = path.join(debugDir, `transaction_${requestId}.json`);
            
            // 优雅美化 JSON 字符串
            const content = JSON.stringify(res.__transactionData, null, 2);
            fs.writeFile(filePath, content, "utf-8", () => {});
        } catch (err) {
            this.logger.debug(`[Debug] Failed to save transaction payload: ${err.message}`);
        } finally {
            res.__transactionData = null; // 确保释放引用防 GC 泄漏
        }
    }
    ```

---

### 3. 后端：专属查询与专项一键净化网关 (`src/routes/StatusRoutes.js`)

提供干净解耦、不掺杂 Snapshots 逻辑的查询与一键清理接口。

*   **数据查询 API `GET /api/transactions/:id`**：
    *   读取并返回 `data/debug/transaction_<id>.json` 的文件内容。
    *   如果文件不存在，返回 `404` 状态码和 `"transactionNotFound"` 国际化词条。
*   **专属一键净化 API `DELETE /api/transactions`**：
    *   管理员在 Web 面板点击“清除对照日志”时，后端直接读取 `data/debug/` 目录。
    *   过滤并删除所有以 `transaction_` 开头、并以 `.json` 结尾的文件。
    *   返回 `{ success: true, count: deletedCount, message: "transactionsPurgedSuccess" }`。

---

### 4. 前端：四栏 VS Code 风格对照弹窗与控制面板 (`StatusPage.vue`)

不污染正常列表，在用户点击时才弹窗加载，提供极佳的开发体验。

*   **控制台开关**：
    在 `StatusPage` 的“系统设置”面板，新增一个漂亮的 Element Plus `el-switch` 绑定 `state.enableTranslationLogging`，控制该调试功能的总启停。
*   **专属一键清理**：
    在请求记录表格上方新增一个带扫把图标的 `Purge Logs` / `一键清空对照日志` 的小按钮，绑定 `DELETE /api/transactions` API，带二次确认弹窗。
*   **表格 Action 触发放大镜**：
    *   在“请求记录”表格的最右侧追加一个带 magnifying-glass 图标的 `el-button`。
*   **四重对照视窗弹窗 (Inspector Dialog)**：
    *   点击时弹窗展示，通过 `v-loading` 渲染骨架屏。
    *   以 VS Code 暗黑编辑器风格（可以使用带有 `.inspector-code-card` 的 textarea 或者 pre 布局，加上漂亮的单色背景与等宽字体）两排两栏展示：
        1. `Client Request` (左上)  |  3. `Gemini Output` (右上)
        2. `Gemini Input` (左下)    |  4. `Client Output` (右下)
    *   每个板块都带有一键 `Copy to clipboard` 的复制按钮。

---

## 三、 多语言词条（Locales）

#### 英文 (`en.json`)
```json
{
    "apiTranslationInspector": "API Translation Inspector",
    "clientRequest": "Client Request",
    "geminiInput": "Gemini Input",
    "geminiOutput": "Gemini Output",
    "clientOutput": "Client Output",
    "enableTranslationLogging": "Enable Translation Logging",
    "transactionsPurgedSuccess": "Successfully purged {count} translation logs.",
    "transactionNotFound": "Transaction log file not found.",
    "btnPurgeTransactions": "Purge Logs",
    "confirmPurgeTransactions": "Are you sure you want to delete all transaction log files? This action cannot be undone.",
    "copyPayload": "Copy Payload"
}
```

#### 中文 (`zh.json`)
```json
{
    "apiTranslationInspector": "API 翻译对照调试器",
    "clientRequest": "客户端原始请求",
    "geminiInput": "翻译后 Gemini 输入",
    "geminiOutput": "Gemini 原始返回",
    "clientOutput": "吐回客户端响应",
    "enableTranslationLogging": "启用 API 转换落盘调试",
    "transactionsPurgedSuccess": "成功清理了 {count} 个转换调试日志文件。",
    "transactionNotFound": "未找到对应的转换调试日志文件。",
    "btnPurgeTransactions": "清空对照日志",
    "confirmPurgeTransactions": "确定要删除所有的 API 翻译对照调试日志文件吗？此操作无法撤销。",
    "copyPayload": "复制报文"
}
```
