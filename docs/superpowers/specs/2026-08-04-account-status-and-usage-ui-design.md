# 前端账号管理显示账号并发状态与模型用量设计规范

**日期:** 2026-08-04  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在并发模式 (`ENABLE_CONCURRENT=true`) 下，系统引入了多账号状态机（`ACTIVATED`、`ACTIVATING`、`INACTIVE`、`RETIRED`）以及按北京时间 15:00 计量的模型用量与每日上限。当前 Web UI 前端面板在“账号管理”列表中仅展示了邮箱、`#index` 与当前/过期标签，缺乏并发状态与用量数据的展现。

本规范旨在将后端的并发状态、隔离挂起状态 (`isSuspended`)、在途请求数 (`inFlight`) 以及各模型的每日使用量/上限无缝集成并展示到前端“账号管理”列表中。

---

## 2. 后端数据接口扩展

### 2.1 `ModelUsageTracker.js` 扩展

增加 `getAccountUsageDetails(authIndex, modelList)` 方法：

```javascript
getAccountUsageDetails(authIndex, modelList = []) {
    const usageMap = this.usageData[authIndex] || {};
    let totalUsage = 0;
    const byModel = {};

    const effectiveModelList = Array.isArray(modelList) && modelList.length > 0
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

### 2.2 `StatusRoutes.js` (`GET /api/status`) 结构扩展

在 `_getStatusData()` 方法中，组装每个账号条目 `accountDetails` 时，引入并发子系统的数据：

```javascript
const concurrent = this.serverSystem.concurrentComponents;
const isConcurrentMode = process.env.ENABLE_CONCURRENT === "true";

const accountDetails = initialIndices.map(index => {
    // ... 原有逻辑 ...
    const concurrentStatus = concurrent?.scheduler ? concurrent.scheduler.getAccountStatus(index) : null;
    const inFlight = concurrent?.scheduler ? concurrent.scheduler.getInFlightCount(index) : 0;
    const isSuspended = concurrent?.scheduler ? concurrent.scheduler.isAccountSuspended(index) : false;
    const usageInfo = concurrent?.modelUsageTracker
        ? concurrent.modelUsageTracker.getAccountUsageDetails(index, config.modelList)
        : { byModel: {}, total: 0 };

    return {
        canonicalIndex,
        concurrentStatus, // "ACTIVATED" | "ACTIVATING" | "INACTIVE" | "RETIRED" | null
        hasContext,
        inFlight,
        index,
        isDuplicate,
        isExpired,
        isInvalid,
        isRotation,
        isSuspended,
        name,
        usage: usageInfo, // { total: number, byModel: { "gemini-2.5-flash": { usage: 10, limit: 1000 } } }
    };
});
```

根级 `status` 返回对象中增加 `isConcurrentMode` 字段：
```javascript
status: {
    ...
    isConcurrentMode,
    ...
}
```

---

## 3. 前端 UI 与国际化 (i18n) 设计

### 3.1 国际化多语言词条 (`ui/locales/zh.json` 与 `ui/locales/en.json`)

**`zh.json` 新增：**
```json
{
  "statusActivated": "已激活",
  "statusActivating": "激活中",
  "statusInactive": "未激活",
  "statusRetired": "已退休",
  "statusSuspended": "已隔离",
  "todayUsage": "今日用量",
  "modelUsageBreakdown": "模型用量明细"
}
```

**`en.json` 新增：**
```json
{
  "statusActivated": "Activated",
  "statusActivating": "Activating",
  "statusInactive": "Inactive",
  "statusRetired": "Retired",
  "statusSuspended": "Suspended",
  "todayUsage": "Today Usage",
  "modelUsageBreakdown": "Model Usage Breakdown"
}
```

### 3.2 UI 渲染 (`ui/app/pages/StatusPage.vue`)

在账号列表项的 `.account-info` 容器内添加：
1. **并发状态 Tag** (`el-tag`)：
   - `ACTIVATED`: `type="success"` ("已激活")
   - `ACTIVATING`: `type="primary"` ("激活中")
   - `INACTIVE`: `type="info"` ("未激活")
   - `RETIRED`: `type="danger"` ("已退休")
   - 在途请求：若 `inFlight > 0`，在 Tag 内显示在途数量如 `(1)`
2. **挂起隔离 Tag** (`isSuspended === true`): `type="warning"` ("已隔离")
3. **今日用量 Popover 悬浮标签** (`el-popover` + `el-tag`):
   - 标签显示：`今日用量: 125`
   - 悬浮展开明细列表，展示各模型使用情况：`gemini-2.5-flash: 100 / 1000`，`gemini-2.5-pro: 25 / 50`。

---

## 4. 受影响文件列表

- `src/concurrent/ModelUsageTracker.js`：添加 `getAccountUsageDetails` Helper 方法。
- `src/routes/StatusRoutes.js`：在 `GET /api/status` 的 `_getStatusData()` 中组装并发状态、在途数、挂起标识与模型用量。
- `ui/locales/zh.json` & `ui/locales/en.json`：补充多语言词条。
- `ui/app/pages/StatusPage.vue`：更新模板渲染 Element Plus Tags 与 Popover，添加配套样式并构建。
