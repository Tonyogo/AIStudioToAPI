# Design Spec: Immediate Account Retirement on Configured Status Codes for Concurrent Subsystem

**Date:** 2026-08-07  
**Status:** Approved  
**Target File:** `src/concurrent/AccountScheduler.js`  
**Test File:** `test/concurrent/account_scheduler.test.js`

---

## 1. Background & Problem Statement

In concurrent mode, when an account encounters an HTTP 429 rate limit or 503 service unavailable error, `AccountScheduler.recordFailure` currently applies a 20-second isolation period (`suspendedUntilMap`) and increments the consecutive failure counter.

An account is only retired (`RETIRED`) after reaching `failureThreshold` (default: 3 consecutive failures). For rate limits (429) or service degradation (503), waiting for 3 consecutive failures is too slow and can lead to unnecessary retries on an exhausted context.

---

## 2. Solution: Centralized Immediate Retirement

Integrate `config.immediateSwitchStatusCodes` (defaulting to `[429, 503]`) into `AccountScheduler`. When an account fails with any status code in this list, `checkAndRetireAccount` will **immediately trigger retirement** (`RETIRED`) and dynamic pool rebalancing, while other status codes retain the existing 20-second suspension/isolation mechanism.

---

## 3. Detailed Architecture & Design

### 3.1 Constructor Configuration Initializer

In `AccountScheduler` constructor:

```javascript
this.immediateSwitchStatusCodes =
    Array.isArray(config?.immediateSwitchStatusCodes) && config.immediateSwitchStatusCodes.length > 0
        ? config.immediateSwitchStatusCodes
        : [429, 503];

this.lastStatusCodeMap = new Map(); // authIndex -> statusCode
```

### 3.2 Failure & Success Recording

In `recordFailure(authIndex, statusCode)`:
- Store `statusCode` in `this.lastStatusCodeMap.set(authIndex, statusCode)`.
- Increment `failureCountMap`.
- For status codes **not** triggering immediate switch, apply the existing 20-second suspension logic if `currentFailures >= 2`.

In `recordSuccess(authIndex)`:
- Clear `this.lastStatusCodeMap.delete(authIndex)`.
- Reset `failureCountMap.set(authIndex, 0)`.

### 3.3 Centralized Retirement in `checkAndRetireAccount(authIndex)`

`checkAndRetireAccount` serves as the single source of truth for retiring accounts:

```javascript
async checkAndRetireAccount(authIndex) {
    this._checkAndResetCycle();
    if (authIndex === undefined || authIndex < 0) return false;
    if (this.getAccountStatus(authIndex) === "RETIRED") return false;

    // 1. Model quota exhausted check
    let exhaustedCount = 0;
    const modelList = Array.isArray(this.modelList) && this.modelList.length > 0
        ? this.modelList
        : [{ name: "models/gemini-2.5-flash" }];
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
    const lastStatusCode = this.lastStatusCodeMap.get(authIndex);

    let shouldRetire = false;
    let reason = "";

    const isImmediateSwitch = typeof lastStatusCode === "number" && this.immediateSwitchStatusCodes.includes(lastStatusCode);

    if (isImmediateSwitch) {
        shouldRetire = true;
        reason = `received immediate switch status code ${lastStatusCode}`;
    } else if (exhaustedCount >= maxExhausted) {
        shouldRetire = true;
        reason = `reached daily usage limit on ${exhaustedCount} model(s) (threshold: ${maxExhausted})`;
    } else if (consecutiveFailures >= failureThreshold) {
        shouldRetire = true;
        reason = `reached ${consecutiveFailures} consecutive failures (threshold: ${failureThreshold})`;
    }

    if (shouldRetire) {
        this.lastStatusCodeMap.delete(authIndex);
        await this.retireAndReplaceAccount(authIndex, reason);
        return true;
    }
    return false;
}
```

---

## 4. Testing & Verification Plan

1. **Unit Tests (`test/concurrent/account_scheduler.test.js`)**:
   - Test that `recordFailure(0, 429)` followed by `checkAndRetireAccount(0)` immediately sets account status to `RETIRED` and calls `retireAndReplaceAccount`.
   - Test that `recordFailure(0, 503)` followed by `checkAndRetireAccount(0)` immediately retires the account.
   - Test that `recordFailure(0, 500)` increments failure count without immediate retirement.
   - Test custom `immediateSwitchStatusCodes` configuration.
2. **ESLint & Full Concurrent Suite**:
   - `npx eslint src/concurrent/ test/concurrent/`
   - `npx jest test/concurrent/`
