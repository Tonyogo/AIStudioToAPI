# Spec: 调度逻辑优化与遗留死代码清理

**日期:** 2026-08-06
**状态:** 已批准 (Approved)

---

## 1. 需求与背景

经过对 `AccountScheduler.js` 调度逻辑的深度排查，发现存在以下多次迭代遗留的代码问题：
1. `startActivationLoop()` 与 `stopActivationLoop()` 为 early-stage 的 30s 定时激活轮询，与 `rebalanceConcurrentPool()` 功能重叠且无实际效果，属于冗余死代码。
2. `getNextAuthIndex` 中的 `Phase 3`（Fallback 强制同步激活）由于逻辑死锁与 Baseline Check 重叠，永远无法生效且进入后也会因为 30s 冷却被拒绝，属于无用死代码。

本设计旨在清理上述遗留死代码，并精简和强化 `getNextAuthIndex` 的 Baseline 账号底座维护与 Phase 1 / Phase 2 分发流。

---

## 2. 详细设计

### 2.1 清理遗留废代码（`src/concurrent/AccountScheduler.js`）

1. **移除定时轮询器**：
   - 完全删除 `startActivationLoop(intervalMs)` 和 `stopActivationLoop()` 方法及相关声明。
2. **删除 Phase 3 激活代码**：
   - 在 `getNextAuthIndex` 中，彻底删除 `Phase 3: Forced fallback activation` 逻辑块。

---

### 2.2 优化后的 `getNextAuthIndex` 三步极简调度流程

1. **分类收集候选集**：
   - `activatedFree`：状态为 `ACTIVATED` 且在途数 `inFlight === 0`。
   - `activatedBusy`：状态为 `ACTIVATED` 且在途数 `inFlight === 1`。
   - `inactiveCandidates`：状态为 `INACTIVE` 且拥有在线 WebSocket 连接。

2. **Baseline 底座拉起**：
   - 计算已激活总数 `totalActivated = activatedFree.length + activatedBusy.length`。
   - 若 `totalActivated < maxContexts` 且 30s 全局激活冷却已满（`canCooldown`）且 `inactiveCandidates.length > 0`：
     - 按用量（`usage`）升序排序，激活用量最少的一个 `inactiveCandidate`。
     - 若激活成功，该账号加入 `activatedFree` 队列参与本次及后续调度。

3. **两阶段精简分发**：
   - **阶段 1（优先空闲）**：若 `activatedFree` 非空，按用量（`usage`）升序选择最少用量账号处理请求。
   - **阶段 2（复用繁忙）**：若 `activatedFree` 为空但 `activatedBusy` 非空，按用量（`usage`）升序选择最少用量账号处理请求。
   - **极值报错**：若均无可用账号，抛出 HTTP 503 `UNAVAILABLE` 错误。

---

## 3. 验证方案

1. 在 `test/concurrent/account_scheduler.test.js` 中：
   - 验证 `startActivationLoop` 已清理。
   - 验证 `getNextAuthIndex` 在 `totalActivated < maxContexts` 且满足 30s 冷却时正确触发 Baseline 激活并成功分发。
2. 运行 `npx jest test/concurrent/` 确保所有 60+ 门并发测试全绿 PASS。
3. 运行 `npm run lint:js` 保证 0 Error。
