# Spec: 基于动态优先级与状态复位的并发池平滑再平衡策略

**日期:** 2026-08-06
**状态:** 已批准 (Approved)

---

## 1. 需求与背景

在并发模式下（`ENABLE_CONCURRENT=true`）：
1. 之前的退休逻辑会直接尝试同步销毁 Context 或强行调用 `activateAccount`，导致退休与前台请求抢锁，且原项目静态的 `rebalanceContextPool` 会误将刚关闭的退休账号重新加载上线。
2. `RETIRED`（配额超限/失败超限）账号与 `EXPIRED`（登录凭证失效）账号有本质区别。`RETIRED` 账号仍然具备可用的登录凭证，在健康未退休账号充足时应排到队列末尾降级；但在没有更多未退休账号可用时，依然可以作为降级保底候选处理请求。

本设计旨在实现一个**动态优先级队列**与**状态复位自愈**的并发池平滑再平衡机制（`rebalanceConcurrentPool`），解决刚退休账号被误加载的问题，并实现平滑退载与自动复苏。

---

## 2. 详细设计

### 2.1 降级排队尾的轻量退休 (`retireAndReplaceAccount`)

在 `src/concurrent/AccountScheduler.js` 中：
- 当账号达到退休条件时（配额耗尽或连续失败达到 `failureThreshold`），**仅将其状态标记为 `RETIRED`，不主动调用 `closeContext` 强行杀死 Context**。
- 随后异步触发 `this.rebalanceConcurrentPool()`，由再平衡算法平滑决定该 Context 是否需要关闭或保留。

```javascript
async retireAndReplaceAccount(authIndex, reason) {
    if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn(`[AccountScheduler] Deprioritizing account #${authIndex} as RETIRED: ${reason}`);
    }

    this.setAccountStatus(authIndex, "RETIRED");

    this.rebalanceConcurrentPool().catch(err => {
        if (this.logger && typeof this.logger.error === "function") {
            this.logger.error(`[AccountScheduler] Background rebalance failed after retirement: ${err.message}`);
        }
    });
}
```

---

### 2.2 动态优先级与状态复位再平衡 (`rebalanceConcurrentPool`)

在 `src/concurrent/AccountScheduler.js` 中新增 `rebalanceConcurrentPool()` 方法：

1. **彻底过滤 `EXPIRED` 凭证失效账号**：
   只保留未被 `authSource.isExpired(idx)` 标记失效的可用账号。

2. **构建动态优先级队列 (`priorityQueue`)**：
   - **第一优先级（队首）**：未退休（`status !== "RETIRED"`）健康账号，按【每日累积用量升序（Least-Used）】排列。
   - **第二优先级（队尾）**：已退休（`status === "RETIRED"`）降级账号，按【每日累积用量升序】排在队列末尾。

3. **计算目标集合 `targets`**：
   - 取优先级队列的前 `MAX_CONTEXTS` 个账号作为目标保底集 `targetIndices`（`maxContexts === 0` 时取全量）。
   - **状态复位（Key Self-Healing）**：遍历 `targetIndices`，若其中有账号当前状态为 `RETIRED`（说明健康账号不够用，被选入 `targets` 作为保底），**在加载上线前强制将其状态恢复为 `INACTIVE`，并重置其连续失败计数**，确保拉起后恢复“可调度”身份！

4. **平滑关闭挤出 Context**：
   - 遍历 `browserManager.contexts.keys()`，对于不在 `targets` 中的已在线 Context（例如被健康新账号挤出 `MAX_CONTEXTS` 容量外的 `RETIRED` 账号），调用 `browserManager._closeContextForPoolIfPossible(activeIdx, "rebalance_retired")` 在空闲时优雅关闭。

5. **非阻塞后台预加载 (`_preloadBackgroundContexts`)**：
   - 找出 `targetIndices` 中尚未建立 WebSocket 连接的账号作为 `candidates`，调用 `browserManager._preloadBackgroundContexts(candidates, maxContexts)`，在后台 Fire-and-Forget 静默建立连接。

---

## 3. 验证方案

1. 在 `test/concurrent/account_scheduler.test.js` 中增加针对 `rebalanceConcurrentPool` 的单元测试：
   - **测试 1**：验证当健康账号充足时，`RETIRED` 账号被排在队尾，超出的 `RETIRED` 账号会被触发关闭。
   - **测试 2**：验证当健康账号不足时，被选入 `targets` 的 `RETIRED` 账号状态会自动被复位重置为 `INACTIVE` 并成功拉起。
2. 运行 `npx jest test/concurrent/` 确保所有 61+ 门并发测试全绿 PASS。
3. 运行 `npm run lint:js` 保证 0 Error。
