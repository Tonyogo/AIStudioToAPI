# 激活账号过期失效 (2分钟寿命) 设计规范

**日期:** 2026-08-05  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

为了防止某些长期保持已激活状态的账号持续空闲占用资源或浏览器会话产生死锁，需要引入**激活寿命到期失效 (Activation Expiration)** 机制。
账号激活时的“寿命”默认为 **2 分钟**。每次调度请求或页面拉取状态前，系统将自动检测已激活账号，若到期且是在途空闲状态 (`inFlight === 0`)，则让其过期复位为 `INACTIVE`。

---

## 2. 详细设计

### 2.1 状态检测刷新 Helper (`AccountScheduler.js`)

在 `src/concurrent/AccountScheduler.js` 中增加寿命属性 `this.activatedLifespanMs = 120000;`，并增加状态刷新方法：

```javascript
/**
 * Automatically refresh all account statuses, expiring ACTIVATED accounts whose lifespan exceeded 2 mins
 */
_refreshAccountStatuses() {
    this._checkAndResetCycle();
    const now = Date.now();
    for (const [authIndex, entry] of this.accountStatusMap.entries()) {
        if (entry && entry.status === "ACTIVATED") {
            const elapsed = now - (entry.lastActivatedAt || 0);
            if (elapsed >= this.activatedLifespanMs) {
                const inFlight = this.getInFlightCount(authIndex);
                if (inFlight === 0) {
                    if (this.logger && typeof this.logger.info === "function") {
                        this.logger.info(
                            `[AccountScheduler] AuthIndex #${authIndex} activation expired back to INACTIVE (lifespan: ${Math.round(elapsed / 1000)}s)`
                        );
                    }
                    this.setAccountStatus(authIndex, "INACTIVE");
                }
            }
        }
    }
}
```

### 2.2 刷新触发节点

在以下节点执行自动检测和状态复位：
1. **`getNextAuthIndex()` 入口**：在获取下一个可用账号索引的最开始，优先刷新，确保用最新状态集来做优先级决策。
2. **`getAccountStatus(authIndex)` 内部**：每次外部（如 Web UI 面板轮询状态）查询时，动态检测以保持页面显示数据的一致性。

---

## 3. 受影响文件

- `src/concurrent/AccountScheduler.js`：添加激活寿命过期机制。
- `test/concurrent/account_scheduler.test.js`：添加 2 分钟过期失效机制测试。
