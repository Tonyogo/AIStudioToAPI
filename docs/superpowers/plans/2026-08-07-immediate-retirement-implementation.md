# Immediate Account Retirement on Configured Status Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement immediate account retirement in `AccountScheduler` upon receiving HTTP status codes in `config.immediateSwitchStatusCodes` (default: `[429, 503]`).

**Architecture:** Store the last status code in `this.lastStatusCodeMap` during `recordFailure`, and check `immediateSwitchStatusCodes` inside `checkAndRetireAccount` to immediately trigger retirement (`RETIRED`) and dynamic pool rebalancing.

**Tech Stack:** Node.js (CommonJS), Jest (Unit Testing), ESLint.

## Global Constraints

- **Language & Runtime:** Node.js CommonJS modules (`module.exports` / `require`).
- **Target File:** `src/concurrent/AccountScheduler.js`
- **Test File:** `test/concurrent/account_scheduler.test.js`
- **Code Quality:** `npx eslint src/concurrent/ test/concurrent/` must pass with 0 errors.
- **Testing:** All Jest tests under `test/concurrent/` must pass.

---

### Task 1: Update `AccountScheduler` to support immediate retirement on configured status codes

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`

**Interfaces:**
- Consumes: `this.config.immediateSwitchStatusCodes` (Array of numbers, default `[429, 503]`)
- Modifies:
  - `AccountScheduler` constructor: initializes `this.immediateSwitchStatusCodes` and `this.lastStatusCodeMap`.
  - `recordFailure(authIndex, statusCode)`: sets `this.lastStatusCodeMap.set(authIndex, statusCode)`.
  - `recordSuccess(authIndex)`: deletes `this.lastStatusCodeMap.delete(authIndex)`.
  - `_checkAndResetCycle()`: clears `this.lastStatusCodeMap.clear()`.
  - `checkAndRetireAccount(authIndex)`: checks `isImmediateSwitch` and sets `shouldRetire = true` with reason `received immediate switch status code ${lastStatusCode}`.

- [ ] **Step 1: Update constructor and state maps in `src/concurrent/AccountScheduler.js`**

In `AccountScheduler` constructor (`src/concurrent/AccountScheduler.js`):

```javascript
        this.immediateSwitchStatusCodes =
            Array.isArray(config?.immediateSwitchStatusCodes) && config.immediateSwitchStatusCodes.length > 0
                ? config.immediateSwitchStatusCodes
                : [429, 503];
        this.lastStatusCodeMap = new Map();
```

- [ ] **Step 2: Update `recordFailure`, `recordSuccess`, and `_checkAndResetCycle` in `AccountScheduler.js`**

In `_checkAndResetCycle`:
```javascript
            this.failureCountMap.clear();
            this.suspendedUntilMap.clear();
            this.lastStatusCodeMap.clear();
```

In `recordFailure`:
```javascript
    recordFailure(authIndex, statusCode) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        if (this.getAccountStatus(authIndex) === "RETIRED") return;
        if (typeof statusCode === "number") {
            this.lastStatusCodeMap.set(authIndex, statusCode);
        }
        const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
        this.failureCountMap.set(authIndex, currentFailures);

        const secondsStr = `${Math.round(this.suspensionDurationMs / 1000)} seconds`;
        if (statusCode === 429) {
            this.suspendedUntilMap.set(authIndex, Date.now() + this.suspensionDurationMs);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] AuthIndex #${authIndex} suspended for ${secondsStr} due to HTTP 429 rate limit`
                );
            }
        } else if (currentFailures >= 2) {
            this.suspendedUntilMap.set(authIndex, Date.now() + this.suspensionDurationMs);
            this.failureCountMap.set(authIndex, 0);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] AuthIndex #${authIndex} suspended for ${secondsStr} due to 2 consecutive failures`
                );
            }
        }
    }
```

In `recordSuccess`:
```javascript
    recordSuccess(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        this.failureCountMap.set(authIndex, 0);
        this.lastStatusCodeMap.delete(authIndex);
    }
```

- [ ] **Step 3: Update `checkAndRetireAccount` in `AccountScheduler.js`**

```javascript
    async checkAndRetireAccount(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return false;
        if (this.getAccountStatus(authIndex) === "RETIRED") return false;

        let exhaustedCount = 0;
        const modelList =
            Array.isArray(this.modelList) && this.modelList.length > 0
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

        const isImmediateSwitch =
            typeof lastStatusCode === "number" && this.immediateSwitchStatusCodes.includes(lastStatusCode);

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

- [ ] **Step 4: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js
git commit -m "feat(concurrent): trigger immediate account retirement on immediateSwitchStatusCodes"
```

---

### Task 2: Add comprehensive unit tests in `test/concurrent/account_scheduler.test.js`

**Files:**
- Modify: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Tests `recordFailure` and `checkAndRetireAccount` for immediate retirement on configured status codes.

- [ ] **Step 1: Add failing unit tests to `test/concurrent/account_scheduler.test.js`**

Add the following tests to `test/concurrent/account_scheduler.test.js`:

```javascript
    test("checkAndRetireAccount immediately retires account when receiving HTTP 429 status code", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 429);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.retireAndReplaceAccount).toHaveBeenCalledWith(0, "received immediate switch status code 429");
    });

    test("checkAndRetireAccount immediately retires account when receiving HTTP 503 status code", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 503);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.retireAndReplaceAccount).toHaveBeenCalledWith(0, "received immediate switch status code 503");
    });

    test("checkAndRetireAccount does NOT immediately retire account on 500 error if failure threshold is not reached", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 500);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(false);
        expect(scheduler.retireAndReplaceAccount).not.toHaveBeenCalled();
    });

    test("checkAndRetireAccount respects custom immediateSwitchStatusCodes config", async () => {
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { immediateSwitchStatusCodes: [403] }
        );
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 403);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.retireAndReplaceAccount).toHaveBeenCalledWith(0, "received immediate switch status code 403");
    });

    test("recordSuccess clears lastStatusCodeMap and resets failure state", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 500);
        expect(scheduler.lastStatusCodeMap.get(0)).toBe(500);

        scheduler.recordSuccess(0);
        expect(scheduler.lastStatusCodeMap.get(0)).toBeUndefined();

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(false);
    });
```

- [ ] **Step 2: Run all concurrent tests to verify they pass**

Run: `npx jest test/concurrent/`
Expected: PASS for all 72 tests.

- [ ] **Step 3: Run ESLint to verify code quality**

Run: `npx eslint src/concurrent/ test/concurrent/`
Expected: 0 warnings, 0 errors.

- [ ] **Step 4: Commit test file**

```bash
git add test/concurrent/account_scheduler.test.js
git commit -m "test(concurrent): add unit tests for immediate account retirement on immediateSwitchStatusCodes"
```
