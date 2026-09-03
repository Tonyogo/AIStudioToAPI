# 设计文档：并发模式下极值等待与超时重试机制 (Concurrent Busy Wait & Retry)

**日期:** 2026-08-11  
**状态:** 已批准 (Approved)  

---

## 1. 背景与问题描述

在 AIStudioToAPI 的并发转发模式 (`ENABLE_CONCURRENT=true`) 中，当前调度器 `AccountScheduler.getNextAuthIndex(modelName)` 在面对高并发请求时采用的是“立即拒绝”策略：
- 当所有已在线连接账号的在途请求数均达到上限（`inFlight >= maxInFlightPerAccount`，默认 2），或者当前没有处于就绪状态的 WebSocket 连接时，调度器会立即抛出 HTTP 503 错误（`All available accounts are busy` 或 `No active context connection available`）。

在高并发峰值场景下，这种立即拒绝策略会导致客户端收到大量 503 报错，体验不够平滑。由于现有在途请求通常在数百毫秒至数秒内即可处理完毕并释放账号容量，因此将“立即报错”改造为“挂起等待并按固定间隔轮询重试，直至超时”能大幅提升系统的并发吞吐与可用性。

---

## 2. 目标与设计原则

1. **非阻塞异步等待 (Non-blocking Busy Wait)**：当无可用账号时，请求不立即报错，而是进入异步等待轮询循环，每隔 **3000ms** 重试一次调度。
2. **超时机制 (Timeout)**：支持自定义最大等待超时（默认 **60,000ms / 60秒**），超时后若仍无可用账号，则抛出 503 错误。
3. **客户端断开即时响应 (Client Abort Awareness)**：结合 Express `res.on("close")` 与 `AbortController`，若客户端在等待期间断开连接，轮询应立即退出，避免无效等待与资源浪费。
4. **平滑衔接 (Seamless Integration)**：等待成功获取 `authIndex` 后自动调用 `acquireInFlight(authIndex)` 锁定容量，且在请求结束时由 `finally` 统一释放 `releaseInFlight(authIndex)`。

---

## 3. 详细设计

### 3.1 配置层 (`src/utils/ConfigLoader.js`)

在配置加载器中新增并发等待超时配置项：

- **环境变量**: `CONCURRENT_WAIT_TIMEOUT_MS`
- **默认配置**: `concurrentWaitTimeoutMs: 60000` (60 秒)

```javascript
// ConfigLoader.js 缺省配置补充
concurrentWaitTimeoutMs: parseInt(process.env.CONCURRENT_WAIT_TIMEOUT_MS, 10) || 60000,
```

---

### 3.2 调度器层 (`src/concurrent/AccountScheduler.js`)

在 `AccountScheduler` 中保留原有的同步单次调度方法 `getNextAuthIndex(modelName)`，新增高层级的异步等待获取方法 `acquireNextAuthIndex(modelName, options)`：

#### 接口定义
```javascript
/**
 * Acquire next available auth index with polling wait and timeout handling
 * @param {string} modelName - Model name
 * @param {Object} [options]
 * @param {number} [options.timeoutMs] - Maximum wait timeout in milliseconds
 * @param {AbortSignal} [options.signal] - Abort signal (e.g. from client disconnect)
 * @returns {Promise<number>} Selected authIndex
 */
async acquireNextAuthIndex(modelName, options = {})
```

#### 轮询流程图
```
[acquireNextAuthIndex 开始]
          │
          ▼
    检查 signal.aborted? ──► [是] ──► 抛出 ClientAbortedError
          │
          ▼ [否]
  调用 getNextAuthIndex(modelName)
          │
  ├──► [成功获得 authIndex] ──► 调用 acquireInFlight(authIndex) ──► 返回 authIndex
  │
  └──► [捕获 503 错误 (Busy/NoConn)]
          │
          ▼
   计算已用时间 elapsed >= timeoutMs ?
          │
          ├──► [是] ──► 抛出 HTTP 503 (All available accounts are busy / Timeout)
          │
          └──► [否] ──► 计算 sleepMs = min(3000, remainingTime)
                            │
                            ▼
                     等待 sleepMs (可被 signal abort 打断)
                            │
                            ▼
                        [循环重试]
```

#### 关键细节处理
1. **可打断的 Sleep**：使用 `new Promise((resolve, reject) => ...)` 结合 `setTimeout` 与 `signal.addEventListener("abort", ...)`，确保 3000ms sleep 期间若客户端断开能瞬间唤醒并抛出中断异常，绝不浪费 3s 延迟。
2. **原子性锁**：在成功拿到 `authIndex` 的瞬时立即同步执行 `this.acquireInFlight(authIndex)`，防止并发轮询时多个等待者拿到同一个空闲配额。

---

### 3.3 请求处理层 (`src/concurrent/ConcurrentRequestHandler.js`)

修改 `handleGeminiRequest(req, res)` 中的账号获取与生命周期逻辑：

1. **初始化 AbortController**：
   ```javascript
   const abortController = new AbortController();
   const onClientClose = () => {
       abortController.abort();
   };
   res.on("close", onClientClose);
   ```

2. **异步等待获取账号**：
   ```javascript
   let authIndex;
   try {
       authIndex = await this.scheduler.acquireNextAuthIndex(cleanModelName, {
           signal: abortController.signal,
           timeoutMs: this.scheduler.config?.concurrentWaitTimeoutMs || 60000,
       });
   } catch (error) {
       res.removeListener("close", onClientClose);
       if (abortController.signal.aborted) {
           return; // 客户端已断开，直接退出
       }
       // 503 超时或其他异常处理
       return res.status(error.statusCode || 503).json({
           error: {
               code: error.statusCode || 503,
               message: error.message,
               status: error.statusText || "UNAVAILABLE",
           },
       });
   }
   ```

3. **请求执行与释放**：
   请求完成后在 `finally` 块中清理 `res.removeListener("close", onClientClose)`，并按照现有的逻辑释放在途数 `this.scheduler.releaseInFlight(authIndex)` 并异步触发退休检查。

---

## 4. 单元测试与集成测试计划

新增及更新测试用例 (`test/concurrent/account_scheduler.test.js`)：
1. **立即成功测试**：存在闲置账号时，`acquireNextAuthIndex` 应立即返回而不发生 sleep。
2. **轮询等待成功测试**：初始状态下全忙，模拟 1500ms 后某一账号 `releaseInFlight`，验证 `acquireNextAuthIndex` 在第二次轮询时成功获取账号。
3. **超时失败测试**：持续全忙状态下，设置 `timeoutMs = 1000`，验证在 1000ms 后正确抛出 503 错误。
4. **中断测试**：在等待轮询期间触发 `signal.abort()`，验证方法立即抛出中断错误，且不会等待 3000ms。

---

## 5. 变更影响范围

- `src/utils/ConfigLoader.js`
- `src/concurrent/AccountScheduler.js`
- `src/concurrent/ConcurrentRequestHandler.js`
- `test/concurrent/account_scheduler.test.js`
- `test/concurrent/concurrent_request_handler.test.js`
- `src/concurrent/README.md`
