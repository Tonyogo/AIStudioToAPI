# Account Status and Model Usage UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display concurrent account status badges (`ACTIVATED`, `ACTIVATING`, `INACTIVE`, `RETIRED`, `isSuspended`), in-flight request counts, and model daily usage breakdowns in the Account Management section of the Web UI.

**Architecture:** Extend `ModelUsageTracker` to produce per-model usage details with daily limits. Enhance `GET /api/status` in `StatusRoutes.js` to enrich each account detail item with concurrent status, in-flight count, suspension status, and usage breakdown. Add i18n locales in `zh.json` and `en.json`, update `StatusPage.vue` with Element Plus tags and hover popovers, and rebuild the Vue frontend asset bundle.

**Tech Stack:** Node.js, Express, Vue 3, Element Plus, Vite, Jest

## Global Constraints

- Preserve all existing `StatusRoutes.js` API properties in `/api/status`.
- Default unconfigured model `dailyLimit` to `1000`.
- Ensure clean fallback when `ENABLE_CONCURRENT` is not set to `"true"`.
- All Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Add `getAccountUsageDetails` Method to `ModelUsageTracker` and Update Unit Tests

**Files:**

- Modify: `src/concurrent/ModelUsageTracker.js`
- Modify: `test/concurrent/model_usage_tracker.test.js`

**Interfaces:**

- Consumes: `this.usageData[authIndex]`, `modelList`
- Produces: `getAccountUsageDetails(authIndex, modelList)` returning `{ total: number, byModel: { [cleanName]: { usage: number, limit: number } } }`

- [ ] **Step 1: Write failing test for `getAccountUsageDetails`**

Edit `test/concurrent/model_usage_tracker.test.js` to add:

```javascript
test("getAccountUsageDetails calculates total and per-model usage with limits", () => {
  const tracker = new ModelUsageTracker(mockLogger);
  tracker.recordUsage(0, "gemini-2.5-flash");
  tracker.recordUsage(0, "gemini-2.5-flash");
  tracker.recordUsage(0, "gemini-2.5-pro");

  const modelList = [
    { dailyLimit: 1000, name: "models/gemini-2.5-flash" },
    { dailyLimit: 50, name: "models/gemini-2.5-pro" },
  ];

  const details = tracker.getAccountUsageDetails(0, modelList);

  expect(details.total).toBe(3);
  expect(details.byModel["gemini-2.5-flash"]).toEqual({ limit: 1000, usage: 2 });
  expect(details.byModel["gemini-2.5-pro"]).toEqual({ limit: 50, usage: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/model_usage_tracker.test.js -t "getAccountUsageDetails"`
Expected: FAIL (`tracker.getAccountUsageDetails is not a function`).

- [ ] **Step 3: Implement `getAccountUsageDetails` in `ModelUsageTracker.js`**

Add method to `src/concurrent/ModelUsageTracker.js`:

```javascript
    /**
     * Get structured usage details and limits for a specific account
     * @param {number} authIndex
     * @param {Array} [modelList=[]]
     * @returns {{total: number, byModel: Object}}
     */
    getAccountUsageDetails(authIndex, modelList = []) {
        this._checkAndResetCycle();
        const usageMap = this.usageData[authIndex] || {};
        let totalUsage = 0;
        const byModel = {};

        const effectiveModelList =
            Array.isArray(modelList) && modelList.length > 0
                ? modelList
                : [{ name: "models/gemini-2.5-flash" }];

        for (const m of effectiveModelList) {
            if (!m || !m.name) continue;
            const cleanName = m.name.replace("models/", "");
            const usage = usageMap[cleanName] || 0;
            const limit = typeof m.dailyLimit === "number" && m.dailyLimit > 0 ? m.dailyLimit : 1000;
            byModel[cleanName] = { limit, usage };
            totalUsage += usage;
        }

        return { byModel, total: totalUsage };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/model_usage_tracker.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ModelUsageTracker.js test/concurrent/model_usage_tracker.test.js
git commit -m "feat(concurrent): add getAccountUsageDetails method to ModelUsageTracker

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Enrich `/api/status` Endpoint Response with Concurrent Status and Usage Details

**Files:**

- Modify: `src/routes/StatusRoutes.js`
- Test: `test/concurrent/integration.test.js`

**Interfaces:**

- Consumes: `serverSystem.concurrentComponents`, `scheduler.getAccountStatus()`, `scheduler.getInFlightCount()`, `scheduler.isAccountSuspended()`, `modelUsageTracker.getAccountUsageDetails()`
- Produces: Enhanced `accountDetails` objects in `GET /api/status` containing `concurrentStatus`, `inFlight`, `isSuspended`, `usage`, and `isConcurrentMode` in root `status` object.

- [ ] **Step 1: Write test for enriched `/api/status` payload**

Edit `test/concurrent/integration.test.js` to add:

```javascript
test("getStatusData returns concurrent status and usage details when concurrent mode is initialized", () => {
  const statusRoutes = new StatusRoutes(mockServerSystem);
  const data = statusRoutes._getStatusData();

  expect(data.status.isConcurrentMode).toBe(true);
  expect(data.status.accountDetails[0]).toHaveProperty("concurrentStatus");
  expect(data.status.accountDetails[0]).toHaveProperty("inFlight");
  expect(data.status.accountDetails[0]).toHaveProperty("isSuspended");
  expect(data.status.accountDetails[0]).toHaveProperty("usage");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/integration.test.js -t "returns concurrent status"`
Expected: FAIL (property missing or undefined).

- [ ] **Step 3: Update `_getStatusData()` in `StatusRoutes.js`**

Modify `_getStatusData()` in `src/routes/StatusRoutes.js`:

```javascript
const concurrent = this.serverSystem.concurrentComponents;
const isConcurrentMode = process.env.ENABLE_CONCURRENT === "true";

const accountDetails = initialIndices.map(index => {
  const isInvalid = invalidIndices.includes(index);
  const name = isInvalid ? null : accountNameMap.get(index) || null;

  const canonicalIndex = isInvalid ? null : authSource.getCanonicalIndex(index);
  const isDuplicate = canonicalIndex !== null && canonicalIndex !== index;
  const isRotation = rotationIndices.includes(index);
  const isExpired = expiredIndices.includes(index);

  const hasContext = browserManager.contexts.has(index);

  const concurrentStatus = concurrent?.scheduler ? concurrent.scheduler.getAccountStatus(index) : null;
  const inFlight = concurrent?.scheduler ? concurrent.scheduler.getInFlightCount(index) : 0;
  const isSuspended = concurrent?.scheduler ? concurrent.scheduler.isAccountSuspended(index) : false;
  const usageInfo = concurrent?.modelUsageTracker
    ? concurrent.modelUsageTracker.getAccountUsageDetails(index, config.modelList)
    : { byModel: {}, total: 0 };

  return {
    canonicalIndex,
    concurrentStatus,
    hasContext,
    inFlight,
    index,
    isDuplicate,
    isExpired,
    isInvalid,
    isRotation,
    isSuspended,
    name,
    usage: usageInfo,
  };
});
```

And update the returned status object to include `isConcurrentMode`:

```javascript
return {
  logCount: displayLogs.length,
  logs: displayLogs.join("\n"),
  status: {
    accountDetails,
    activeContextsCount: browserManager.contexts.size,
    apiKeySource: config.apiKeySource,
    browserConnected: !!this.serverSystem.connectionRegistry.getConnectionByAuth(currentAuthIndex, false),
    checkUpdate: config.checkUpdate,
    currentAccountName,
    currentAuthIndex,
    debugMode: LoggingService.isDebugEnabled(),
    duplicateIndicesRaw: duplicateIndices,
    enableAuthUpdate: config.enableAuthUpdate,
    expiredIndicesRaw: expiredIndices,
    failureCount,
    forceCodeExecution: config.forceCodeExecution,
    forceThinking: config.forceThinking,
    forceUrlContext: config.forceUrlContext,
    forceWebSearch: config.forceWebSearch,
    immediateSwitchStatusCodes:
      config.immediateSwitchStatusCodes.length > 0 ? `[${config.immediateSwitchStatusCodes.join(", ")}]` : "Disabled",
    initialIndicesRaw: initialIndices,
    invalidIndicesRaw: invalidIndices,
    isConcurrentMode,
    isSystemBusy: requestHandler.isSystemBusy,
    logMaxCount: limit,
    maxContexts: config.maxContexts,
    maxRetries: config.maxRetries,
    rotationIndicesRaw: rotationIndices,
    safetySettingsThreshold: config.safetySettingsThreshold,
    streamingMode: config.streamingMode,
    usageCount,
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/routes/StatusRoutes.js test/concurrent/integration.test.js
git commit -m "feat(webui): enrich /api/status response with concurrent status and model usage details

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add Locales and Update Frontend Vue Component (`StatusPage.vue`)

**Files:**

- Modify: `ui/locales/zh.json`
- Modify: `ui/locales/en.json`
- Modify: `ui/app/pages/StatusPage.vue`

**Interfaces:**

- Consumes: `item.concurrentStatus`, `item.inFlight`, `item.isSuspended`, `item.usage`, `state.isConcurrentMode`
- Produces: Rendered Element Plus status badges and popovers for per-model daily usage breakdown.

- [ ] **Step 1: Add translation strings to `ui/locales/zh.json` and `ui/locales/en.json`**

In `ui/locales/zh.json`, add:

```json
"statusActivated": "已激活",
"statusActivating": "激活中",
"statusInactive": "未激活",
"statusRetired": "已退休",
"statusSuspended": "已隔离",
"todayUsage": "今日用量",
"modelUsageBreakdown": "模型用量明细"
```

In `ui/locales/en.json`, add:

```json
"statusActivated": "Activated",
"statusActivating": "Activating",
"statusInactive": "Inactive",
"statusRetired": "Retired",
"statusSuspended": "Suspended",
"todayUsage": "Today Usage",
"modelUsageBreakdown": "Model Usage Breakdown"
```

- [ ] **Step 2: Add status tag helper function in `StatusPage.vue`**

Inside `<script setup>` of `ui/app/pages/StatusPage.vue`:

```javascript
function getConcurrentStatusTagType(status) {
  switch (status) {
    case "ACTIVATED":
      return "success";
    case "ACTIVATING":
      return "primary";
    case "INACTIVE":
      return "info";
    case "RETIRED":
      return "danger";
    default:
      return "info";
  }
}

function capitalize(str) {
  if (!str || typeof str !== "string") return "";
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
```

- [ ] **Step 3: Update `state` interface in `StatusPage.vue` to capture `isConcurrentMode`**

Where `state` is updated from `/api/status`:

```javascript
state.isConcurrentMode = data.status.isConcurrentMode || false;
```

- [ ] **Step 4: Update Account List Item template in `StatusPage.vue`**

Update `.account-info` in `ui/app/pages/StatusPage.vue`:

```html
<div class="account-info">
  <span class="account-index">#{{ item.index }}</span>
  <span class="account-email" :class="{ 'is-error': item.isInvalid, 'is-duplicate': item.isDuplicate }">
    {{ getAccountDisplayName(item) }}
  </span>

  <template v-if="state.isConcurrentMode && item.concurrentStatus">
    <el-tag size="small" :type="getConcurrentStatusTagType(item.concurrentStatus)" class="status-tag">
      {{ t('status' + capitalize(item.concurrentStatus)) }}
      <span v-if="item.inFlight > 0" class="in-flight-badge">({{ item.inFlight }})</span>
    </el-tag>

    <el-tag v-if="item.isSuspended" size="small" type="warning" class="status-tag" :title="t('statusSuspended')">
      {{ t('statusSuspended') }}
    </el-tag>
  </template>

  <span v-if="item.index === state.currentAuthIndex" class="current-badge"> {{ t("tagCurrent") }} </span>
  <span v-if="item.isExpired" class="expired-badge"> {{ t("tagExpired") }} </span>

  <template v-if="state.isConcurrentMode && item.usage">
    <el-popover placement="top" :width="280" trigger="hover" effect="dark">
      <template #reference>
        <el-tag size="small" type="info" class="usage-tag"> {{ t('todayUsage') }}: {{ item.usage.total }} </el-tag>
      </template>
      <div class="usage-popover-content">
        <div class="popover-title">{{ t('modelUsageBreakdown') }}</div>
        <div v-for="(val, model) in item.usage.byModel" :key="model" class="popover-row">
          <span class="model-name">{{ model }}</span>
          <span class="model-count">{{ val.usage }} / {{ val.limit }}</span>
        </div>
      </div>
    </el-popover>
  </template>
</div>
```

- [ ] **Step 5: Add Less styles to `StatusPage.vue`**

Add CSS styles to `StatusPage.vue`:

```less
.status-tag {
  margin-left: 6px;
  font-size: 11px;
  padding: 0 6px;
  height: 20px;
  line-height: 18px;
}
.usage-tag {
  margin-left: 6px;
  cursor: pointer;
  font-size: 11px;
}
.in-flight-badge {
  margin-left: 2px;
  font-weight: bold;
}
.usage-popover-content {
  font-size: 12px;
  .popover-title {
    font-weight: bold;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.15);
  }
  .popover-row {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    .model-name {
      color: #e6a23c;
    }
    .model-count {
      color: #909399;
    }
  }
}
```

- [ ] **Step 6: Build UI production assets**

Run: `npm run build:ui`
Expected: Successful Vite compilation into `ui/dist/`.

- [ ] **Step 7: Commit changes**

```bash
git add ui/locales/zh.json ui/locales/en.json ui/app/pages/StatusPage.vue ui/dist/
git commit -m "feat(ui): display concurrent account status badges and model daily usage popovers in account management list

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Full Suite Verification & Linting

- [ ] **Step 1: Run all concurrent unit tests**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 2: Run linter on JS & CSS files**

Run: `npm run lint`
Expected: PASS (0 errors)

- [ ] **Step 3: Commit any formatting or lint fixes**

```bash
git add .
git commit -m "chore(ui): complete account status and model usage UI implementation"
```
