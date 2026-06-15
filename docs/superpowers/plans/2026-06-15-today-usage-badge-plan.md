# Today's Usage Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a timezone-aware "Today's Model Usage Count" badge to individual account items on the Account Management list. The badge shows today's successful usage count (including non-generation successfully completed requests) with a detailed hover tooltip containing the successful model usage breakdown.

**Architecture:** Client-side aggregation computed reactively over periodically synced `statsState.records` history database. Completely avoids backend modification, preserving absolute timezone offset parity with the Statistics tab.

**Tech Stack:** Vue.js 3, Element Plus (`el-tooltip`), Less CSS.

---

## File Structure

We will modify the following existing files:
- `ui/locales/en.json`: English translation dict.
- `ui/locales/zh.json`: Chinese translation dict.
- `ui/app/pages/StatusPage.vue`: StatusPage page view, including state computed logic, DOM badge placement, and Less styles.

---

### Task 1: English Dictionary Translation Keys

**Files:**
- Modify: `ui/locales/en.json`

- [ ] **Step 1: Edit `ui/locales/en.json` to append keys near line 308**

Replace:
```json
    "warningDisableCurrentAccount": "You are disabling the current active account. The system will automatically switch to another account if available. Continue?",
    "warningTitle": "Warning",
    "zipExtractFailed": "Extract failed",
    "zipNoJsonFiles": "No JSON files in archive"
}
```
With:
```json
    "todayUsage": "Today: {count}",
    "todayUsageTooltipHeader": "Successful Requests Today (since 15:00):",
    "warningDisableCurrentAccount": "You are disabling the current active account. The system will automatically switch to another account if available. Continue?",
    "warningTitle": "Warning",
    "zipExtractFailed": "Extract failed",
    "zipNoJsonFiles": "No JSON files in archive"
}
```

- [ ] **Step 2: Commit translation changes**

```bash
git add ui/locales/en.json
git commit -m "intl: add today usage translation keys for English locale"
```

---

### Task 2: Chinese Dictionary Translation Keys

**Files:**
- Modify: `ui/locales/zh.json`

- [ ] **Step 1: Edit `ui/locales/zh.json` to append keys near line 308**

Replace:
```json
    "warningDisableCurrentAccount": "你正在禁用当前活跃的账号。系统将自动切换到其他可用账号。是否继续？",
    "warningTitle": "警告",
    "zipExtractFailed": "解压失败",
    "zipNoJsonFiles": "压缩包内无 JSON 文件"
}
```
With:
```json
    "todayUsage": "今日: {count}",
    "todayUsageTooltipHeader": "今日成功请求（15:00起）：",
    "warningDisableCurrentAccount": "你正在禁用当前活跃的账号。系统将自动切换到其他可用账号。是否继续？",
    "warningTitle": "警告",
    "zipExtractFailed": "解压失败",
    "zipNoJsonFiles": "压缩包内无 JSON 文件"
}
```

- [ ] **Step 2: Commit translation changes**

```bash
git add ui/locales/zh.json
git commit -m "intl: add today usage translation keys for Chinese locale"
```

---

### Task 3: Vue Today Usage Computed Aggregator Logic

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Read and modify `ui/app/pages/StatusPage.vue` to add `getTodayStartTimestamp` and `accountTodayStats` computed property around line 3469 (near the end of computed blocks)**

Find:
```javascript
const filteredModels = computed(() => {
    const records = filteredRecords.value;
    if (!records.length) return [];
    ...
    return Object.values(modelMap)
        ...
        .sort((a, b) => b.totalRequests - a.totalRequests);
});
```

Add below it:
```javascript
const getTodayStartTimestamp = () => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0, 0, 0);
    if (now.getTime() < startOfToday.getTime()) {
        startOfToday.setDate(startOfToday.getDate() - 1);
    }
    return startOfToday.getTime();
};

const accountTodayStats = computed(() => {
    const startTs = getTodayStartTimestamp();
    const statsMap = {};

    statsState.records.forEach(record => {
        const ts = record.startedAt ? new Date(record.startedAt).getTime() : 0;
        if (ts >= startTs && record.outcome === "success") {
            const key = record.finalAuthIndex;
            if (key === null || key === undefined) return;

            if (!statsMap[key]) {
                statsMap[key] = { totalSuccess: 0, models: {} };
            }
            statsMap[key].totalSuccess += 1;
            
            const modelName = record.model || t("unknown");
            statsMap[key].models[modelName] = (statsMap[key].models[modelName] || 0) + 1;
        }
    });

    return statsMap;
});
```

- [ ] **Step 2: Commit computed logic additions**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "feat: implement timezone-aware today usage computed metrics for accounts in StatusPage"
```

---

### Task 4: UI DOM Integration inside Account List Item

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Open `ui/app/pages/StatusPage.vue` and integrate the `<el-tooltip>` element inside the `<div class="account-info">` container**

Find:
```html
                                <el-tooltip
                                    :content="getAccountDisplayName(item)"
                                    placement="top"
                                    effect="dark"
                                    :hide-after="0"
                                >
                                    <div class="account-info">
                                        <span class="account-index">#{{ item.index }}</span>
                                        <span
                                            class="account-email"
                                            :class="{ 'is-error': item.isInvalid, 'is-duplicate': item.isDuplicate }"
                                        >
                                            {{ getAccountDisplayName(item) }}
                                        </span>
                                        <span v-if="item.index === state.currentAuthIndex" class="current-badge">
                                            {{ t("tagCurrent") }}
                                        </span>
                                        <span v-if="item.isExpired" class="expired-badge">
                                            {{ t("tagExpired") }}
                                        </span>
                                        <span v-if="item.isDisabled" class="disabled-badge">
                                            {{ t("tagDisabled") }}
                                        </span>
                                    </div>
                                </el-tooltip>
```

Replace and insert the badge:
```html
                                <el-tooltip
                                    :content="getAccountDisplayName(item)"
                                    placement="top"
                                    effect="dark"
                                    :hide-after="0"
                                >
                                    <div class="account-info">
                                        <span class="account-index">#{{ item.index }}</span>
                                        <span
                                            class="account-email"
                                            :class="{ 'is-error': item.isInvalid, 'is-duplicate': item.isDuplicate }"
                                        >
                                            {{ getAccountDisplayName(item) }}
                                        </span>
                                        <span v-if="item.index === state.currentAuthIndex" class="current-badge">
                                            {{ t("tagCurrent") }}
                                        </span>
                                        <span v-if="item.isExpired" class="expired-badge">
                                            {{ t("tagExpired") }}
                                        </span>
                                        <span v-if="item.isDisabled" class="disabled-badge">
                                            {{ t("tagDisabled") }}
                                        </span>
                                        <el-tooltip
                                            v-if="accountTodayStats[item.index]?.totalSuccess > 0"
                                            placement="top"
                                            effect="dark"
                                            :hide-after="0"
                                        >
                                            <template #content>
                                                <div class="today-usage-tooltip">
                                                    <div style="font-weight: bold; margin-bottom: 4px;">
                                                        {{ t("todayUsageTooltipHeader") }}
                                                    </div>
                                                    <div v-for="(count, model) in accountTodayStats[item.index]?.models" :key="model">
                                                        {{ model }}: {{ count }}
                                                    </div>
                                                </div>
                                            </template>
                                            <span class="today-usage-badge" @click.stop>
                                                {{ t("todayUsage", { count: accountTodayStats[item.index].totalSuccess }) }}
                                            </span>
                                        </el-tooltip>
                                    </div>
                                </el-tooltip>
```

- [ ] **Step 2: Commit DOM structure modifications**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "feat: embed today usage badge and hover breakdown tooltip in account list item"
```

---

### Task 5: CSS Styles Integration

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Add Less CSS style declarations near line 5729 (near other badges like `.disabled-badge`)**

Find:
```less
.disabled-badge {
    font-size: 0.75rem;
    padding: 2px 8px;
    background: @text-secondary;
    color: @text-on-primary;
    border-radius: 12px;
    flex-shrink: 0;
    margin-left: 0;
    margin-right: 6px;
}
```

Add below it:
```less
.today-usage-badge {
    font-size: 0.75rem;
    padding: 2px 8px;
    background-color: rgba(var(--color-primary-rgb), 0.1);
    color: @primary-color;
    border: 1px solid rgba(var(--color-primary-rgb), 0.2);
    border-radius: 12px;
    flex-shrink: 0;
    margin-left: 6px;
    margin-right: 6px;
    font-weight: 500;
    cursor: help;
    transition: all 0.2s;

    &:hover {
        background-color: @primary-color;
        color: #ffffff;
    }
}

.today-usage-tooltip {
    font-size: 0.85rem;
    line-height: 1.4;
}
```

- [ ] **Step 2: Commit style changes**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "style: style the today usage badge and tooltip with Less vars in StatusPage"
```

---

## Verification Plan

### Lint & Cleanliness Check
```bash
npm run lint
```
Expected: NO errors or warnings from ESLint/Stylelint.

### Build and Local Sandbox Verification
1. Run the development environment:
   `npm run dev`
2. Open the console panel in the browser.
3. Access "Usage Stats" tab, make sure statistics records exist.
4. Go back to "Console Panel / Home" tab and verify:
   - Account list displays a custom light-blue badge `Today: X` next to accounts that successfully completed API calls since 15:00.
   - Hovering over the badge shows a dark tooltip list containing exact model counts.
   - Badge updates live as requests are made or statistics refresh.
