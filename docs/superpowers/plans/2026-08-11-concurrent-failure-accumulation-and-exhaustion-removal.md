# Concurrency Failure Accumulation & Model Exhaustion Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the multi-account failure tracking system to let non-429 failures accumulate consecutively (without quiet resets), remove the 20-second general suspension period, and completely remove daily model usage limit retirement.

**Architecture:** Refactor `AccountScheduler.js` failure recording and checks, remove `exhaustedModelsThreshold` from `ConfigLoader.js`, and update corresponding tests in `test/concurrent/account_scheduler.test.js`.

**Tech Stack:** Node.js CommonJS, Jest

## Global Constraints

- Preserve CommonJS syntax (`require`/`module.exports`).
- Maintain 100% backward compatibility with all valid tests in `test/concurrent/`.
- Ensure zero ESLint warnings or errors (`npm run lint:js`).

---

### Task 1: Refactor `ConfigLoader.js` (Remove `exhaustedModelsThreshold` Configuration)

**Files:**
- Modify: `src/utils/ConfigLoader.js`
- Test: `test/utils/config_loader.test.js` or generic boot verification

**Interfaces:**
- Consumes: Config object loaded from environment variables
- Produces: Sanitized config object *without* `exhaustedModelsThreshold` property.

- [ ] **Step 1: Check existing ConfigLoader tests pass**

Run: `npx jest test/ -t "ConfigLoader"`
Expected: PASS (if matching test suite exists) or proceed.

- [ ] **Step 2: Remove `exhaustedModelsThreshold` from `ConfigLoader.js`**

In `src/utils/ConfigLoader.js`:
- Remove line: `exhaustedModelsThreshold: 1,` from `config` default object initialization.
- Remove block:
  ```javascript
  if (process.env.EXHAUSTED_MODELS_THRESHOLD) {
      const parsed = parseInt(process.env.EXHAUSTED_MODELS_THRESHOLD, 10);
      config.exhaustedModelsThreshold = Number.isFinite(parsed)
          ? Math.max(1, parsed)
          : config.exhaustedModelsThreshold;
  }
  ```
- Remove any print logs or references to `exhaustedModelsThreshold` inside logger methods in `ConfigLoader.js` if present.

- [ ] **Step 3: Verify no syntax errors and code compiles**

Run: `node -e "require('./src/utils/ConfigLoader')"`
Expected: Clean exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/utils/ConfigLoader.js
git commit -m "refactor(config): remove exhaustedModelsThreshold configuration and environment variable"
```

---

### Task 2: Refactor `AccountScheduler` Failure Accumulation & Usage Limit Retirement Deletion (Problem 5 & Option 2)

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `statusCode` (number), `authIndex` (number)
- Produces: `AccountScheduler.prototype.recordFailure`, `AccountScheduler.prototype.checkAndRetireAccount` refactored to remove model limits and remove 20-second quiet resets on non-429 failures.

- [ ] **Step 1: Inspect `AccountScheduler.js` code lines to be modified**

Verify locations of `recordFailure` and `checkAndRetireAccount` inside `src/concurrent/AccountScheduler.js`.

- [ ] **Step 2: Update `recordFailure` and `checkAndRetireAccount` in `src/concurrent/AccountScheduler.js`**

In `src/concurrent/AccountScheduler.js`:
Refactor `recordFailure(authIndex, statusCode)`:
```javascript
    /**
     * Record failure for an account and trigger suspension for 429
     * @param {number} authIndex
     * @param {number} statusCode
     */
    recordFailure(authIndex, statusCode) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return;
        if (this.getAccountStatus(authIndex) === "RETIRED") return;
        if (typeof statusCode === "number") {
            this.lastStatusCodeMap.set(authIndex, statusCode);
        }
        
        // Always increment consecutive failure count
        const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
        this.failureCountMap.set(authIndex, currentFailures);

        if (statusCode === 429) {
            const secondsStr = `${Math.round(this.suspensionDurationMs / 1000)} seconds`;
            this.suspendedUntilMap.set(authIndex, Date.now() + this.suspensionDurationMs);
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] AuthIndex #${authIndex} suspended for ${secondsStr} due to HTTP 429 rate limit`
                );
            }
        }
    }
```

Refactor `checkAndRetireAccount(authIndex)`:
```javascript
    /**
     * Check if account should be retired based on failure threshold or immediate switch status codes
     * @param {number} authIndex
     * @returns {Promise<boolean>}
     */
    async checkAndRetireAccount(authIndex) {
        this._checkAndResetCycle();
        if (authIndex === undefined || authIndex < 0) return false;
        if (this.getAccountStatus(authIndex) === "RETIRED") return false;

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

- [ ] **Step 3: Run Jest tests to verify expected failing tests**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: FAIL on some old daily limit checks.

- [ ] **Step 4: Commit refactored AccountScheduler.js**

```bash
git add src/concurrent/AccountScheduler.js
git commit -m "feat(concurrent): refactor recordFailure to eliminate non-429 suspension and remove model exhaustion retirement check"
```

---

### Task 3: Update `test/concurrent/account_scheduler.test.js` to Align with Refactored Failure & Retirement Logic

**Files:**
- Modify: `test/concurrent/account_scheduler.test.js`

- [ ] **Step 1: Inspect and rewrite old tests in `test/concurrent/account_scheduler.test.js`**

Rewrite the test checking limit exhaustion:
- Change `checkAndRetireAccount retires account when model usage reaches dailyLimit` to assert that model usage limit exhaustion **no longer** triggers retirement:
  ```javascript
    test("checkAndRetireAccount does NOT retire account when model usage reaches dailyLimit", async () => {
        const mockModelTracker = {
            getUsage: jest.fn(idx => (idx === 0 ? 1000 : 0)),
        };
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const mockConfig = { failureThreshold: 3 };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            mockModelTracker,
            [{ name: "models/gemini-2.5-flash" }],
            mockConfig
        );
        scheduler.setAccountStatus(0, "ACTIVATED");

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(false);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });
  ```

Rewrite/Add a test verifying non-429 consecutive failure accumulation (Option 2):
- Verify consecutive failures (e.g. 403 errors) cleanly increment consecutive failures up to `failureThreshold` and trigger retirement, without resetting or quiet periods:
  ```javascript
    test("recordFailure accumulates consecutive non-429 failures smoothly and triggers retirement on threshold", async () => {
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const mockConfig = { failureThreshold: 3 };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            mockConfig
        );
        scheduler.setAccountStatus(0, "ACTIVATED");

        // First 403 failure
        scheduler.recordFailure(0, 403);
        expect(scheduler.failureCountMap.get(0)).toBe(1);
        expect(scheduler.isAccountSuspended(0)).toBe(false);

        // Second 403 failure - should NOT be suspended, should NOT reset to 0
        scheduler.recordFailure(0, 403);
        expect(scheduler.failureCountMap.get(0)).toBe(2);
        expect(scheduler.isAccountSuspended(0)).toBe(false);

        // Third 403 failure
        scheduler.recordFailure(0, 403);
        expect(scheduler.failureCountMap.get(0)).toBe(3);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
    });
  ```

- [ ] **Step 2: Run account scheduler tests**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/concurrent/account_scheduler.test.js
git commit -m "test(concurrent): update account scheduler tests to verify new failure accumulation and model limit removal"
```

---

### Task 4: Full Suite Verification & Code Linting Check

**Files:**
- Test: `test/concurrent/`

- [ ] **Step 1: Run complete Jest suite across `test/concurrent/`**

Run: `npx jest test/concurrent/`
Expected: PASS (6 test suites, 90 tests passed)

- [ ] **Step 2: Run JS Linter**

Run: `npm run lint:js`
Expected: 0 errors, 0 warnings

- [ ] **Step 3: Commit clean verification**

Verify `git status` shows clean workspace.
