# 原生激活联动与智能负载均衡并发调度设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在之前的并发调度实现中，`AccountScheduler` 内部自己重复编写了一套账号激活流程，与 `BrowserManager` 原生的账号切换/激活流程（`launchOrSwitchContext` / `switchAccount`）产生了重复与鼠标争用，导致新账号切换时未能成功解卡并卡在 Launch 按钮遮罩上。

本设计旨在**彻底去重并精简调度逻辑**：
1. **复用原生激活**：完全依赖 `BrowserManager` 原生的账号切换/激活与 Launch 按钮处理流程，`AccountScheduler` 不再重复实现自定义重度激活逻辑。
2. **准确记录激活状态**：`AccountScheduler` 仅记录和维护账号的激活状态（`accountStatusMap`），当 `BrowserManager` 激活账号或 WebSocket 建立完成时自动同步为 `ACTIVATED`。
3. **精准打散与配额均衡调度**：调度时仅从 `ACTIVATED` 账号中筛选，按照 **“在途并发数最少 (In-Flight Least) + 该模型每日用量最少 (Model Usage Least)”** 进行双重打散与优先分发。

---

## 2. 详细设计

### 2.1 原生激活状态同步 (`AccountScheduler.js`)

- **状态定义**：`INACTIVE` | `ACTIVATING` | `ACTIVATED`。
- **自动同步机制**：
  - 当 `browserManager.currentAuthIndex` 发生切换或确定时，`AccountScheduler` 自动将其状态记录/同步为 `ACTIVATED`。
  - 提供 `markAccountActivated(authIndex)` 与 `markAccountInactive(authIndex)` API 供 `BrowserManager` 或连接监听器回调调用。

### 2.2 在途并发与配额统计

- **在途并发数 (`inFlightMap`)**：单个账号最大允许 2 个在途请求（`maxInFlightPerAccount = 2`）。
  - 请求开始时：调用 `acquireInFlight(authIndex)`（`inFlight + 1`）。
  - 请求结束/异常/断开时：在 `try ... finally` 中调用 `releaseInFlight(authIndex)`（`inFlight - 1`）。
- **每日模型配额 (`ModelUsageTracker`)**：统计北京时间 15:00 周期内每个账号对特定模型的调用次数，并受 `configs/models.json` 中的 `dailyLimit` 约束。

### 2.3 简化高效的调度选择算法 (`getNextAuthIndex`)

当 API 请求到达时，`AccountScheduler.getNextAuthIndex(modelName)` 按照以下规则选择账号：

1. **提取模型每日上限**：`limit = getModelDailyLimit(modelName)`。
2. **筛选合格账号 (Candidate Filtering)**：
   扫描所有账号，仅保留同时满足以下 4 个条件的账号：
   * `getAccountStatus(idx) === "ACTIVATED"`（账号已被 BrowserManager 激活并就绪）。
   * `_hasConnection(idx) === true`（WebSocket 长连接正常且处于 OPEN 状态）。
   * `tracker.getUsage(idx, modelName) < limit`（当前模型每日用量未超限）。
   * `getInFlightCount(idx) < 2`（当前账号在途并发数未满）。
3. **双重优先级打散排序 (Sorting)**：
   对符合条件的 `ACTIVATED` 账号候选列表按以下顺序排序：
   * **一重排序（并发平摊优先）**：在途并发数 `inFlightCount` 升序（`inFlight == 0` 的绝对空闲账号最优先）。
   * **二重排序（每日配额均衡）**：当前模型在当天的累积用量 `usageCount` 升序（用量较少的优先）。
   * **三重排序（Round-Robin 兜底）**：按顺时针游标相对位置排序。
4. **选择与返回**：
   * 选出排序第 1 位的账号 `selectedIdx` 并返回，同时更新 Round-Robin 游标。
5. **按需原生切换 (Native Switch Fallback)**：
   * 若无就绪的 `ACTIVATED` 账号，但存在符合条件的在线 `INACTIVE` 账号：
   * 调用 `await browserManager.launchOrSwitchContext(candidateIdx)` 执行安全的原生账号切换（自动触发 `_activateContext` + `_startBackgroundWakeup` 点击 Launch 按钮）。
   * 切换成功后将该账号标记为 `ACTIVATED` 并返回。
6. **全繁忙与全超限异常处理**：
   * 若所有在线账号均因 `usage >= limit` 被过滤：抛出 429 (`RESOURCE_EXHAUSTED`) 错误。
   * 若所有在线账号均因 `inFlight >= 2` 被过滤：抛出 503 (`UNAVAILABLE`) 错误。

---

## 3. 受影响文件

* `src/concurrent/AccountScheduler.js`：移除冗余重复的激活逻辑，实现原生激活状态同步、`inFlight` 与 `modelUsage` 双重最少优先调度。
* `src/concurrent/ConcurrentRequestHandler.js`：保持 `acquireInFlight` / `releaseInFlight` 的 `try ... finally` 配对生命周期。
* `test/concurrent/account_scheduler.test.js`：更新单元测试，覆盖原生激活同步、`inFlight` 打散与模型用量平摊。
