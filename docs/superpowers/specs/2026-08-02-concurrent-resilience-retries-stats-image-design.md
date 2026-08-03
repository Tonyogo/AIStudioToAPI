# 并发模式容错隔离、无感重试、监控打通与生图转换设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

为了解决并发转发子系统（`src/concurrent/`）在面对账号故障/429限流时缺乏自动隔离与重试、Web UI 监控指标缺失以及生图响应未格式化等问题，本设计对并发模式进行四项核心升级：

1. **账号错误隔离与冷置（Error Isolation & Cooldown）**：收到 429 报错立即隔离 1 分钟；其他 5xx/掉线错误连续 2 次触发隔离 1 分钟。
2. **跨账号无感重试（Cross-Account Seamless Retry）**：请求响应 Header 发送前（`!res.headersSent`）若发生错误，自动换选其他健康账号重试（最多 2 次）。
3. **Web UI 监控大屏打通 (`UsageStatsService`)**：记录并发请求耗时、成功率、QPS、客户端 IP 与尝试历史，呈现在 StatusPage 仪表盘。
4. **生图 Markdown 格式转换 (`_processImageInResponse`)**：自动将响应中的 `inlineData` 图片解析并转换为 Markdown base64 Data URL。

---

## 2. 详细设计

### 2.1 账号错误隔离与冷置 (`AccountScheduler.js`)

在 `AccountScheduler.js` 中维护：
- `failureCountMap`: `Map<number, number>`（连续失败计数，成功时清零）。
- `suspendedUntilMap`: `Map<number, number>`（隔离截止时间戳）。

**API 与逻辑**：
- `recordFailure(authIndex, statusCode)`:
  - 若 `statusCode === 429`：立即触发 `suspendedUntilMap.set(authIndex, Date.now() + 60000)`（隔离 1 分钟）。
  - 其他错误：`failureCount` + 1；若 `failureCount >= 2`，触发 `suspendedUntilMap.set(authIndex, Date.now() + 60000)` 并重置 `failureCount = 0`。
- `recordSuccess(authIndex)`:
  - 重置 `failureCountMap.set(authIndex, 0)`，并可清除 `suspendedUntilMap`。
- `isAccountSuspended(authIndex)`:
  - 返回 `Date.now() < (suspendedUntilMap.get(authIndex) || 0)`。
- **调度过滤**：在 `getNextAuthIndex` 中，筛选合格账号时，额外排除 `isAccountSuspended(idx) === true` 的账号。

### 2.2 跨账号无感重试机制 (`ConcurrentRequestHandler.js`)

在 `handleGeminiRequest(req, res)` 中：

```javascript
const maxAttempts = 2; // 最多尝试 2 个不同账号
let attempt = 0;
let lastError = null;

while (attempt < maxAttempts) {
    attempt++;
    let authIndex;
    try {
        authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
        this.scheduler.acquireInFlight(authIndex);
    } catch (err) {
        // 无可用账号或触发全量 429/503 错误，打破重试并报错
        lastError = err;
        break;
    }

    try {
        this.usageStatsService?.recordAttempt(requestId, authIndex, this._getAccountName(authIndex));
        if (cleanModelName) this.scheduler.recordUsage(authIndex, cleanModelName);

        const result = await this._sendRequestWithPromise(authIndex, requestPayload, res, isStream);
        if (result.success) {
            this.scheduler.recordSuccess(authIndex);
            lastError = null;
            break; // 成功即退出重试循环
        } else {
            // 请求失败：记录错误并决定是否重试
            this.scheduler.recordFailure(authIndex, result.statusCode);
            lastError = result.error;
            if (res.headersSent) {
                // 如果标头已经发送给客户端，无法跨账号重试，打破循环
                break;
            }
        }
    } finally {
        this.scheduler.releaseInFlight(authIndex);
    }
}

if (lastError && !res.headersSent) {
    // 最终尝试均失败后，吐出最终错误响应
    const statusCode = lastError.statusCode || 500;
    res.status(statusCode).json({
        error: { code: statusCode, message: lastError.message, status: lastError.statusText || "INTERNAL" }
    });
}
```

### 2.3 Web UI 监控打通 (`UsageStatsService`)

在 `ConcurrentRequestHandler.js` 中引入 `usageStatsService`（从 `ProxyServerSystem` 注入）：
- 在 `handleGeminiRequest` 开始处：
  ```javascript
  this.usageStatsService?.startRequest(requestId, {
      apiFormat: "gemini",
      clientIp: req.ip || req.headers["x-forwarded-for"],
      initialAuthIndex: authIndex,
      isStreaming: isStream,
      method: req.method,
      model: cleanModelName,
      path: req.path,
      requestCategory: "generation",
  });
  ```
- 每次尝试调用 `usageStatsService?.recordAttempt(requestId, authIndex, accountName)`。
- 请求结束（无论成功或失败）时调用 `this.usageStatsService?.finishRequest(requestId, res, { outcome, statusCode })`。

### 2.4 生图 Markdown 响应转换 (`ConcurrentRequestHandler.js`)

在 `ConcurrentRequestHandler.js` 中新增 `_processImageInResponse(body)` 方法（逻辑与 `RequestHandler.js` 保持 100% 一致）：

- 针对非流式 JSON 响应：
  - 检查 `parsedBody.candidates?.[0]?.content?.parts` 是否包含 `inlineData`。
  - 若包含图片，将该 part 替换为 `{ text: "![Generated Image](data:${mimeType};base64,${data})" }` 并重新序列化返回。

---

## 3. 受影响文件

* `src/concurrent/AccountScheduler.js`：添加账号连续失败计数、隔离截止时间戳管理及 `recordFailure`/`recordSuccess`/`isAccountSuspended` 方法。
* `src/concurrent/ConcurrentRequestHandler.js`：集成重试循环、`UsageStatsService` 埋点打通与 `_processImageInResponse` 生图格式转换。
* `src/concurrent/index.js`：传递 `usageStatsService` 引用给 `ConcurrentRequestHandler`。
* `test/concurrent/account_scheduler.test.js`：添加账号 429 隔离与失败惩罚单元测试。
* `test/concurrent/concurrent_request_handler.test.js`：添加跨账号重试、监控打点与生图转换测试。
