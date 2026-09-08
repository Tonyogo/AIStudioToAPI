# Close Active Account Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to manually close and release browser contexts for specific accounts directly from the WebUI account management dashboard, releasing memory without restarting the proxy.

**Architecture:** A new backend endpoint `POST /api/accounts/:index/close-context` in `StatusRoutes.js` validates the target account, cleanly flushes message queues, closes the Playwright browser context via `browserManager.closeContext(authIndex)`, disconnects WebSocket connections, and resets active state if closing the current account. The frontend (`StatusPage.vue`) displays a "Close Context" icon button for any account with `hasContext: true`, prompting confirmation only when closing the currently active account.

**Tech Stack:** Node.js, Express, Playwright, Vue.js 3, Element Plus, Less, Jest.

## Global Constraints

- Protected by `isAuthenticated` middleware.
- Does not trigger automatic context pool rebalancing on close.
- If all active contexts are closed and no background initialization is pending, `browserManager.closeContext()` will cleanly close the browser process.
- Strictly adhere to ESLint, Prettier, and Stylelint rules.

---

### Task 1: Backend Endpoint - Close Account Context API

**Files:**
- Modify: `src/routes/StatusRoutes.js`
- Test: `test/routes/status_routes_close_context.test.js`

**Interfaces:**
- Consumes:
  - `serverSystem.authSource.initialIndices`: Array of integers
  - `serverSystem.requestHandler.isSystemBusy`: boolean
  - `serverSystem.requestHandler.currentAuthIndex`: number
  - `serverSystem.connectionRegistry.closeMessageQueuesForAuth(authIndex, reason)`
  - `serverSystem.connectionRegistry.closeConnectionByAuth(authIndex)`
  - `serverSystem.browserManager.closeContext(authIndex)`
  - `serverSystem.browserManager.contexts`: Map
  - `serverSystem.browserManager.initializingContexts`: Set
- Produces:
  - `POST /api/accounts/:index/close-context` -> JSON `{ message: "closeContextSuccess", index: number }` or `{ message: "contextAlreadyClosed", index: number }`

- [ ] **Step 1: Write the failing unit/integration test**

Create `test/routes/status_routes_close_context.test.js`:

```javascript
/* eslint-env jest */
const express = require("express");
const request = require("supertest");
const StatusRoutes = require("../../src/routes/StatusRoutes");

describe("StatusRoutes - POST /api/accounts/:index/close-context", () => {
    let app;
    let mockServerSystem;
    let mockBrowserManager;
    let mockConnectionRegistry;
    let mockRequestHandler;
    let mockAuthSource;
    let statusRoutes;

    beforeEach(() => {
        app = express();
        app.use(express.json());

        mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            contexts: new Map([[0, { context: {} }]]),
            currentAuthIndex: 0,
            initializingContexts: new Set(),
        };

        mockConnectionRegistry = {
            closeConnectionByAuth: jest.fn(),
            closeMessageQueuesForAuth: jest.fn(),
        };

        mockRequestHandler = {
            currentAuthIndex: 0,
            isSystemBusy: false,
        };

        mockAuthSource = {
            availableIndices: [0, 1],
            initialIndices: [0, 1],
        };

        mockServerSystem = {
            authSource: mockAuthSource,
            browserManager: mockBrowserManager,
            config: {},
            connectionRegistry: mockConnectionRegistry,
            distIndexPath: "/tmp/index.html",
            logger: {
                debug: jest.fn(),
                error: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
            },
            requestHandler: mockRequestHandler,
        };

        statusRoutes = new StatusRoutes(mockServerSystem);
        const passAuth = (req, res, next) => next();
        statusRoutes.setupRoutes(app, passAuth);
    });

    test("returns 400 for invalid non-integer account index", async () => {
        const res = await request(app).post("/api/accounts/abc/close-context");
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("errorInvalidIndex");
    });

    test("returns 404 if account index does not exist in initialIndices", async () => {
        const res = await request(app).post("/api/accounts/99/close-context");
        expect(res.status).toBe(404);
        expect(res.body.message).toBe("errorAccountNotFound");
    });

    test("returns 409 if system is busy", async () => {
        mockRequestHandler.isSystemBusy = true;
        const res = await request(app).post("/api/accounts/0/close-context");
        expect(res.status).toBe(409);
        expect(res.body.message).toBe("systemBusySwitchingOrRecoveringAccounts");
    });

    test("returns 200 contextAlreadyClosed if context is not loaded and not initializing", async () => {
        mockBrowserManager.contexts.clear();
        const res = await request(app).post("/api/accounts/1/close-context");
        expect(res.status).toBe(200);
        expect(res.body.message).toBe("contextAlreadyClosed");
        expect(res.body.index).toBe(1);
        expect(mockBrowserManager.closeContext).not.toHaveBeenCalled();
    });

    test("closes context for current active account and resets currentAuthIndex", async () => {
        const res = await request(app).post("/api/accounts/0/close-context");
        expect(res.status).toBe(200);
        expect(res.body.message).toBe("closeContextSuccess");
        expect(res.body.index).toBe(0);

        expect(mockConnectionRegistry.closeMessageQueuesForAuth).toHaveBeenCalledWith(0, "manual_context_closed");
        expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(0);
        expect(mockConnectionRegistry.closeConnectionByAuth).toHaveBeenCalledWith(0);
        expect(mockRequestHandler.currentAuthIndex).toBe(-1);
    });

    test("closes context for non-current preloaded account without resetting currentAuthIndex", async () => {
        mockBrowserManager.contexts.set(1, { context: {} });
        mockRequestHandler.currentAuthIndex = 0;

        const res = await request(app).post("/api/accounts/1/close-context");
        expect(res.status).toBe(200);
        expect(res.body.message).toBe("closeContextSuccess");
        expect(res.body.index).toBe(1);

        expect(mockConnectionRegistry.closeMessageQueuesForAuth).toHaveBeenCalledWith(1, "manual_context_closed");
        expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(1);
        expect(mockConnectionRegistry.closeConnectionByAuth).toHaveBeenCalledWith(1);
        expect(mockRequestHandler.currentAuthIndex).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/routes/status_routes_close_context.test.js`
Expected: FAIL (404 on endpoint)

- [ ] **Step 3: Implement route in `src/routes/StatusRoutes.js`**

Add the endpoint before `app.delete("/api/accounts/:index", ...)` in `src/routes/StatusRoutes.js`:

```javascript
        // Close context for a specific account
        app.post("/api/accounts/:index/close-context", isAuthenticated, async (req, res) => {
            try {
                if (this._rejectIfSystemBusy(res)) return;

                const index = parseInt(req.params.index, 10);
                if (isNaN(index) || !Number.isInteger(index)) {
                    return res.status(400).json({ message: "errorInvalidIndex" });
                }

                const { authSource, browserManager, connectionRegistry, requestHandler } = this.serverSystem;

                if (!authSource.initialIndices.includes(index)) {
                    return res.status(404).json({ message: "errorAccountNotFound" });
                }

                const hasContext = browserManager.contexts.has(index);
                const isInitializing = browserManager.initializingContexts.has(index);

                if (!hasContext && !isInitializing) {
                    return res.status(200).json({
                        index,
                        message: "contextAlreadyClosed",
                    });
                }

                const isCurrent = requestHandler.currentAuthIndex === index;

                this.logger.info(
                    `[WebUI] Manually closing context for account #${index}${isCurrent ? " (current account)" : ""}...`
                );

                // 1. Proactively terminate any pending request message queues for this account
                connectionRegistry.closeMessageQueuesForAuth(index, "manual_context_closed");

                // 2. If it's the current active account, reset requestHandler currentAuthIndex to -1
                if (isCurrent) {
                    requestHandler.currentAuthIndex = -1;
                }

                // 3. Close the browser context
                await browserManager.closeContext(index);

                // 4. Close WebSocket connection
                connectionRegistry.closeConnectionByAuth(index);

                return res.status(200).json({
                    index,
                    message: "closeContextSuccess",
                });
            } catch (error) {
                this.logger.error(`[WebUI] Failed to close context for account #${req.params.index}: ${error.message}`);
                return res.status(500).json({
                    error: error.message,
                    message: "closeContextFailed",
                });
            }
        });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/routes/status_routes_close_context.test.js`
Expected: PASS

- [ ] **Step 5: Run existing tests to ensure no regression**

Run: `npx jest`
Expected: All test suites PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/StatusRoutes.js test/routes/status_routes_close_context.test.js
git commit -m "feat(api): add endpoint to close active account context"
```

---

### Task 2: Internationalization (i18n)

**Files:**
- Modify: `ui/locales/zh.json`
- Modify: `ui/locales/en.json`

**Interfaces:**
- Produces:
  - `btnCloseContext`: string
  - `closeContextSuccess`: string
  - `closeContextFailed`: string
  - `confirmCloseCurrentContext`: string
  - `confirmCloseContextTitle`: string
  - `contextAlreadyClosed`: string

- [ ] **Step 1: Add translation keys to `ui/locales/zh.json`**

In `ui/locales/zh.json`, add alphabetical keys:
```json
    "btnCloseContext": "关闭 Context",
    "closeContextFailed": "关闭 Context 失败：{error}",
    "closeContextSuccess": "账号 #{index} 的 Context 已成功关闭",
    "confirmCloseContextTitle": "关闭 Context 确认",
    "confirmCloseCurrentContext": "账号 #{index}（{name}）当前正处于激活状态，关闭 Context 将断开该账号的浏览器会话。确定要关闭吗？",
    "contextAlreadyClosed": "账号 #{index} 的 Context 已经处于关闭状态",
```

- [ ] **Step 2: Add translation keys to `ui/locales/en.json`**

In `ui/locales/en.json`, add alphabetical keys:
```json
    "btnCloseContext": "Close Context",
    "closeContextFailed": "Failed to close context: {error}",
    "closeContextSuccess": "Successfully closed context for account #{index}",
    "confirmCloseContextTitle": "Close Context Confirmation",
    "confirmCloseCurrentContext": "Account #{index} ({name}) is currently active. Closing context will disconnect its browser session. Are you sure?",
    "contextAlreadyClosed": "Context for account #{index} is already closed",
```

- [ ] **Step 3: Run linter and formatting check on locales**

Run: `npm run lint:js`
Expected: PASS (or auto-sorted keys if configured)

- [ ] **Step 4: Commit**

```bash
git add ui/locales/zh.json ui/locales/en.json
git commit -m "feat(i18n): add translations for closing account context"
```

---

### Task 3: Frontend UI - Account Management Action in `StatusPage.vue`

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

**Interfaces:**
- Consumes:
  - `t(key, options)`
  - `item.hasContext`
  - `item.index`
  - `state.currentAuthIndex`
  - `fetchStatus()`
  - `isBusy`
- Produces:
  - Button with class `.btn-close-context` in `.account-actions`
  - Method `closeAccountContext(item)`

- [ ] **Step 1: Add "Close Context" button to `.account-actions` template**

In `ui/app/pages/StatusPage.vue`, inside the `.account-actions` container (right before or next to `.btn-switch` / `.btn-danger`), add:

```html
                                    <button
                                        v-if="item.hasContext"
                                        class="btn-close-context"
                                        :disabled="isBusy"
                                        :title="t('btnCloseContext')"
                                        @click.stop="closeAccountContext(item)"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="16"
                                            height="16"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        >
                                            <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
                                            <line x1="12" y1="2" x2="12" y2="12"></line>
                                        </svg>
                                    </button>
```
*(Note: Use a distinctive disconnect/stop icon such as `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="9" x2="15" y2="15"></line><line x1="15" y1="9" x2="9" y2="15"></line>` or unlink icon to distinguish from `btn-toggle-disabled`)*

Example icon:
```html
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="16"
                                            height="16"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                        >
                                            <path d="M18.36 6.64a9 9 0 0 1 0 12.73"></path>
                                            <path d="M5.64 18.36a9 9 0 0 1 0-12.73"></path>
                                            <line x1="1" y1="1" x2="23" y2="23"></line>
                                        </svg>
```

- [ ] **Step 2: Add `closeAccountContext` method in `StatusPage.vue` `<script setup>`**

```javascript
const closeAccountContext = async item => {
    if (isBusy.value) return;

    const isCurrent = item.index === state.currentAuthIndex;
    if (isCurrent) {
        try {
            await ElMessageBox.confirm(
                t("confirmCloseCurrentContext", {
                    id: item.index,
                    index: item.index,
                    name: getAccountDisplayName(item),
                }),
                t("confirmCloseContextTitle"),
                {
                    cancelButtonText: t("cancel"),
                    confirmButtonText: t("btnCloseContext"),
                    type: "warning",
                }
            );
        } catch {
            return;
        }
    }

    isBusy.value = true;
    try {
        const response = await fetch(`/api/accounts/${item.index}/close-context`, {
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const data = await response.json();

        if (response.ok) {
            ElMessage.success(t(data.message || "closeContextSuccess", { index: item.index }));
            await fetchStatus();
        } else {
            ElMessage.error(
                t("closeContextFailed", { error: getApiErrorMessage(data) || data.message || "Unknown error" })
            );
        }
    } catch (error) {
        console.error("Failed to close account context:", error);
        ElMessage.error(t("closeContextFailed", { error: error.message || error }));
    } finally {
        isBusy.value = false;
    }
};
```

- [ ] **Step 3: Add CSS styling for `.btn-close-context` in `StatusPage.vue`**

Under `<style lang="less" scoped>` in `.account-actions`:
```less
.btn-close-context {
    &:hover:not(:disabled) {
        border-color: @warning-color;
        color: @warning-color;
    }
}
```

- [ ] **Step 4: Build and lint UI**

Run: `npm run build:ui`
Run: `npm run lint`
Expected: Both commands complete cleanly with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "feat(ui): add close context button and confirmation in account list"
```

---

### Task 4: Full Validation & Quality Check

**Files:**
- All modified/created files

- [ ] **Step 1: Run all test suites**

Run: `npx jest`
Expected: PASS

- [ ] **Step 2: Run all linters and formatters**

Run: `npm run lint`
Run: `npm run format:check`
Expected: All checks pass without issues.

- [ ] **Step 3: Run production build**

Run: `npm run build:ui`
Expected: Vite build succeeds and produces `ui/dist`.

- [ ] **Step 4: Final verification commit if formatting fixes needed**

```bash
git add .
git status
```
