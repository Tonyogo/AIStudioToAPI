# API 翻译对照调试器（API Translation Inspector） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现客户端原始请求与 Gemini 翻译转换链路的全链路 Payload 捕获及可视化对照调试器面板，并且提供一键清空和落盘日志开关功能，对后端性能实现零 Overhead 干扰。

**Architecture:** 
- **捕获层 (`RequestHandler.js`)**：在请求生命周期的起止点，分别将 `client_req`, `gem_req`, `gem_res`, `client_res` 暂存到 `res.__transactionData` 中，在连接断开或完成时通过一键落盘函数进行异步落盘（存入 `data/debug/transaction_<requestId>.json`）。
- **开关机制 (`ConfigLoader.js` & `StatusPage.vue`)**：提供全局控制开关 `enableTranslationLogging`。默认关闭，开启时执行落盘，关闭时为纯内存流，完全无磁盘 I/O 负担。
- **清理与查询 (`StatusRoutes.js` & `StatusPage.vue`)**：提供专属 API `GET /api/transactions/:id` 供前端弹窗查询；以及 `DELETE /api/transactions` 一键净化所有磁盘 transaction JSON 碎片。

**Tech Stack:** Node.js (Express), Vue.js 3, Element Plus, Less.

## Global Constraints

- **无需重启服务**：落盘日志调试开关更新支持热加载，无需重启进程。
- **零 Overhead 设计**：不开启开关时，完全没有任何磁盘写入产生，极度轻量。
- **单 JSON 落盘**：每次请求仅落盘单份 JSON 文件，大幅减少 inode 消耗。

---

### Task 1: 扩展 ConfigLoader.js 与 StatusRoutes.js 的开关热控

**Files:**
- Modify: `src/utils/ConfigLoader.js`
- Modify: `src/routes/StatusRoutes.js`

**Interfaces:**
- Produces:
  - `config.enableTranslationLogging` (boolean)
  - `PUT /api/settings/enable-translation-logging` -> { message, setting, value }
  - `GET /api/transactions/:id` -> { client_req, gem_req, gem_res, client_res }
  - `DELETE /api/transactions` -> { success, count, message }

- [ ] **Step 1: 扩展 ConfigLoader.js 加载开关变量**

  在 `src/utils/ConfigLoader.js` 的 `loadConfiguration()` 中，在 `config` 默认字典里添加 `enableTranslationLogging: false`（约 line 45 附近）。
  并在环境变量加载逻辑尾部添加读取 `ENABLE_TRANSLATION_LOGGING` 逻辑：
  ```javascript
  // 修改后（对应 src/utils/ConfigLoader.js）
  if (process.env.ENABLE_TRANSLATION_LOGGING) {
      config.enableTranslationLogging = process.env.ENABLE_TRANSLATION_LOGGING.toLowerCase() === "true";
  }
  ```
  并在 `_printConfiguration(config)`（约 line 210）中打印该状态：
  ```javascript
  this.logger.info(`  Translation Logging: ${config.enableTranslationLogging}`);
  ```

- [ ] **Step 2: 在 StatusRoutes.js 注册控制开关和查询/删除路由**

  在 `src/routes/StatusRoutes.js` 的 `setupRoutes` 方法中添加三个新端点：
  ```javascript
  // 1. 动态开关接口
  app.put("/api/settings/enable-translation-logging", isAuthenticated, (req, res) => {
      this.config.enableTranslationLogging = !this.config.enableTranslationLogging;
      const statusText = this.config.enableTranslationLogging;
      this.logger.info(`[WebUI] Translation logging hot-switched to: ${statusText}`);
      res.status(200).json({ message: "settingUpdateSuccess", setting: "enableTranslationLogging", value: statusText });
  });

  // 2. 交易数据单项查询接口
  app.get("/api/transactions/:id", isAuthenticated, async (req, res) => {
      const requestId = req.params.id;
      if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) {
          return res.status(400).json({ message: "errorInvalidIndex" });
      }

      const filePath = path.join(process.cwd(), "data", "debug", `transaction_${requestId}.json`);
      if (!fs.existsSync(filePath)) {
          return res.status(404).json({ message: "transactionNotFound" });
      }

      try {
          const content = await fs.promises.readFile(filePath, "utf-8");
          res.setHeader("Content-Type", "application/json");
          res.status(200).send(content);
      } catch (err) {
          this.logger.error(`[WebUI] Failed to read transaction ${requestId}: ${err.message}`);
          res.status(500).json({ error: err.message, message: "transactionNotFound" });
      }
  });

  // 3. 专属一键清理接口
  app.delete("/api/transactions", isAuthenticated, async (req, res) => {
      const debugDir = path.join(process.cwd(), "data", "debug");
      if (!fs.existsSync(debugDir)) {
          return res.status(200).json({ success: true, count: 0, message: "transactionsPurgedSuccess" });
      }

      try {
          const files = await fs.promises.readdir(debugDir);
          const transFiles = files.filter(file => /^transaction_.*\.json$/.test(file));
          let count = 0;
          for (const file of transFiles) {
              await fs.promises.unlink(path.join(debugDir, file));
              count++;
          }
          this.logger.info(`[WebUI] Purged ${count} API translation logs from data/debug/`);
          res.status(200).json({ success: true, count, message: "transactionsPurgedSuccess" });
      } catch (err) {
          this.logger.error(`[WebUI] Failed to purge transaction logs: ${err.message}`);
          res.status(500).json({ error: err.message, message: "errorOperationFailed" });
      }
  });
  ```

- [ ] **Step 3: 改造 _getStatusData 返回开关状态**

  在 `src/routes/StatusRoutes.js` 的 `_getStatusData()` 返回体 `status` 块中，添加 `enableTranslationLogging` 属性：
  ```javascript
  // 修改后（对应 src/routes/StatusRoutes.js）
  return {
      logCount: displayLogs.length,
      logs: displayLogs.join("\n"),
      status: {
          accountDetails,
          // ... 
          enableTranslationLogging: config.enableTranslationLogging, // 新增
          forceCodeExecution: config.forceCodeExecution,
          // ...
      }
  };
  ```

- [ ] **Step 4: 语法验证与提交**

  Run: `node -e "require('./src/routes/StatusRoutes.js')"`
  Expected: 无语法错误。

  ```bash
  git add src/utils/ConfigLoader.js src/routes/StatusRoutes.js
  git commit -m "feat(routes): add API Translation Inspector toggle, query, and delete endpoints with status synchronization"
  ```

---

### Task 2: 改造 RequestHandler.js 实现内存拦截与落盘

**Files:**
- Modify: `src/core/RequestHandler.js`

**Interfaces:**
- Produces:
  - `this._saveTransactionPayload(requestId, type, data)` helper

- [ ] **Step 1: 在 RequestHandler 末尾添加 _saveTransactionPayload 核心落盘逻辑**

  打开 `src/core/RequestHandler.js`，在类尾部添加 `_saveTransactionPayload` 接口。该接口不仅要能安全序列化数据，还要在请求结束时优雅合并：
  ```javascript
  _saveTransactionPayload(requestId, type, data) {
      if (!this.config.enableTranslationLogging) {
          return;
      }
      try {
          const debugDir = path.join(process.cwd(), "data", "debug");
          if (!fs.existsSync(debugDir)) {
              fs.mkdirSync(debugDir, { recursive: true });
          }
          const filePath = path.join(debugDir, `transaction_${requestId}.json`);

          let existingData = {};
          if (fs.existsSync(filePath)) {
              try {
                  existingData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
              } catch (e) {
                  // Fallback
              }
          }

          let formattedData = data;
          if (typeof data === "string") {
              try {
                  formattedData = JSON.parse(data);
              } catch (e) {
                  // Plain text fallback (for chunks)
              }
          }

          // If incremental chunk payload for response, append it!
          if (type === "gem_res" || type === "client_res") {
              const currentVal = existingData[type] || "";
              if (typeof formattedData === "string") {
                  existingData[type] = currentVal + formattedData;
              } else {
                  existingData[type] = formattedData;
              }
          } else {
              existingData[type] = formattedData;
          }

          fs.writeFileSync(filePath, JSON.stringify(existingData, null, 2), "utf-8");
      } catch (err) {
          this.logger.debug(`[Debug] Failed to save transaction payload: ${err.message}`);
      }
  }
  ```

- [ ] **Step 2: 对 RequestHandler.js 进行多生命周期切片注入**

  在各个 API 接口核心逻辑的流式/非流式分水岭，注入 Payload 捕获：

  1.  **OpenAI Request 阶段 (`processOpenAIRequest`)**：
      *   捕获 `open_req`（Client 请求包）：在进入翻译之前。
      *   捕获 `gem_req`（翻译后 Gemini 包）：在 `googleBody` 生成之后。
      *   在非流式成功结束前，捕获 `gem_res`（Gemini 返回）和 `open_res`（最终返回包）。
  2.  **Claude Request 阶段 (`processClaudeRequest` / `processClaudeRequestDirect`)**：
      *   捕获 `claude_req` 与 `gem_req`。
      *   非流式返回前，捕获 `gem_res` 与 `claude_res`。
  3.  **OpenAI Response Request 阶段 (`processOpenAIResponseRequest`)**：
      *   捕获 `open_req` 与 `gem_req`。
  4.  **流式累加器注入 (`_streamOpenAIResponse`, `_streamOpenAIResponseAPIResponse`, `_streamClaudeResponse`)**：
      *   在 `STREAM_CHUNK` 循环读取中，当接收到来自 WebSocket 的 `gemini chunk` 时：
          ```javascript
          this._saveTransactionPayload(requestId, "gem_res", message.data);
          ```
      *   当我们翻译并给客户端 `res.write` 吐出最终分块时：
          ```javascript
          this._saveTransactionPayload(requestId, "client_res", translatedChunk); // 自动匹配 open_res 或 claude_res 字段名
          ```

- [ ] **Step 3: 语法验证与提交**

  Run: `node -e "require('./src/core/RequestHandler.js')"`
  Expected: 无任何报错，正常退出。

  ```bash
  git add src/core/RequestHandler.js
  git commit -m "feat(core): implement transaction payload memory-capture and automated single JSON writing in RequestHandler"
  ```

---

### Task 3: 前端多语言翻译词条添加

**Files:**
- Modify: `ui/locales/en.json`
- Modify: `ui/locales/zh.json`

- [ ] **Step 1: 向 en.json 添加词条**

  打开 `ui/locales/en.json`，在对应字母排序位置插入以下 11 个词条：
  ```json
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
  ```

- [ ] **Step 2: 向 zh.json 添加对应词条**

  打开 `ui/locales/zh.json`，在相应排序位置插入对应中文翻译：
  ```json
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
  ```

- [ ] **Step 3: 验证并提交**

  ```bash
  git add ui/locales/en.json ui/locales/zh.json
  git commit -m "chore(locales): add translation strings for API Translation Inspector"
  ```

---

### Task 4: 前端 StatusPage.vue 核心交互界面开发

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: 新增 enableTranslationLogging 动作开关和清空按钮**

  1.  在 `StatusPage.vue` 的设置/操作卡片（约 line 1300 或 720 设置区附近）添加 `el-switch`：
      ```html
      <el-switch
          v-model="state.enableTranslationLogging"
          :active-text="t('enableTranslationLogging')"
          @change="toggleTranslationLogging"
      />
      ```
  2.  在表格上方或设置区，新增一键清空日志按钮：
      ```html
      <el-button
          type="danger"
          size="small"
          plain
          @click="confirmPurgeTransactions"
      >
          {{ t("btnPurgeTransactions") }}
      </el-button>
      ```

- [ ] **Step 2: 在 Request Records 表格最右侧添加“放大镜调试”列**

  定位到 `filteredRecords` 表格的最右侧，在状态码或消耗时间右侧插入操作栏：
  ```html
  <el-table-column width="60" align="center" fixed="right">
      <template #default="scope">
          <el-button
              type="primary"
              link
              :disabled="!scope.row.requestId"
              @click="openTransactionInspector(scope.row.requestId)"
          >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="8"></circle>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
          </el-button>
      </template>
  </el-table-column>
  ```

- [ ] **Step 3: 编写弹出对比 Dialog 视窗的 Template 结构**

  在页面底部添加 full-screen 对比 Dialog 遮罩：
  ```html
  <el-dialog
      v-model="inspectorState.visible"
      :title="t('apiTranslationInspector') + ' (ID: ' + inspectorState.requestId + ')'"
      width="85%"
      top="5vh"
      destroy-on-close
  >
      <div v-loading="inspectorState.loading" class="inspector-dialog-content">
          <div class="inspector-row">
              <!-- Left Column: Request-Side -->
              <div class="inspector-col">
                  <div class="code-card">
                      <div class="code-card-header">
                          <span>{{ t("clientRequest") }}</span>
                          <el-button size="small" type="primary" link @click="copyText(inspectorState.data.client_req)">
                              {{ t("copyPayload") }}
                          </el-button>
                      </div>
                      <pre class="code-editor">{{ formatJson(inspectorState.data.client_req) }}</pre>
                  </div>
                  <div class="code-card">
                      <div class="code-card-header">
                          <span>{{ t("geminiInput") }}</span>
                          <el-button size="small" type="primary" link @click="copyText(inspectorState.data.gem_req)">
                              {{ t("copyPayload") }}
                          </el-button>
                      </div>
                      <pre class="code-editor">{{ formatJson(inspectorState.data.gem_req) }}</pre>
                  </div>
              </div>
              <!-- Right Column: Response-Side -->
              <div class="inspector-col">
                  <div class="code-card">
                      <div class="code-card-header">
                          <span>{{ t("geminiOutput") }}</span>
                          <el-button size="small" type="primary" link @click="copyText(inspectorState.data.gem_res)">
                              {{ t("copyPayload") }}
                          </el-button>
                      </div>
                      <pre class="code-editor">{{ formatJson(inspectorState.data.gem_res) }}</pre>
                  </div>
                  <div class="code-card">
                      <div class="code-card-header">
                          <span>{{ t("clientOutput") }}</span>
                          <el-button size="small" type="primary" link @click="copyText(inspectorState.data.client_res)">
                              {{ t("copyPayload") }}
                          </el-button>
                      </div>
                      <pre class="code-editor">{{ formatJson(inspectorState.data.client_res) }}</pre>
                  </div>
              </div>
          </div>
      </div>
  </el-dialog>
  ```

- [ ] **Step 4: 编写 JS 交互逻辑和状态数据请求**

  1.  定义 `inspectorState`：
      ```javascript
      const inspectorState = reactive({
          visible: false,
          loading: false,
          requestId: "",
          data: {
              client_req: null,
              gem_req: null,
              gem_res: null,
              client_res: null
          }
      });
      ```
  2.  添加 API 热切换方法 `toggleTranslationLogging`：
      ```javascript
      const toggleTranslationLogging = async () => {
          try {
              const res = await fetch("/api/settings/enable-translation-logging", { method: "PUT" });
              const data = await res.json();
              if (res.ok) {
                  ElMessage.success(t(data.message));
                  updateContent();
              }
          } catch (e) {
              ElMessage.error(t("errorOperationFailed", { error: e.message }));
          }
      };
      ```
  3.  添加一键清空日志交互 `confirmPurgeTransactions`：
      ```javascript
      const confirmPurgeTransactions = () => {
          ElMessageBox.confirm(t("confirmPurgeTransactions"), t("warning"), {
              confirmButtonText: t("confirm"),
              cancelButtonText: t("cancel"),
              type: "warning"
          }).then(async () => {
              try {
                  const res = await fetch("/api/transactions", { method: "DELETE" });
                  const data = await res.json();
                  if (res.ok) {
                      ElMessage.success(t(data.message, { count: data.count }));
                  }
              } catch (e) {
                  ElMessage.error(t("errorOperationFailed", { error: e.message }));
              }
          });
      };
      ```
  4.  添加拉取报文详情的弹窗逻辑 `openTransactionInspector`：
      ```javascript
      const openTransactionInspector = async (requestId) => {
          inspectorState.requestId = requestId;
          inspectorState.visible = true;
          inspectorState.loading = true;
          inspectorState.data = { client_req: null, gem_req: null, gem_res: null, client_res: null };
          
          try {
              const res = await fetch(`/api/transactions/${requestId}`);
              if (res.ok) {
                  const data = await res.json();
                  // Suffix mapper for easy uniform display
                  inspectorState.data = {
                      client_req: data.client_req || data.open_req || data.claude_req || "N/A",
                      gem_req: data.gem_req || "N/A",
                      gem_res: data.gem_res || "N/A",
                      client_res: data.client_res || data.open_res || data.claude_res || "N/A"
                  };
              } else {
                  ElMessage.error(t("transactionNotFound"));
              }
          } catch (e) {
              ElMessage.error(t("errorOperationFailed", { error: e.message }));
          } finally {
              inspectorState.loading = false;
          }
      };
      ```

- [ ] **Step 5: 添加 Visual Less 样式**

  在底部 `<style lang="less" scoped>` 中加入样式：
  ```less
  .inspector-dialog-content {
      padding: 10px 0;
  }
  .inspector-row {
      display: flex;
      gap: 16px;
      height: 70vh;
  }
  .inspector-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
      overflow: hidden;
  }
  .code-card {
      flex: 1;
      border: 1px solid @border-color;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      background: #1e1e1e; /* VS Code dark background */
      overflow: hidden;
  }
  .code-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: #2d2d2d;
      color: #d4d4d4;
      font-weight: bold;
      font-size: 13px;
      border-bottom: 1px solid #3c3c3c;
  }
  .code-editor {
      flex: 1;
      margin: 0;
      padding: 12px 16px;
      overflow: auto;
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #9cdcfe; /* light blue */
      white-space: pre-wrap;
      word-break: break-all;
  }
  ```

- [ ] **Step 6: 前端编译与提交**

  Run: `npm run build:ui`
  Expected: 成功打出生产包。

  ```bash
  git add ui/app/pages/StatusPage.vue
  git commit -m "feat(ui): implement visual API Translation Inspector dialog interface, toggle settings switch, and Less styles"
  ```

---

### Task 5: 最终测试、Lint 与清理

- [ ] **Step 1: 运行 Lint 代码质量检查**

  Run: `npm run lint` 或者是 `npx eslint src/utils/ConfigLoader.js src/routes/StatusRoutes.js src/core/RequestHandler.js ui/app/pages/StatusPage.vue`
  Expected: 零错误，格式完全规范。

- [ ] **Step 2: 运行热切换功能与落盘完整流程检测**

  启动系统代理服务器并向任意接口发出翻译请求，在开启 `enableTranslationLogging` 开关状态下，确认 `data/debug/` 下成功写入 `transaction_<requestId>.json`。
  清空日志后验证该目录下没有任何事务残留文件。

- [ ] **Step 3: 提交代码并推送分支**

  ```bash
  git status
  ```
  Expected: 清爽干净的暂存状态。
