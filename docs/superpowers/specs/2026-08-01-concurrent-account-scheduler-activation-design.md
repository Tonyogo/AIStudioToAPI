# 并发账号调度器与懒加载激活机制设计规范

**日期:** 2026-08-01  
**状态:** 已批准 (Approved)

---

## 1. 概述与背景

在 AIStudioToAPI 的并发模式下，系统会维护多个 Google 账号的浏览器上下文（Browser Context）和 WebSocket 连接。但在 Google AI Studio 页面中，初次加载或背景唤醒时页面往往会被 `Launch/Rocket` 按钮遮罩挡住，导致该账号即便已连上 WebSocket，也无法直接响应模型推理请求，从而卡住请求。

为了解决此问题，本设计对 `src/concurrent/AccountScheduler.js` 进行重构升级，引入 **账号激活状态机（Account State Machine）**、**懒加载（Lazy Loading）巡检策略** 和 **自动探测激活流程（Activation Pipeline）**，确保调度器仅将请求分发给处于已激活（`ACTIVATED`）状态的健康账号。

---

## 2. 状态机与数据结构

`AccountScheduler` 内部维护 `accountStatusMap`（`Map<number, AccountState>`）：

```javascript
{
  status: "INACTIVE" | "ACTIVATING" | "ACTIVATED",
  lastActivatedAt: number | null,
  lastRequestAt: number | null
}
```

- **`INACTIVE`**：未激活状态（初始状态、激活失败、或断线重连后的默认状态）。
- **`ACTIVATING`**：正在执行激活流程（防止并发任务重复激活同一个账号）。
- **`ACTIVATED`**：已成功激活，页面 `Launch/Rocket` 按钮已清除，能够正常接收并处理 API 请求。

---

## 3. 懒加载与请求驱动激活策略

为了避免在没有 API 请求时频繁在后台切换账号造成 CPU/内存开销与无谓的 Context 切换：

1. **系统活跃度追踪**：
   - 记录 `lastSystemActivityAt`（最近一次收到客户端 API 请求的时间）。
   - 系统处于 **活跃期** 的判定条件：`Date.now() - lastSystemActivityAt < IDLE_TIMEOUT_MS`（默认 5 分钟）。

2. **空闲期行为（Idle Timeout）**：
   - 当系统进入 **空闲期**（无 API 请求超过 5 分钟）：
     - **暂停后台全账号轮询激活**。
     - 仅保持当前已 Switched 在前台的单一账号进行日常维持。

3. **按需与复苏激活（On-Demand Activation & Resumption）**：
   - 客户端新 API 请求到达时，更新 `lastSystemActivityAt = Date.now()`。
   - 若当前缺少处于 `ACTIVATED` 状态的可用账号，自动唤醒激活任务，异步或同步激活处于 `INACTIVE` 状态的在线账号。

---

## 4. 账号激活流程 (Activation Pipeline)

激活账号 `#i` 的具体步骤：

1. **状态锁**：设置 `accountStatusMap.set(i, { status: "ACTIVATING", ... })`。
2. **上下文切换**：调用 `await browserManager.launchOrSwitchContext(i)`，确保 Playwright page 与 UI 焦点切至账号 `#i`。
3. **模拟探测请求 (Active Trigger Probe)**：
   - 调用 `browserManager._sendActiveTrigger("[Scheduler]", page)` 向页面发送 `models?key=ActiveTrigger` 探测请求。
   - 探测请求会触发 `BrowserManager` 的 `BackgroundWakeup` 与 `Launch` 按钮自动检测与点击。
4. **状态判定**：
   - 探测请求与页面校验成功（或收到响应/确认就绪），将账号 `#i` 标记为 `ACTIVATED`，更新 `lastActivatedAt`。
   - 若过程出现异常/超时，将账号 `#i` 标记为 `INACTIVE` 并记录 Warn 日志。

---

## 5. 调度选择算法 (`getNextAuthIndex`)

分发请求时：

1. **刷新活跃时间**：更新 `lastSystemActivityAt = Date.now()`。
2. **筛选可调度的账号**：
   - 账号索引在 `authSource.availableIndices` 中且未被标记为 `expired`。
   - `connectionRegistry.hasConnection(i)` 为 true。
   - **账号状态为 `ACTIVATED`**。
3. **Round-Robin 轮询**：在符合条件的 `ACTIVATED` 账号集合中顺时针选出下一个账号。
4. **降级与同步激活（Fallback Activation）**：
   - 如果当前没有任何 `ACTIVATED` 账号，但存在有 WebSocket 连接的 `INACTIVE` 账号：
     - 选取顺位第一个 `INACTIVE` 账号，**同步触发其激活流程**。
     - 激活成功后，标记为 `ACTIVATED` 并立即返回该账号处理请求。
   - 若无任何在线可用账号，抛出 `503 Service Unavailable` 错误（提示 `"No active context connection available"`）。

---

## 6. 受影响文件与模块

- `src/concurrent/AccountScheduler.js`：重构调度算法，引入状态机、激活流程与懒加载逻辑。
- `src/concurrent/index.js`：传递 `browserManager` 引用给 `AccountScheduler`。
- `test/concurrent/account_scheduler.test.js`：更新单元测试，覆盖 `ACTIVATED` 过滤、懒加载与激活流程。
