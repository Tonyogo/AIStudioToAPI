# 并发账号 30s 激活冷却与单账号最大并发限制设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在并发模式下，为了防止快速连续切换账号激活 Playwright 上下文导致浏览器或 Google 后端风控卡死，同时避免并发请求集中分配给同一账号导致单个账号过载，系统需要引入以下两条新约束：

1. **30 秒全局激活冷却（30s Global Activation Cooldown）**：任意两个账号之间的激活操作必须间隔至少 30 秒。
2. **单账号最大并发请求限制（Max In-Flight = 2 per Account）**：单个账号同时处理的在途请求数不能超过 2 个。并发请求传入时，优先打散分配给 `inFlight == 0` 的空闲账号。

---

## 2. 详细设计

### 2.1 全局 30s 激活冷却机制 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中新增属性：
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

### 2.3 调度过滤、打散与全繁忙逻辑 (`AccountScheduler.js`)

更新 `getNextAuthIndex(modelName)` 算法：

1. **过滤**：
   - 在线：`hasConnection(i) === true`。
   - 已激活：`getAccountStatus(i) === "ACTIVATED"`。
   - 未超限：`tracker.getUsage(i, modelName) < dailyLimit`。
   - **并发未满**：`getInFlightCount(i) < 2`。
2. **排序（打散优先）**：
   - **第一排序键**：`inFlightCount` 升序（空闲账号 `inFlight == 0` 优先）。
   - **第二排序键**：该模型当前周期用量 `usageCount` 升序。
   - **第三排序键**：Round-Robin 顺时针顺序。
3. **同步降级激活**：
   - 若无可用 `ACTIVATED` 账号，仅在 **冷却满 30s 且 `inFlightCount < 2`** 的前提下，对 `INACTIVE` 账号按用量最少顺序执行同步激活。
4. **全繁忙报错 (503 Service Unavailable)**：
   - 若存在在线账号，但所有在线账号的在途数均满足 `inFlightCount >= 2`：
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

* `src/concurrent/AccountScheduler.js`：实现 30s 激活冷却、`inFlight` 计数器与在途并发打散调度。
* `src/concurrent/ConcurrentRequestHandler.js`：配对调用 `acquireInFlight` / `releaseInFlight`，确保无泄漏。
* `test/concurrent/account_scheduler.test.js`：增加 30s 激活冷却、在途打散与 503 满载报错测试。
* `test/concurrent/concurrent_request_handler.test.js`：增加 `acquireInFlight` / `releaseInFlight` 配对调用测试。
