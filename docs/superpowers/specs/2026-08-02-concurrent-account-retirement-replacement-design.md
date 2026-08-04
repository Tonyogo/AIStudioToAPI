# 账号下线退休与备用账号无缝替换设计规范

**日期:** 2026-08-02  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

在并发模式下，随着 API 请求的持续消耗，部分 Google 账号可能在某些模型上用尽每日配额（默认限额 1000 次），或者因频繁触发 Google 官方风控而连续产生 429 报错。为了避免无谓占用服务器内存（每个 Context 约 700MB）并防止卡死，系统需要建立 **账号下线退休（Account Retirement）** 与 **备用账号上线替换（Account Replacement）** 机制。

核心目标：
1. **默认模型限额**：未显式配置 `dailyLimit` 的模型，默认单账号每日上限设为 **1000** 次。
2. **用量耗尽下线 (`exhaustedModelsThreshold`)**：当账号在 **N 个模型**（默认 **1** 个模型，可配置）上用量达到 `dailyLimit` 时，触发账号下线。
3. **连续失败下线 (`failureThreshold`)**：复用原系统 `config.failureThreshold`（默认 **3** 次），当账号连续失败/429 达到 3 次时，触发账号下线。
4. **下线与上线替换 (Offload & Replace)**：
   - 下线账号：调用 `browserManager.closeContext(authIndex)` 销毁 Context，释放内存。
   - 上线替换：从 `authSource` 未上线备用账号池中挑选新账号，遵守 30s 全局激活冷却，触发激活上线，补充并发池。

---

## 2. 详细设计

### 2.1 配置项与默认值 (`ConfigLoader.js` / `AccountScheduler.js`)

在系统配置中增加/复用以下参数：
- **默认模型上限 (`DEFAULT_MODEL_DAILY_LIMIT = 1000`)**：在 `getModelDailyLimit(modelName)` 中，若模型未配置 `dailyLimit`（或 `<= 0`），默认返回 `1000`。
- **模型耗尽下线阈值 (`config.exhaustedModelsThreshold = 1`)**：可通过环境变量 `EXHAUSTED_MODELS_THRESHOLD` 配置，默认值为 `1`。
- **连续失败下线阈值 (`config.failureThreshold = 3`)**：复用既有配置 `FAILURE_THRESHOLD`，默认值为 `3`。

### 2.2 状态扩展与退休判定 (`AccountScheduler.js`)

#### 账号状态扩展
在 `accountStatusMap` 中增加状态：`RETIRED`（账号已下线退休，在北京时间 15:00 重置前不再参与任何调度与激活）。

#### 下线判定与替换方法 (`checkAndRetireAccount(authIndex)`)

```javascript
async checkAndRetireAccount(authIndex) {
    if (authIndex === undefined || authIndex < 0) return false;
    if (this.getAccountStatus(authIndex) === "RETIRED") return false;

    // 1. 检查模型用量耗尽数
    let exhaustedCount = 0;
    const modelList = Array.isArray(this.modelList) ? this.modelList : [];
    for (const modelConfig of modelList) {
        if (!modelConfig || !modelConfig.name) continue;
        const cleanName = modelConfig.name.replace("models/", "");
        const limit = this.getModelDailyLimit(cleanName);
        const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(authIndex, cleanName) : 0;
        if (usage >= limit) {
            exhaustedCount++;
        }
    }

    const maxExhausted = this.config?.exhaustedModelsThreshold || 1;
    const failureThreshold = this.config?.failureThreshold || 3;
    const consecutiveFailures = this.failureCountMap.get(authIndex) || 0;

    let shouldRetire = false;
    let reason = "";

    if (exhaustedCount >= maxExhausted) {
        shouldRetire = true;
        reason = `reached daily usage limit on ${exhaustedCount} model(s) (threshold: ${maxExhausted})`;
    } else if (consecutiveFailures >= failureThreshold) {
        shouldRetire = true;
        reason = `reached ${consecutiveFailures} consecutive failures (threshold: ${failureThreshold})`;
    }

    if (shouldRetire) {
        await this.retireAndReplaceAccount(authIndex, reason);
        return true;
    }
    return false;
}
```

#### 下线与替换执行 (`retireAndReplaceAccount(authIndex, reason)`)

```javascript
async retireAndReplaceAccount(authIndex, reason) {
    if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn(`[AccountScheduler] Retiring account #${authIndex}: ${reason}`);
    }

    // 1. 标记为 RETIRED 并释放资源
    this.setAccountStatus(authIndex, "RETIRED");
    if (this.browserManager) {
        try {
            await this.browserManager.closeContext(authIndex);
        } catch (e) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AccountScheduler] Error closing retired context #${authIndex}: ${e.message}`);
            }
        }
    }

    // 2. 寻找备用新账号并尝试激活上线
    const available = this._getAccountIndices();
    for (const nextIdx of available) {
        if (
            this.getAccountStatus(nextIdx) !== "RETIRED" &&
            this.getAccountStatus(nextIdx) !== "ACTIVATED" &&
            this.getAccountStatus(nextIdx) !== "ACTIVATING"
        ) {
            const canCooldown =
                this.lastGlobalActivationAt === 0 ||
                Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs;

            if (canCooldown) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(`[AccountScheduler] Loading new replacement account #${nextIdx} after retiring #${authIndex}...`);
                }
                await this.activateAccount(nextIdx);
                break;
            }
        }
    }
}
```

### 2.3 北京时间 15:00 退休状态自动复位 (`ModelUsageTracker.js` / `AccountScheduler.js`)

北京时间每天 15:00:00 跨周期重置时：
- `ModelUsageTracker` 重置配额归零。
- `AccountScheduler` 自动清除所有账号的 `RETIRED` 状态和 `failureCountMap`，使下线账号在次日配额复苏后重新变为可用 `INACTIVE` 状态。

### 2.4 链路集成 (`ConcurrentRequestHandler.js`)

在 `handleGeminiRequest` 请求完成/失败的 `finally` 或结果响应阶段：
- 每次请求结束后，调用 `await this.scheduler.checkAndRetireAccount(authIndex)`，实现无感自动下线与新账号补位。

---

## 3. 受影响文件

* `src/utils/ConfigLoader.js`：添加 `exhaustedModelsThreshold` 配置默认值与环境变量解析。
* `src/concurrent/AccountScheduler.js`：实现 `getModelDailyLimit` 默认 1000 次上限、`checkAndRetireAccount` 判定与 `retireAndReplaceAccount` 替换逻辑。
* `src/concurrent/ConcurrentRequestHandler.js`：在请求结束后触发 `checkAndRetireAccount`。
* `test/concurrent/account_scheduler.test.js`：增加默认 1000 次上限、模型耗尽下线、连续失败下线与自动换号单元测试。
