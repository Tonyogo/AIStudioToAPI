# Complete Removal of Suspension & Isolation Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely purge all suspension/isolation code (`suspendedUntilMap`, `isAccountSuspended`, `suspensionDurationMs`, `concurrentSuspensionDurationMs`, `CONCURRENT_SUSPENSION_DURATION_MS`) across the concurrent subsystem, configuration loader, status routes, and tests.

**Architecture:** Remove suspension fields and checks from `AccountScheduler.js`, remove `concurrentSuspensionDurationMs` from `ConfigLoader.js`, update `StatusRoutes.js` line 996 (`detail.isSuspended = false`), and update/clean unit tests in `test/concurrent/account_scheduler.test.js`.

**Tech Stack:** Node.js CommonJS, Jest

## Global Constraints

- Preserve CommonJS syntax (`require`/`module.exports`).
- Maintain 100% backward compatibility with valid tests in `test/concurrent/`.
- Ensure zero ESLint warnings or errors (`npm run lint:js`).

---

### Task 1: Refactor `ConfigLoader.js` and `StatusRoutes.js` (Remove Config & Update Status Detail)

**Files:**
- Modify: `src/utils/ConfigLoader.js`
- Modify: `src/routes/StatusRoutes.js:996`

**Interfaces:**
- Consumes: Config object loaded from environment variables
- Produces: Sanitized config object without `concurrentSuspensionDurationMs`, and `detail.isSuspended = false` in `StatusRoutes.js`.

- [ ] **Step 1: Refactor `ConfigLoader.js`**

In `src/utils/ConfigLoader.js`:
- Remove line: `concurrentSuspensionDurationMs: 20000,` from default `config` initialization.
- Remove parsing block:
  ```javascript
  if (process.env.CONCURRENT_SUSPENSION_DURATION_MS) {
      const parsed = parseInt(process.env.CONCURRENT_SUSPENSION_DURATION_MS, 10);
      config.concurrentSuspensionDurationMs = Number.isFinite(parsed)
          ? Math.max(0, parsed)
          : config.concurrentSuspensionDurationMs;
  }
  ```
- Remove log line in `_printConfiguration`:
  `this.logger.info(\`  Concurrent Suspension Duration: \${config.concurrentSuspensionDurationMs}ms\`);`

- [ ] **Step 2: Refactor `StatusRoutes.js`**

In `src/routes/StatusRoutes.js`:
- Replace line 996:
  `detail.isSuspended = scheduler ? scheduler.isAccountSuspended(index) : false;`
  With:
  `detail.isSuspended = false;`

- [ ] **Step 3: Verify syntax and compile check**

Run: `node -e "require('./src/utils/ConfigLoader'); require('./src/routes/StatusRoutes');"`
Expected: Clean exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/utils/ConfigLoader.js src/routes/StatusRoutes.js
git commit -m "refactor(config): remove concurrentSuspensionDurationMs config and update StatusRoutes isSuspended flag"
```

---

### Task 2: Purge Suspension Logic from `AccountScheduler.js`

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`

**Interfaces:**
- Consumes: `statusCode` (number), `authIndex` (number)
- Produces: `AccountScheduler` without `suspendedUntilMap`, `suspensionDurationMs`, or `isAccountSuspended`.

- [ ] **Step 1: Refactor `AccountScheduler.js`**

In `src/concurrent/AccountScheduler.js`:
- In `constructor`:
  - Delete `this.suspendedUntilMap = new Map();`
  - Delete `this.suspensionDurationMs = ...;`
- In `_checkAndResetCycle()`:
  - Delete `this.suspendedUntilMap.clear();`
- Delete method `isAccountSuspended(authIndex)` completely.
- In `recordFailure(authIndex, statusCode)`:
  - Remove `if (statusCode === 429) { ... }` suspension block.
  - Simplified method:
    ```javascript
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
    }
    ```
- In `getNextAuthIndex()`:
  - Remove `if (this.isAccountSuspended(candidateIdx)) { ... continue; }` block.

- [ ] **Step 2: Commit refactored `AccountScheduler.js`**

```bash
git add src/concurrent/AccountScheduler.js
git commit -m "refactor(concurrent): purge all suspension and isolation logic from AccountScheduler"
```

---

### Task 3: Clean Up and Update Unit Tests in `test/concurrent/account_scheduler.test.js`

**Files:**
- Modify: `test/concurrent/account_scheduler.test.js`

- [ ] **Step 1: Remove or update suspension assertions in `test/concurrent/account_scheduler.test.js`**

In `test/concurrent/account_scheduler.test.js`:
- Remove assertions checking `expect(scheduler.isAccountSuspended(...)).toBe(...)`.
- Remove references to `scheduler.suspendedUntilMap`.
- Ensure all tests in `test/concurrent/account_scheduler.test.js` pass cleanly.

- [ ] **Step 2: Run account scheduler test suite**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/concurrent/account_scheduler.test.js
git commit -m "test(concurrent): remove obsolete suspension assertions from account scheduler unit tests"
```

---

### Task 4: Full Subsystem Verification and Linting Check

**Files:**
- Test: `test/concurrent/` (all 6 test files)

- [ ] **Step 1: Run complete Jest test suite**

Run: `npx jest test/concurrent/`
Expected: PASS (6 test suites passed, 90 tests passed)

- [ ] **Step 2: Run JS Linter**

Run: `npm run lint:js`
Expected: 0 errors, 0 warnings

- [ ] **Step 3: Verify clean git status**

Run: `git status`
Expected: Clean working tree.
