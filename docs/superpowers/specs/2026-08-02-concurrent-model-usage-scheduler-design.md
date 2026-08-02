# 按模型每日配额均衡调度系统设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)

---

## 1. 概述与目标

在 AIStudioToAPI 的并发模式下，为了保证各个 Google 账号针对不同模型（如 `gemini-2.5-flash`、`gemini-2.5-pro` 等）的每日限额（Quota）得到均匀消耗，系统需要从简单的纯 Round-Robin 轮询调度升级为 **按模型每日配额均衡调度（Model-Based Daily Quota Load Balancing Scheduler）**。

核心目标：

1. 粒度精确到 **账号 (`authIndex`) + 模型名 (`modelName`)**。
2. 统计周期以 **每日北京时间 15:00:00 (UTC+8)** 为界，跨越 15:00 自动重置归零。
3. 调度时针对请求的模型，**优先选择当前周期内该模型使用次数最少（Least-Used）** 的激活状态账号。
4. 统计数据持久化保存至本地 JSON 文件，服务重启后自动读取恢复，保持配额连续性。

---

## 2. 详细设计

### 2.1 配额周期计算 (Beijing 15:00 Cycle Management)

配额周期的起始时间按北京时间 15:00 计算：

```javascript
function getBeijingCycleKey(nowDate = new Date()) {
  // 北京时间比 UTC 快 8 小时
  const beijingTime = new Date(nowDate.getTime() + 8 * 3600 * 1000);
  const year = beijingTime.getUTCFullYear();
  const month = String(beijingTime.getUTCMonth() + 1).padStart(2, "0");
  const day = beijingTime.getUTCDate();
  const hours = beijingTime.getUTCHours();

  let cycleDate = new Date(Date.UTC(year, beijingTime.getUTCMonth(), day));
  // 如果当前北京时间小于 15 点，则属于前一天 15:00 开始的周期
  if (hours < 15) {
    cycleDate.setUTCDate(cycleDate.getUTCDate() - 1);
  }

  const cYear = cycleDate.getUTCFullYear();
  const cMonth = String(cycleDate.getUTCMonth() + 1).padStart(2, "0");
  const cDay = String(cycleDate.getUTCDate()).padStart(2, "0");

  return `${cYear}-${cMonth}-${cDay}_15:00`;
}
```

### 2.2 `ModelUsageTracker` 模块 (`src/concurrent/ModelUsageTracker.js`)

负责模型的计数、重置与磁盘持久化：

- **文件路径**：`data/concurrent-model-usage.json`
- **内存结构**：
  ```javascript
  {
    cycleKey: "2026-08-01_15:00",
    stats: {
      "0": { "gemini-2.5-flash": 12, "gemini-2.5-pro": 3 },
      "1": { "gemini-2.5-flash": 10, "gemini-2.5-pro": 5 }
    }
  }
  ```
- **核心 API**：
  - `_checkAndResetCycle()`：每次读写前比对 `getBeijingCycleKey()`，若 Key 改变则清空 `stats` 并保存。
  - `getUsage(authIndex, modelName)`：返回指定账号对应模型的当前周期使用数。
  - `recordUsage(authIndex, modelName)`：计数 `+1` 并触发 500ms 异步防抖保存（Debounce File Save）。
  - `loadSync()` / `saveSync()`：用于服务器启动加载和退出时同步保存。

### 2.3 `AccountScheduler` 最小使用量优先调度算法 (`src/concurrent/AccountScheduler.js`)

更新 `getNextAuthIndex(modelName)` 接口：

1. **获取候选账号**：筛选出 `connectionRegistry.hasConnection(i)` 为 true 且 `getAccountStatus(i) === "ACTIVATED"` 的在线已激活账号列表。
2. **最小使用量排序**：
   - 提取各账号针对 `modelName` 的当前使用量 `count = tracker.getUsage(i, modelName)`。
   - **主排序条件**：`count` 升序（次数少的优先）。
   - **次排序条件（Round-Robin 兜底）**：若 `count` 相同，保持从 `currentIndex` 游标开始顺时针遍历的相对顺序。
3. **分发与更新**：选出最优账号，更新 `currentIndex` 并返回。若无 `ACTIVATED` 账号，对 `INACTIVE` 账号按相同规则进行同步激活降级。
4. **计数自增**：暴露 `recordUsage(authIndex, modelName)` 给请求处理器调用。

### 2.4 `ConcurrentRequestHandler` 链路集成 (`src/concurrent/ConcurrentRequestHandler.js`)

1. **模型名提取**：从 `req.path` 解析标准模型名（如从 `/v1beta/models/gemini-2.5-flash:generateContent` 剥离出 `gemini-2.5-flash`）。
2. **调度选择**：调用 `await this.scheduler.getNextAuthIndex(modelName)`。
3. **记录使用**：在请求发送时调用 `this.scheduler.recordUsage(authIndex, modelName)`。

---

## 3. 受影响文件

- `src/concurrent/ModelUsageTracker.js`：新建模型配额跟踪与持久化组件。
- `src/concurrent/AccountScheduler.js`：集成 `ModelUsageTracker`，实现最小使用量优先算法。
- `src/concurrent/ConcurrentRequestHandler.js`：提取模型名，传入调度器并记录使用次数。
- `test/concurrent/model_usage_tracker.test.js`：新建配额跟踪器与北京时间 15:00 周期测试。
- `test/concurrent/account_scheduler.test.js`：更新调度器测试，增加最小使用量调度验证。
