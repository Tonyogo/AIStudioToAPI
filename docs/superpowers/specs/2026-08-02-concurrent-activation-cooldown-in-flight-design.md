# 并发账号 30s 激活冷却、默认双账号底座与负载驱动增量扩容设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在并发模式下，为了防止快速连续切换账号激活 Playwright 上下文导致浏览器或 Google 后端风控卡死，同时保证并发请求真正平摊打散到不同账号上（避免集中打在单一账号上），系统引入以下调度与激活策略：

1. **项目默认启动账号首发**：项目启动时默认激活的账号（如 `firstReady`）自动识别为首个 `ACTIVATED` 账号，无需对其重复执行激活。
2. **默认双账号底座（Baseline = 2）**：项目默认账号激活后，经过 30s 冷却，自动激活第 2 个在线账号，确保常态下维持至少 2 个 `ACTIVATED` 账号平摊并发。
3. **30 秒全局激活冷却（30s Global Activation Cooldown）**：任意两个账号之间的激活操作必须间隔至少 30 秒，同一时间仅允许激活 1 个账号。
4. **负载驱动增量扩容（Dynamic Scale-Out）**：当现有所有已激活账号都在处理请求（`inFlight > 0`）且存在在线 `INACTIVE` 账号时，只要满足 30s 激活冷却，主动激活新账号（账号池扩容至 3 个或更多），实现并发流量精准平摊。
5. **单账号最大并发限制（Max In-Flight = 2 per Account）**：单个账号同时处理的在途请求数不能超过 2 个。若所有可用账号在途数均达到 2，返回 503 报错。

---

## 2. 详细设计

### 2.1 状态感知与默认账号接入 (`AccountScheduler.js`)

- 当 `browserManager.currentAuthIndex >= 0` 且对应账号连接正常时，`AccountScheduler` 自动将其 `accountStatusMap` 状态标记为 `ACTIVATED`，避免重复对首发账号调用激活。

### 2.2 全局 30s 激活冷却机制 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中维护属性：
- `lastGlobalActivationAt`: 上一次尝试/完成激活的时间戳（初始 `0`）。
- `activationCooldownMs`: 冷却间隔，固定为 `30000`（30 秒）。

在 `activateAccount(authIndex)` 逻辑中：
- 判断 `Date.now() - this.lastGlobalActivationAt < this.activationCooldownMs`。
- 若冷却未满 30 秒，跳过本次激活，返回 `false`。
- 若满 30 秒，更新 `this.lastGlobalActivationAt = Date.now()` 并继续执行账号切换与探测激活。

### 2.3 在途并发计数器 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中维护 `inFlightMap`（`Map<number, number>`）与生命周期方法：
- `getInFlightCount(authIndex)`: 返回账号当前在途请求数，默认 `0`。
- `acquireInFlight(authIndex)`: 当前账号在途数 `+1`。
- `releaseInFlight(authIndex)`: 当前账号在途数 `-1`（最小为 `0`）。

### 2.4 双账号底座与增量扩容调度算法 (`getNextAuthIndex`)

更新 `getNextAuthIndex(modelName)` 调度选择逻辑：

1. **自动维持双账号底座 (Baseline = 2 Check)**：
   - 若当前 `ACTIVATED` 账号数量 `< 2` 且存在在线 `INACTIVE` 账号，且 30s 冷却已满：
   - 优先同步激活下一个 `INACTIVE` 账号，快速补齐双账号底座。
2. **分类计算**：
   - 提取模型每日上限 `limit = getModelDailyLimit(modelName)`。
   - 收集所有在线 WebSocket 连接（`hasConnection(i) === true`）且用量未超限（`usage < limit`）的账号：
     - `activatedFree`: 已激活且绝对空闲（`inFlight === 0`）。
     - `activatedBusy`: 已激活但正在处理 1 个请求（`inFlight === 1`）。
     - `inactiveCandidates`: 在线未激活账号（`status === "INACTIVE"` 且 `inFlight < 2`）。
3. **多阶段优先级选择与打散**：
   - **阶段一（绝对空闲优先）**：若 `activatedFree` 非空，从中挑选当前模型用量 `usage` 最小的账号（用量相同按 Round-Robin）直接分发。
   - **阶段二（负载驱动增量扩容）**：若无绝对空闲已激活账号（即已激活账号都在处理请求 `inFlight > 0`），且存在 `inactiveCandidates`：
     - 检查 30s 激活冷却：若 `Date.now() - lastGlobalActivationAt >= 30000`：
       - 主动对 `inactiveCandidates` 中用量最少的账号调用 `activateAccount(idx)`。
       - 激活成功后立即返回该账号分发请求，实现新的并发请求分流至新账号。
   - **阶段三（复用轻度繁忙账号）**：若无法激活新账号（或 30s 冷却未满/无 `inactiveCandidates`），且 `activatedBusy` 非空：
     - 分发给 `activatedBusy` 中 `usage` 最小的账号（`inFlight = 1 -> 2`）。
   - **阶段四（强制降级等待/激活）**：若所有已激活账号的 `inFlight >= 2` 且存在 `inactiveCandidates`：
     - 尝试同步/等待 30s 冷却完成后激活 `inactiveCandidates` 账号。
4. **全繁忙报错 (503 Service Unavailable)**：
   - 若所有在线账号的在途数均满足 `inFlightCount >= 2`：
   - 抛出 HTTP 状态码 **503** 的 Error：
     ```javascript
     const error = new Error("All available accounts are busy at maximum concurrency limit (2/2)");
     error.statusCode = 503;
     error.statusText = "UNAVAILABLE";
     throw error;
     ```

### 2.5 请求拦截器与配对释放 (`ConcurrentRequestHandler.js`)

在 `ConcurrentRequestHandler.js` 的 `handleGeminiRequest` 中：

```javascript
let authIndex;
try {
    authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
    this.scheduler.acquireInFlight(authIndex); // 在途请求 +1
} catch (err) {
    const statusCode = err.statusCode || 503;
    const statusText = err.statusText || (statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE");
    return res.status(statusCode).json({
        error: { code: statusCode, message: err.message, status: statusText }
    });
}

try {
    if (cleanModelName) {
        this.scheduler.recordUsage(authIndex, cleanModelName);
    }
    // 执行 WebSocket 透传处理 ...
} finally {
    // try ... finally 确保无论成功、失败还是客户端提前断开，均能释放计数
    this.scheduler.releaseInFlight(authIndex); // 在途请求 -1
}
```

---

## 3. 受影响文件

* `src/concurrent/AccountScheduler.js`：实现默认启动账号自动感知、双账号底座（Baseline=2）维持、30s 激活冷却与主动扩容打散调度。
* `src/concurrent/ConcurrentRequestHandler.js`：配对调用 `acquireInFlight` / `releaseInFlight`。
* `test/concurrent/account_scheduler.test.js`：更新单元测试，覆盖默认账号识别、双账号底座自动拉起与打散分发。
