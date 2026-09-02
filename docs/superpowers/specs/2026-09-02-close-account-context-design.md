# Design: Close Active Account Context in WebUI

## 1. Overview
This feature allows administrators to manually close and release browser contexts (and their associated Camoufox/Firefox page/processes) for specific Google accounts directly from the WebUI Account Management dashboard (`/` or `StatusPage.vue`).

This helps users free up system memory (~700MB per active context) without having to restart the entire proxy server or delete account credentials.

## 2. Requirements & Behavior
- **Trigger Location**: Account action toolbar for each account item in `StatusPage.vue`.
- **Visibility**: Displayed only when `item.hasContext === true` (indicating an active browser context exists in `browserManager.contexts`).
- **Confirmation Dialog**:
  - If the target account is the **current active account** (`item.index === state.currentAuthIndex`), prompt a confirmation modal (`ElMessageBox.confirm`) before executing.
  - If the target account is a background preloaded context (non-current), close immediately without a confirmation prompt.
- **Context Pool Behavior**:
  - Closing a context does **not** automatically trigger background pool rebalancing (`rebalanceContextPool`). The context remains closed until requested by a new API call or manual account switch.
  - If all active contexts are closed, `browserManager.closeContext()` will cleanly close the browser process if no other contexts are initializing.
- **Current Account State**:
  - If closing the current active account, reset `currentAuthIndex` to `-1` in both `requestHandler` and `browserManager`, and terminate any in-flight message queues for this account.

## 3. Architecture & API Design

### 3.1 Backend API Endpoint
- **Method & Path**: `POST /api/accounts/:index/close-context`
- **Authentication**: Protected by `isAuthenticated` middleware.
- **Workflow**:
  1. Validate `index` parameter (must be an integer and exist in `authSource.initialIndices`).
  2. Check `_rejectIfSystemBusy(res)` to avoid race conditions with ongoing account switching or recovery.
  3. Check if `browserManager.contexts.has(authIndex)` is active:
     - If not active and not initializing: return `200` with `{ message: "contextAlreadyClosed", index: authIndex }`.
  4. If `authIndex === requestHandler.currentAuthIndex`:
     - Cleanly close active message queues via `connectionRegistry.closeMessageQueuesForAuth(authIndex, "manual_context_closed")`.
     - Reset `requestHandler.currentAuthIndex = -1`.
  5. Call `await browserManager.closeContext(authIndex)`:
     - Stops health monitor interval.
     - Removes from `browserManager.contexts`.
     - Closes Playwright `BrowserContext`.
     - Closes browser process if no remaining contexts or initializing tasks exist.
  6. Call `connectionRegistry.closeConnectionByAuth(authIndex)`.
  7. Return `200` with `{ message: "closeContextSuccess", index: authIndex }`.

### 3.2 Frontend UI & Interaction (`StatusPage.vue`)
- **Action Button in `.account-actions`**:
  - Add a dedicated button:
    ```vue
    <button
        v-if="item.hasContext"
        class="btn-close-context"
        :disabled="isBusy"
        :title="t('btnCloseContext')"
        @click.stop="closeAccountContext(item)"
    >
        <!-- Disconnect / Power-off SVG Icon -->
    </button>
    ```
- **Handler `closeAccountContext(item)`**:
  - If `item.index === state.currentAuthIndex`, show confirmation dialog:
    `confirmCloseCurrentContext` ("账号 #{index}（{name}）当前正处于激活状态，关闭 Context 将断开该账号的浏览器会话。确定要关闭吗？").
  - On confirm (or if not current account):
    - Set local loading / busy state.
    - `POST /api/accounts/${item.index}/close-context`.
    - Show `ElMessage.success`.
    - Call `fetchStatus()` to refresh state.
- **Styling**:
  - Add `.btn-close-context` styling matching existing icon buttons in `StatusPage.vue`.
  - Provide a distinctive icon and hover style (e.g. orange/warning or theme secondary).

### 3.3 Internationalization (i18n)
Update `ui/locales/zh.json` and `ui/locales/en.json`:
- **Chinese (`zh.json`)**:
  - `"btnCloseContext"`: `"关闭 Context"`
  - `"closeContextSuccess"`: `"账号 #{index} 的 Context 已成功关闭"`
  - `"closeContextFailed"`: `"关闭 Context 失败：{error}"`
  - `"confirmCloseCurrentContext"`: `"账号 #{index}（{name}）当前正处于激活状态，关闭 Context 将断开该账号的浏览器会话。确定要关闭吗？"`
  - `"confirmCloseContextTitle"`: `"关闭 Context 确认"`
- **English (`en.json`)**:
  - `"btnCloseContext"`: `"Close Context"`
  - `"closeContextSuccess"`: `"Successfully closed context for account #{index}"`
  - `"closeContextFailed"`: `"Failed to close context: {error}"`
  - `"confirmCloseCurrentContext"`: `"Account #{index} ({name}) is currently active. Closing context will disconnect its browser session. Are you sure?"`
  - `"confirmCloseContextTitle"`: `"Close Context Confirmation"`

## 4. Error Handling & Edge Cases
1. **Context already closed**: Handled gracefully, returning 200 without throwing errors.
2. **Context currently initializing**: `browserManager.closeContext()` handles `initializingContexts` by adding to `abortedContexts` and waiting for abort/init completion before closing.
3. **Pending requests during close**: Handled via `connectionRegistry.closeMessageQueuesForAuth(authIndex, "manual_context_closed")`, failing pending requests cleanly instead of hanging.
4. **Concurrent mode**: In concurrent mode, closing a context removes it from the browser pool. Subsequent requests will select other available contexts or initialize on demand.
