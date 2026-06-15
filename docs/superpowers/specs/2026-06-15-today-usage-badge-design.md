---
name: today-usage-badge
description: Add Today's successful model usage count display with model breakdown tooltip on account management list
metadata:
  type: project
---

# Design Spec: Today's Model Usage Count Display in Account Management

This specification details the design for adding a timezone-aware "Today's Model Usage Count" display to individual account cards on the control panel's Account Management section, utilizing client-side aggregation over periodically synced history with detailed hover tooltips.

## 1. Requirements

- **Option 1-C**: Today's successful request count is computed dynamically based on successful transactions (outcome === "success") in the request history, regardless of whether they are generations, token counts, or other types.
- **Option 2-A**: Displayed as a compact, pill-shaped badge next to each account email. On hover, a tooltip presents the detailed breakdown of the models successfully called under that account.
- **Timezone Alignment**: The start boundary for "Today" matches the Statistics view, which defaults to `15:00:00` of either calendar yesterday or calendar today depending on the user's current clock.

---

## 2. Architecture & Implementation

The entire logic runs on the client-side within `ui/app/pages/StatusPage.vue`. It leverages the periodically fetched `statsState.records` dataset which holds the complete historical request database. This avoids any timezone-synchronization complexity on the server or new API changes.

### 2.1 Today's Boundary Utility
We calculate the timezone-aware 15:00:00 start boundary in milliseconds:
```javascript
const getTodayStartTimestamp = () => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0, 0, 0);
    if (now.getTime() < startOfToday.getTime()) {
        startOfToday.setDate(startOfToday.getDate() - 1);
    }
    return startOfToday.getTime();
};
```

### 2.2 Reactively Computed Usage Aggregation
We define a computed map `accountTodayStats` indexing each account (by `authIndex`) to its successful usage count and model distribution:
```javascript
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

### 2.3 UI Components (Badge & Tooltip)
We display the badge using an `el-tooltip` inside each `account-list-item`:
```html
<el-tooltip placement="top" effect="dark" :hide-after="0">
    <template #content>
        <div class="today-usage-tooltip">
            <div style="font-weight: bold; margin-bottom: 4px;">
                {{ t("todayUsageTooltipHeader") }}
            </div>
            <div v-for="(count, model) in accountTodayStats[item.index]?.models" :key="model">
                {{ model }}: {{ count }}
            </div>
            <div v-if="!accountTodayStats[item.index]?.totalSuccess">
                -
            </div>
        </div>
    </template>
    <span 
        v-if="accountTodayStats[item.index]?.totalSuccess > 0" 
        class="today-usage-badge"
    >
        {{ t("todayUsage", { count: accountTodayStats[item.index].totalSuccess }) }}
    </span>
</el-tooltip>
```

---

## 3. Localization and Assets

We declare translations in both localization dictionaries.

### 3.1 `ui/locales/en.json`
```json
"todayUsage": "Today: {count}",
"todayUsageTooltipHeader": "Successful Requests Today (since 15:00):"
```

### 3.2 `ui/locales/zh.json`
```json
"todayUsage": "今日: {count}",
"todayUsageTooltipHeader": "今日成功请求（15:00起）："
```

---

## 4. Less Styling Details

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
