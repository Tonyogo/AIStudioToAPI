# 并发账号 30s 激活冷却、主动扩容打散与单账号最大并发限制设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在并发模式下，为了防止快速连续切换账号激活 Playwright 上下文导致浏览器或 Google 后端风控卡死，同时保证并发请求真正平摊打散到不同账号上（避免集中打在单一账号上），系统引入以下三条调度策略：

1. **30 秒全局激活冷却（30s Global Activation Cooldown）**：任意两个账号之间的激活操作必须间隔至少 30 秒。
2. **主动并发扩容打散（Proactive Scale-Out & Spreading）**：当现有已激活账号都在处理请求（`inFlight > 0`）且存在在线 `INACTIVE` 账号时，只要满足 30s 激活冷却，主动激活新账号并分配请求，实现真正的多账号并发平摊。
3. **单账号最大并发请求限制（Max In-Flight = 2 per Account）**：单个账号同时处理的在途请求数不能超过 2 个。若所有可用账号的在途数均达到 2，返回 503 报错。

---

## 2. 详细设计

### 2.1 全局 30s 激活冷却机制 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中维护属性：
- `lastGlobalActivationAt`: 上一次尝试/完成激活的时间戳（初始 `0`）。
- `activationCooldownMs`: 冷却间隔，固定为 `30000`（30 秒）。

在 `activateAccount(authIndex)` 逻辑中：
- 判断 `Date.now() - this.lastGlobalActivationAt < this.activationCooldownMs`。
- 若冷却未满 30 秒，跳过本次激活，返回 `false`。
- 若满 30 秒，更新 `this.lastGlobalActivationAt = Date.now()` 并继续执行账号切换与探测激活。

### 2.2 在途并发计数器 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中维护 `inFlightMap`（`Map<number, number>`）与生命周期方法：
- `getInFlightCount(authIndex)`: 返回账号当前在途请求数，默认 `0`。
- `acquireInFlight(authIndex)`: 当前账号在途数 `+1`。
- `releaseInFlight(authIndex)`: 当前账号在途数 `-1`（最小为 `0`）。

### 2.3 主动扩容与打散调度算法 (`getNextAuthIndex`)

更新 `getNextAuthIndex(modelName)` 调度选择逻辑：

1. **分类计算**：
   - 提取模型每日上限 `limit = getModelDailyLimit(modelName)`。
   - 收集所有在线 WebSocket 连接（`hasConnection(i) === true`）且用量未超限（`usage < limit`）的账号：
     - `activatedFree`: 已激活且绝对空闲（`inFlight === 0`）。
     - `activatedBusy`: 已激活但正在处理 1 个请求（`inFlight === 1`）。
     - `inactiveCandidates`: 在线未激活账号（`status === "INACTIVE"` 且 `inFlight < 2`）。
2. **多阶段优先级选择与打散**：
   - **阶段一（绝对空闲优先）**：若 `activatedFree` 非空，从中挑选当前模型用量 `usage` 最小的账号（用量相同按 Round-Robin）直接分发。
   - **阶段二（主动并发扩容打散）**：若无绝对空闲已激活账号（即已激活账号都在处理请求 `inFlight > 0`），且存在 `inactiveCandidates`：
     - 检查 30s 激活冷却：若 `Date.now() - lastGlobalActivationAt >= 30000`：
       - 主动对 `inactiveCandidates` 中用量最少的账号调用 `activateAccount(idx)`。
       - 激活成功后立即返回该账号分发请求，实现新的并发请求分流至新账号。
   - **阶段三（复用轻度繁忙账号）**：若无法激活新账号（或 30s 冷却未满/无 `inactiveCandidates`），且 `activatedBusy` 非空：
     - 分发给 `activatedBusy` 中 `usage` 最小的账号（`inFlight = 1 -> 2`）。
   - **阶段四（强制降级等待/激活）**：若所有已激活账号的 `inFlight >= 2` 且存在 `inactiveCandidates`：
     - 尝试同步/等待 30s 冷却完成后激活 `inactiveCandidates` 账号。
3. **全繁忙报错 (503 Service Unavailable)**：
   - 若所有在线账号的在途数均满足 `inFlightCount >= 2`：
   - 抛出 HTTP 状态码 **503** 的 Error：
     ```javascript
     const error = new Error("All available accounts are busy at maximum concurrency limit (2/2)");
     error.statusCode = 503;
     error.statusText = "UNAVAILABLE";
     throw error;
     ```

### 2.4 请求拦截器与配对释放 (`ConcurrentRequestHandler.js`)

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

* `src/concurrent/AccountScheduler.js`：重构 `getNextAuthIndex` 主动扩容打散算法、30s 激活冷却与 `inFlight` 控制。
* `src/concurrent/ConcurrentRequestHandler.js`：配对调用 `acquireInFlight` / `releaseInFlight`。
* `test/concurrent/account_scheduler.test.js`：增加主动并发扩容打散测试与 30s 冷却测试。
