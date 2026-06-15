# API Translation Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end "API Translation Inspector / Payload Debugger" that captures client requests/responses and their converted Gemini counterparts, saves them securely to disk under `data/debug/`, and allows viewing them interactively on the "Usage Stats" Request Records table via a beautiful 4-pane modal.

**Architecture:**

1. `RequestHandler.js` intercepts, captures, and buffers incoming and outgoing payloads across Non-stream, Fake-stream, and Real-stream modes, writing to `data/debug/transaction_<requestId>_<type>.json` files.
2. `StatusRoutes.js` exposes `/api/transactions/:id` to securely load the 4 payloads.
3. `StatusPage.vue` embeds an "Inspect" action icon on each record row, fetches payloads asynchronously, and renders a fully interactive side-by-side comparison modal with syntax highlighting cards and copy-to-clipboard abilities.

**Tech Stack:** Node.js, Express, Vue.js 3, Element Plus (`el-tooltip`, `el-dialog`, `el-loading`), Less CSS.

---

## File Structure

We will modify the following existing files:

- `src/core/RequestHandler.js`: Save request/response payloads to disk during request lifecycle.
- `src/routes/StatusRoutes.js`: Expose GET API endpoint for transaction details.
- `ui/locales/en.json`: English translation strings.
- `ui/locales/zh.json`: Chinese translation strings.
- `ui/app/pages/StatusPage.vue`: Action button column, inspector modal markup, reactive state and retrieval logic, Less styles.

---

### Task 1: Payload Capture Methods in RequestHandler

**Files:**

- Modify: `src/core/RequestHandler.js`

- [ ] **Step 1: Edit `src/core/RequestHandler.js` to add the `_saveTransactionPayload` file-saver helper**

Add this method to `RequestHandler` (around line 3510, near the end of request helper methods):

```javascript
    _saveTransactionPayload(requestId, type, data) {
        try {
            const debugDir = path.join(process.cwd(), "data", "debug");
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir, { recursive: true });
            }
            const filePath = path.join(debugDir, `transaction_${requestId}_${type}.json`);

            let contentToWrite = data;
            if (typeof data === "object" && data !== null) {
                contentToWrite = JSON.stringify(data, null, 2);
            } else if (typeof data === "string") {
                try {
                    contentToWrite = JSON.stringify(JSON.parse(data), null, 2);
                } catch {
                    // Fail-safe: write raw string if it's not valid JSON
                }
            }
            fs.writeFileSync(filePath, contentToWrite || "", "utf-8");
        } catch (err) {
            this.logger.debug(`[Debug] Failed to save transaction payload: ${err.message}`);
        }
    }
```

- [ ] **Step 2: Save incoming Client Request and translated Gemini Request in `processOpenAIResponse` (around line 1561)**

Find:

```javascript
            // Translate OpenAI Response format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;
            } catch (error) {
```

Modify to capture request payloads:

```javascript
            // Save original Client request
            this._saveTransactionPayload(requestId, "open_req", req.body);

            // Translate OpenAI Response format to Google format
            let googleBody, model, modelStreamingMode;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
                modelStreamingMode = result.modelStreamingMode || null;

                // Save translated Google payload
                this._saveTransactionPayload(requestId, "gem_req", googleBody);
            } catch (error) {
```

- [ ] **Step 3: Save incoming Client Request and translated Gemini Request in `processOpenAIResponseInputTokens` (around line 2396)**

Find:

```javascript
            // Translate OpenAI Response format to Google format (so we can use Gemini countTokens)
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;
            } catch (error) {
```

Modify to capture input token request payloads:

```javascript
            // Save original Client count-tokens request
            this._saveTransactionPayload(requestId, "open_req", req.body);

            // Translate OpenAI Response format to Google format (so we can use Gemini countTokens)
            let googleBody, model;
            try {
                const result = await this.formatConverter.translateOpenAIResponseToGoogle(req.body);
                googleBody = result.googleRequest;
                model = result.cleanModelName;

                // Save translated Google count-tokens payload
                this._saveTransactionPayload(requestId, "gem_req", googleBody);
            } catch (error) {
```

- [ ] **Step 4: Save responses in Non-Stream helper `_sendOpenAIResponseAPINonStreamResponse` (around line 3350)**

Find:

```javascript
const translatedResponse = this.formatConverter.translateGoogleToResponseAPI(
  rawGeminiResponse,
  model,
  responseDefaults
);
res.status(200).json(translatedResponse);
```

Modify to capture non-stream responses:

```javascript
const translatedResponse = this.formatConverter.translateGoogleToResponseAPI(
  rawGeminiResponse,
  model,
  responseDefaults
);

this._saveTransactionPayload(requestId, "gem_res", rawGeminiResponse);
this._saveTransactionPayload(requestId, "open_res", translatedResponse);

res.status(200).json(translatedResponse);
```

- [ ] **Step 5: Save responses in Fake-Stream block in `processOpenAIResponse` (around line 1830)**

Find:

```javascript
                                const streamState = {};
                                streamState.responseDefaults = responseDefaults;
                                const translatedChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                                    fullBody,
                                    model,
                                    streamState
                                );
                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                    } catch (writeError) {
```

Modify to capture fake-stream responses:

```javascript
                                const streamState = {};
                                streamState.responseDefaults = responseDefaults;
                                const translatedChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                                    fullBody,
                                    model,
                                    streamState
                                );

                                this._saveTransactionPayload(requestId, "gem_res", fullBody);
                                this._saveTransactionPayload(requestId, "open_res", translatedChunk);

                                if (this._isResponseWritable(res)) {
                                    try {
                                        if (translatedChunk) {
                                            res.write(translatedChunk);
                                        }
                                    } catch (writeError) {
```

- [ ] **Step 6: Save responses in Real SSE-Stream method `_streamOpenAIResponseAPIResponse` (around line 3410)**

Find:

```javascript
    async _streamOpenAIResponseAPIResponse(messageQueue, res, model, streamOptions = {}) {
        const streamState = {
            responseDefaults: streamOptions.responseDefaults || {},
        };
        const requestId = streamOptions.requestId;
```

And around line 3480:

```javascript
                if (message.data) {
                    const responseAPIChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                        message.data,
                        model,
                        streamState
                    );
```

Modify to initialize accumulators and write them on STREAM_END:

```javascript
    async _streamOpenAIResponseAPIResponse(messageQueue, res, model, streamOptions = {}) {
        const streamState = {
            gemResponseAccumulator: "",
            openResponseAccumulator: "",
            responseDefaults: streamOptions.responseDefaults || {},
        };
        const requestId = streamOptions.requestId;
```

```javascript
                if (message.type === "STREAM_END") {
                    this.logger.info(
                        `✅ [Request] Response completed (OpenAI Response API real stream), request ID: ${requestId}`
                    );

                    // Save accumulated payloads
                    this._saveTransactionPayload(requestId, "gem_res", streamState.gemResponseAccumulator);
                    this._saveTransactionPayload(requestId, "open_res", streamState.openResponseAccumulator);
```

```javascript
                if (message.data) {
                    streamState.gemResponseAccumulator += message.data;

                    const responseAPIChunk = this.formatConverter.translateGoogleToResponseAPIStream(
                        message.data,
                        model,
                        streamState
                    );
                    if (responseAPIChunk) {
                        streamState.openResponseAccumulator += responseAPIChunk;
                    }
```

- [ ] **Step 7: Commit backend capture additions**

```bash
git add src/core/RequestHandler.js
git commit -m "feat: implement persistent JSON payload capture for OpenAI Response API requests"
```

---

### Task 2: Express HTTP API Router Integration

**Files:**

- Modify: `src/routes/StatusRoutes.js`

- [ ] **Step 1: Open `src/routes/StatusRoutes.js` and add `GET /api/transactions/:id` routing endpoint around line 861 (right below `/api/snapshots` delete routes)**

Add this route:

```javascript
app.get("/api/transactions/:id", isAuthenticated, (req, res) => {
  const { id } = req.params;
  const debugDir = path.join(process.cwd(), "data", "debug");

  const payloads = {
    gem_req: null,
    gem_res: null,
    open_req: null,
    open_res: null,
  };

  try {
    if (fs.existsSync(debugDir)) {
      ["open_req", "gem_req", "gem_res", "open_res"].forEach(type => {
        const filePath = path.join(debugDir, `transaction_${id}_${type}.json`);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          try {
            payloads[type] = JSON.parse(content);
          } catch {
            payloads[type] = content; // Fallback to raw string if it's SSE text
          }
        }
      });
    }
    res.json(payloads);
  } catch (error) {
    this.logger.error(`[Debug] Failed to load transaction debug payloads: ${error.message}`);
    res.status(500).json({ error: "Failed to load transaction payloads" });
  }
});
```

- [ ] **Step 2: Commit StatusRoutes routing changes**

```bash
git add src/routes/StatusRoutes.js
git commit -m "feat: expose transaction inspect HTTP API route in StatusRoutes"
```

---

### Task 3: Translation Keys for the Inspector

**Files:**

- Modify: `ui/locales/en.json`
- Modify: `ui/locales/zh.json`

- [ ] **Step 1: Edit `ui/locales/en.json` around line 80 to add English inspector keys**

Add:

```json
    "btnInspectPayload": "Inspect API Translation Payload",
    "inspectTitle": "API Transaction Payload Inspector",
    "inspectSub": "Inspect payload mappings between OpenAI Responses and Google Gemini formats.",
    "clientReqHeader": "1. Client Request (OpenAI Response format)",
    "gemReqHeader": "2. Converted Payload (Google Gemini format)",
    "gemResHeader": "3. Server Raw Response (Google Gemini format)",
    "clientResHeader": "4. Final Converted Response (OpenAI Response format)",
    "noPayload": "No data recorded for this transaction phase.",
```

- [ ] **Step 2: Edit `ui/locales/zh.json` around line 80 to add Chinese inspector keys**

Add:

```json
    "btnInspectPayload": "查看接口转换明细",
    "inspectTitle": "API 接口转换调试器",
    "inspectSub": "查看客户端 OpenAI Response 格式与谷歌 Gemini 格式之间的转换映射细节。",
    "clientReqHeader": "1. 客户端原始请求 (OpenAI Response 格式)",
    "gemReqHeader": "2. 转换后谷歌 Payload (Google Gemini 格式)",
    "gemResHeader": "3. 浏览器原始回复 (Google Gemini 格式)",
    "clientResHeader": "4. 最终翻译回复 (OpenAI Response 格式)",
    "noPayload": "该交易阶段未记录到任何数据。",
```

- [ ] **Step 3: Commit translation changes**

```bash
git add ui/locales/en.json ui/locales/zh.json
git commit -m "intl: add translation strings for API Translation Inspector"
```

---

### Task 4: Frontend Inspector Integration in StatusPage Vue Template

**Files:**

- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Integrate the Inspect Action icon inside the Request Records table**

Find:

```html
                                        <th>{{ t("requestAttempts") }}</th>
                                        <th>{{ t("requestIp") }}</th>
                                    </tr>
                                </thead>
```

Modify to:

```html
                                        <th>{{ t("requestAttempts") }}</th>
                                        <th>{{ t("requestIp") }}</th>
                                        <th>{{ t("actionsPanel") }}</th>
                                    </tr>
                                </thead>
```

Find:

```html
                                        <td class="mono truncate-cell">
                                            <el-tooltip
                                                :content="record.clientIp || '-'"
                                                placement="top"
                                                effect="dark"
                                                :hide-after="0"
                                                :show-after="150"
                                                :disabled="!record.clientIp"
                                            >
                                                <span class="request-ip-text">
                                                    {{ record.clientIp || "-" }}
                                                </span>
                                            </el-tooltip>
                                        </td>
                                    </tr>
```

Modify to insert action column:

```html
                                        <td class="mono truncate-cell">
                                            <el-tooltip
                                                :content="record.clientIp || '-'"
                                                placement="top"
                                                effect="dark"
                                                :hide-after="0"
                                                :show-after="150"
                                                :disabled="!record.clientIp"
                                            >
                                                <span class="request-ip-text">
                                                    {{ record.clientIp || "-" }}
                                                </span>
                                            </el-tooltip>
                                        </td>
                                        <td>
                                            <button
                                                class="btn-switch btn-inspect-action"
                                                type="button"
                                                :title="t('btnInspectPayload')"
                                                @click.stop="openPayloadInspector(record.requestId)"
                                            >
                                                <svg
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    width="14"
                                                    height="14"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                >
                                                    <circle cx="11" cy="11" r="8"></circle>
                                                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                                                </svg>
                                            </button>
                                        </td>
                                    </tr>
```

- [ ] **Step 2: Append the Inspector Dialog Markup inside StatusPage.vue (near other dialog overlays around line 2850)**

Find:

```html
<el-dialog v-model="state.htmlDialogVisible" title="HTML" width="80%">
  <iframe
    :src="`/api/snapshots/${state.currentSnapshotId}/html`"
    sandbox="allow-same-origin"
    style="width: 100%; height: 600px; border: none"
  ></iframe>
</el-dialog>
```

Add below it:

```html
<!-- API Transaction Inspector Modal -->
<el-dialog v-model="inspectorState.visible" :title="t('inspectTitle')" width="90%" class="inspector-dialog" top="5vh">
  <p class="subtitle" style="margin-top: -15px; margin-bottom: 20px;">
    {{ t('inspectSub') }}
    <span class="mono" style="margin-left: 8px; font-weight: bold; color: var(--el-color-primary);"
      >ID: {{ inspectorState.currentRequestId }}</span
    >
  </p>
  <div v-loading="inspectorState.loading" class="inspector-grid" style="min-height: 400px;">
    <!-- Left: Request Translation -->
    <div class="inspector-col">
      <div class="payload-box">
        <div class="payload-box-header">
          {{ t('clientReqHeader') }}
          <button class="payload-copy-btn" @click="copyPayload(inspectorState.payloads.open_req)">
            {{ t('copy') }}
          </button>
        </div>
        <pre class="payload-pre"><code>{{ formatPayloadText(inspectorState.payloads.open_req) }}</code></pre>
      </div>
      <div class="payload-box">
        <div class="payload-box-header">
          {{ t('gemReqHeader') }}
          <button class="payload-copy-btn" @click="copyPayload(inspectorState.payloads.gem_req)">
            {{ t('copy') }}
          </button>
        </div>
        <pre class="payload-pre"><code>{{ formatPayloadText(inspectorState.payloads.gem_req) }}</code></pre>
      </div>
    </div>
    <!-- Right: Response Translation -->
    <div class="inspector-col">
      <div class="payload-box">
        <div class="payload-box-header">
          {{ t('gemResHeader') }}
          <button class="payload-copy-btn" @click="copyPayload(inspectorState.payloads.gem_res)">
            {{ t('copy') }}
          </button>
        </div>
        <pre class="payload-pre"><code>{{ formatPayloadText(inspectorState.payloads.gem_res) }}</code></pre>
      </div>
      <div class="payload-box">
        <div class="payload-box-header">
          {{ t('clientResHeader') }}
          <button class="payload-copy-btn" @click="copyPayload(inspectorState.payloads.open_res)">
            {{ t('copy') }}
          </button>
        </div>
        <pre class="payload-pre"><code>{{ formatPayloadText(inspectorState.payloads.open_res) }}</code></pre>
      </div>
    </div>
  </div>
</el-dialog>
```

- [ ] **Step 3: Commit frontend DOM structures**

```bash
git add ui/app/pages/StatusPage.vue
git commit m "feat: integrate inspector action columns and overlay dialog into StatusPage vue template"
```

---

### Task 5: Frontend Inspector Logic & Reactive State

**Files:**

- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Declare `inspectorState` and inspector helper methods in StatusPage.vue (near the end of setup block around line 3800)**

Add these definitions:

```javascript
const inspectorState = reactive({
  currentRequestId: "",
  loading: false,
  payloads: {
    gem_req: null,
    gem_res: null,
    open_req: null,
    open_res: null,
  },
  visible: false,
});

const openPayloadInspector = async requestId => {
  inspectorState.currentRequestId = requestId || "";
  inspectorState.visible = true;
  inspectorState.loading = true;
  inspectorState.payloads = {
    gem_req: null,
    gem_res: null,
    open_req: null,
    open_res: null,
  };

  try {
    const res = await fetch(`/api/transactions/${requestId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    inspectorState.payloads = {
      gem_req: data.gem_req,
      gem_res: data.gem_res,
      open_req: data.open_req,
      open_res: data.open_res,
    };
  } catch (e) {
    ElMessage.error(`Failed to load payloads: ${e.message}`);
  } finally {
    inspectorState.loading = false;
  }
};

const formatPayloadText = val => {
  if (val === null || val === undefined) return t("noPayload");
  if (typeof val === "object") {
    return JSON.stringify(val, null, 2);
  }
  return String(val);
};

const copyPayload = async val => {
  if (val === null || val === undefined) return;
  const text = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(t("copySuccess"));
  } catch (e) {
    ElMessage.error(t("copyFailed"));
  }
};
```

- [ ] **Step 2: Commit javascript setup integrations**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "feat: implement fetch action handlers and reactive state for inspector dialog"
```

---

### Task 6: Styling the Inspector Panels

**Files:**

- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Open `ui/app/pages/StatusPage.vue` and append Less CSS style declarations near line 5800**

Add these styles inside the `<style lang="less" scoped>` tag:

```less
.btn-inspect-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px !important;
  height: 26px !important;
  border-radius: 4px !important;
  cursor: pointer;
  border: 1px solid @border-color !important;
  background: @background-white !important;
  color: @text-secondary !important;
  transition: all 0.2s;

  &:hover {
    border-color: @primary-color !important;
    color: @primary-color !important;
    background-color: rgba(var(--color-primary-rgb), 0.05) !important;
  }
}

.inspector-grid {
  display: flex;
  gap: 20px;
  width: 100%;
}

.inspector-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 15px;
  min-width: 0;
}

.payload-box {
  border: 1px solid @border-light;
  border-radius: 6px;
  background: #1e1e1e;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.payload-box-header {
  background: #252526;
  padding: 8px 12px;
  font-size: 0.85rem;
  color: #9cdcfe;
  font-weight: 600;
  border-bottom: 1px solid #2d2d2d;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.payload-copy-btn {
  background: transparent;
  border: 1px solid #3c3c3c;
  color: #858585;
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    border-color: #007acc;
    color: #ffffff;
    background: #007acc;
  }
}

.payload-pre {
  margin: 0;
  padding: 12px;
  overflow: auto;
  max-height: 280px;
  font-family: @font-family-mono;
  font-size: 0.8rem;
  line-height: 1.4;
  background: #1e1e1e;
  color: #ce9178;
  text-align: left;
}

/* Adjust dialog sizing on mobile */
@media (max-width: 767px) {
  .inspector-grid {
    flex-direction: column;
  }
}
```

- [ ] **Step 2: Commit style alterations**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "style: style the dialog grids, code container layouts, and response cards with Less"
```

---

## Verification Plan

### Auto Verification

Ensure code matches formatting and lint criteria perfectly:

```bash
npm run lint
```

Expected: PASS with 0 styling or parsing errors.

### Manual Verification

1. Start the backend server `npm run dev`.
2. Fire a `/v1/responses` POST API call to trigger model mapping.
3. Access the browser dashboard and navigate to the **Usage Stats** tab.
4. Click the magnifying glass **Inspect (Inspect API Translation Payload)** button under the new Action column.
5. Verify that the overlay dialog loads immediately and displays:
   - Left side: OpenAI client request body and translated Google request.
   - Right side: Google returned chunk outputs and converted OpenAI client response chunks.
6. Verify clicking the "Copy" buttons successfully captures the JSON text inside the clipboard.
7. Click "Purge All" in snapshots and make sure all payload transaction files are deleted from disk under `data/debug/`.
