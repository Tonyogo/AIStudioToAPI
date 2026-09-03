# Spec: 借鉴 rebalanceContextPool 重构并发模式账号退休策略

**日期:** 2026-08-06
**状态:** 已批准 (Approved)

---

## 1. 需求与背景

在并发模式下，原有的账号退休替换逻辑（`retireAndReplaceAccount`）试图在触发退休时通过同步强行拉起新账号（并带有强制冷却绕过与定时重试）。这种方式不仅导致退休逻辑与日常请求抢占激活锁，且代码较为繁琐。

原项目 `BrowserManager.js` 中拥有非常成熟的后台上下文池再平衡机制（`rebalanceContextPool()` 和 `_preloadBackgroundContexts()`）。它能够在后台非阻塞地根据 `MAX_CONTEXTS` 和健康账号列表计算候选目标，并在后台异步静默建立 WebSocket 连接补充底座。

本设计旨在借鉴并直接复用原项目的 `rebalanceContextPool` 机制，彻底解耦账号退休销毁与替代账号拉起的逻辑。

---

## 2. 详细设计

### 2.1 简化 `retireAndReplaceAccount`（`src/concurrent/AccountScheduler.js`）

1. **清除强行拉起与定时重试代码**：
   - 移除 `retireAndReplaceAccount` 中的 `tryActivateNext` 循环以及 `setTimeout` 重试逻辑。
   - 移除 `activateAccount` 中特设的 `forceCooldown` 参数，恢复标准的 30 秒全局冷却限制（`activationCooldownMs`）与 `isActivatingAny` 互斥锁。

2. **纯粹化退休与异步触发再平衡**：
   ```javascript
   async retireAndReplaceAccount(authIndex, reason) {
       if (this.logger && typeof this.logger.warn === "function") {
           this.logger.warn(`[AccountScheduler] Retiring account #${authIndex}: ${reason}`);
       }

       this.setAccountStatus(authIndex, "RETIRED");

       if (this.browserManager) {
           if (typeof this.browserManager.closeContext === "function") {
               try {
                   await this.browserManager.closeContext(authIndex);
               } catch (e) {
                   if (this.logger && typeof this.logger.warn === "function") {
                       this.logger.warn(`[AccountScheduler] Error closing retired context #${authIndex}: ${e.message}`);
                   }
               }
           }

           // 借鉴原项目：退休释放 Context 后，在后台异步触发再平衡补充备用账号
           if (typeof this.browserManager.rebalanceContextPool === "function") {
               this.browserManager.rebalanceContextPool().catch(err => {
                   if (this.logger && typeof this.logger.error === "function") {
                       this.logger.error(`[AccountScheduler] Background rebalance failed after retirement: ${err.message}`);
                   }
               });
           }
       }
   }
   ```

### 2.2 `rebalanceContextPool` 与 `AccountScheduler` 的无缝联动

1. `BrowserManager.rebalanceContextPool()` 会自动调用 `this.authSource.getRotationIndices()`，结合 `MAX_CONTEXTS` 筛选目标账号。
2. 已被标记为 `RETIRED` 的账号，在 `rebalanceContextPool()` 获取下一个健康账号时会被自动跳过。
3. `BrowserManager` 通过后台 Fire-and-Forget 任务 `_preloadBackgroundContexts` 在后台安静建立新账号的 Context 和 WebSocket 连接，实现无感、非阻塞的底座拉起。

---

## 3. 验证方案

1. 编写单元测试 `test/concurrent/account_scheduler.test.js`，验证：
   - 当调用 `retireAndReplaceAccount` 时，指定账号被正确设为 `RETIRED`，并且触发了 `browserManager.closeContext` 和 `browserManager.rebalanceContextPool`。
2. 运行 `npx jest test/concurrent/` 确保所有 61+ 门并发测试全部 PASS。
3. 运行 `npm run lint:js`，保证 0 Error。
