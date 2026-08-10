# Optimization for Problems 5, 7, 8 & 9 in `src/concurrent/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `src/concurrent/` components for LRU queue safety (Problem 5), Beijing cycle delegation (Problem 7), clean top-level imports (Problem 8), and test environment stability (Problem 9).

**Architecture:** Refactor `AccountScheduler.js` to use defensive `_moveToFront` and `_moveToBack` helpers for LRU operations and delegate `getBeijingCycleKey` to `ModelUsageTracker`. Promote `FormatConverter` in `ConcurrentRequestHandler.js` to top-level require. Verify test suite environment stability.

**Tech Stack:** Node.js CommonJS, Jest

## Global Constraints

- Preserve CommonJS syntax (`require`/`module.exports`).
- Maintain 100% backward compatibility with all existing tests in `test/concurrent/`.
- Ensure zero ESLint warnings or errors (`npm run lint:js`).

---

### Task 1: Refactor `ModelUsageTracker` and `AccountScheduler` Cycle Key Delegation (Problem 7)

**Files:**
- Modify: `src/concurrent/ModelUsageTracker.js:25-45`
- Modify: `src/concurrent/AccountScheduler.js:57-78`
- Test: `test/concurrent/model_usage_tracker.test.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `nowDate` (Date)
- Produces: `ModelUsageTracker.getBeijingCycleKey(nowDate)` (static and instance method returning string `YYYY-MM-DD_15:00`), `AccountScheduler.prototype.getBeijingCycleKey(nowDate)` delegating to `ModelUsageTracker`.

- [ ] **Step 1: Write the failing test for static and delegated `getBeijingCycleKey`**

Add a test in `test/concurrent/model_usage_tracker.test.js` verifying `ModelUsageTracker.getBeijingCycleKey` works as a static method and as an instance method:

```javascript
describe("ModelUsageTracker.getBeijingCycleKey static and instance delegation", () => {
    test("static method returns correct cycle key before 15:00 Beijing time", () => {
        // 2026-08-10 06:00:00 UTC = 2026-08-10 14:00:00 Beijing time (before 15:00) -> cycle key 2026-08-09_15:00
        const date = new Date("2026-08-10T06:00:00Z");
        expect(ModelUsageTracker.getBeijingCycleKey(date)).toBe("2026-08-09_15:00");
    });

    test("static method returns correct cycle key after 15:00 Beijing time", () => {
        // 2026-08-10 08:00:00 UTC = 2026-08-10 16:00:00 Beijing time (after 15:00) -> cycle key 2026-08-10_15:00
        const date = new Date("2026-08-10T08:00:00Z");
        expect(ModelUsageTracker.getBeijingCycleKey(date)).toBe("2026-08-10_15:00");
    });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx jest test/concurrent/model_usage_tracker.test.js -t "static method"`
Expected: FAIL with `ModelUsageTracker.getBeijingCycleKey is not a function`.

- [ ] **Step 3: Implement static method and delegation in `ModelUsageTracker.js` & `AccountScheduler.js`**

In `src/concurrent/ModelUsageTracker.js`:
```javascript
    /**
     * Calculate Beijing 15:00 cycle key (YYYY-MM-DD_15:00)
     * @param {Date} [nowDate]
     * @returns {string}
     */
    static getBeijingCycleKey(nowDate = new Date()) {
        const shifted = new Date(nowDate.getTime() + (8 - 15) * 3600 * 1000);
        const y = shifted.getUTCFullYear();
        const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
        const d = String(shifted.getUTCDate()).padStart(2, "0");
        return `${y}-${m}-${d}_15:00`;
    }

    /**
     * Instance wrapper for Beijing 15:00 cycle key
     * @param {Date} [nowDate]
     * @returns {string}
     */
    getBeijingCycleKey(nowDate = new Date()) {
        return ModelUsageTracker.getBeijingCycleKey(nowDate);
    }
```

In `src/concurrent/AccountScheduler.js`:
Top-level require:
```javascript
const ModelUsageTracker = require("./ModelUsageTracker");
```
And refactor `getBeijingCycleKey`:
```javascript
    /**
     * Calculate Beijing 15:00 cycle key by delegating to ModelUsageTracker
     * @param {Date} [nowDate]
     * @returns {string}
     */
    getBeijingCycleKey(nowDate = new Date()) {
        if (this.modelUsageTracker && typeof this.modelUsageTracker.getBeijingCycleKey === "function") {
            return this.modelUsageTracker.getBeijingCycleKey(nowDate);
        }
        return ModelUsageTracker.getBeijingCycleKey(nowDate);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/model_usage_tracker.test.js test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/ModelUsageTracker.js src/concurrent/AccountScheduler.js test/concurrent/model_usage_tracker.test.js
git commit -m "refactor(concurrent): delegate getBeijingCycleKey to ModelUsageTracker static method"
```

---

### Task 2: Implement LRU `activeQueue` Defensive Helpers in `AccountScheduler` (Problem 5)

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `authIndex` (number)
- Produces: `AccountScheduler.prototype._moveToFront(authIndex)`, `AccountScheduler.prototype._moveToBack(authIndex)`

- [ ] **Step 1: Write failing unit test for `_moveToFront` and `_moveToBack`**

Add unit tests in `test/concurrent/account_scheduler.test.js`:

```javascript
describe("AccountScheduler LRU activeQueue helper methods", () => {
    test("_moveToFront removes existing occurrences and places authIndex at position 0", () => {
        const mockAuthSource = { availableIndices: [0, 1, 2] };
        const scheduler = new AccountScheduler(mockAuthSource, {});
        scheduler._refreshActiveQueue(); // activeQueue = [0, 1, 2]

        scheduler._moveToFront(2);
        expect(scheduler.activeQueue).toEqual([2, 0, 1]);

        scheduler._moveToFront(1);
        expect(scheduler.activeQueue).toEqual([1, 2, 0]);
    });

    test("_moveToBack removes existing occurrences and places authIndex at the end", () => {
        const mockAuthSource = { availableIndices: [0, 1, 2] };
        const scheduler = new AccountScheduler(mockAuthSource, {});
        scheduler._refreshActiveQueue(); // activeQueue = [0, 1, 2]

        scheduler._moveToBack(0);
        expect(scheduler.activeQueue).toEqual([1, 2, 0]);
    });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "LRU activeQueue helper methods"`
Expected: FAIL with `scheduler._moveToFront is not a function`.

- [ ] **Step 3: Implement `_moveToFront` and `_moveToBack` and refactor call sites in `AccountScheduler.js`**

Add helper methods in `AccountScheduler.js`:

```javascript
    /**
     * Move authIndex to the front of activeQueue (LRU Most Recently Used)
     * @private
     * @param {number} authIndex
     */
    _moveToFront(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        this._refreshActiveQueue();
        this.activeQueue = this.activeQueue.filter(idx => idx !== authIndex);
        this.activeQueue.unshift(authIndex);
    }

    /**
     * Move authIndex to the back of activeQueue (LRU Least Recently Used / Retired)
     * @private
     * @param {number} authIndex
     */
    _moveToBack(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return;
        this._refreshActiveQueue();
        this.activeQueue = this.activeQueue.filter(idx => idx !== authIndex);
        this.activeQueue.push(authIndex);
    }
```

Refactor call sites in `AccountScheduler.js`:
1. In `retireAndReplaceAccount`:
   Replace:
   ```javascript
   this._refreshActiveQueue();
   const qIdx = this.activeQueue.indexOf(authIndex);
   if (qIdx > -1) {
       this.activeQueue.splice(qIdx, 1);
   }
   this.activeQueue.push(authIndex);
   ```
   With:
   ```javascript
   this._moveToBack(authIndex);
   ```

2. In `getNextAuthIndex` Phase 1 and Phase 2 selection:
   Replace both inline LRU unshift blocks:
   ```javascript
   this._refreshActiveQueue();
   const qIdx = this.activeQueue.indexOf(selectedIdx);
   if (qIdx > -1) {
       this.activeQueue.splice(qIdx, 1);
   }
   this.activeQueue.unshift(selectedIdx);
   ```
   With:
   ```javascript
   this._moveToFront(selectedIdx);
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS (all tests including new helper tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): encapsulate LRU activeQueue operations with _moveToFront and _moveToBack helpers"
```

---

### Task 3: Top-Level Require Clean Up in `ConcurrentRequestHandler.js` (Problem 8)

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `FormatConverter` from `../core/FormatConverter`
- Produces: Top-level `FormatConverter` import in `ConcurrentRequestHandler.js`

- [ ] **Step 1: Check existing test suite passes**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: PASS

- [ ] **Step 2: Refactor `ConcurrentRequestHandler.js` to use top-level `require`**

In `src/concurrent/ConcurrentRequestHandler.js`:
At top of file (around line 5):
```javascript
const FormatConverter = require("../core/FormatConverter");
```

In `constructor`:
Remove: `const FormatConverter = require("../core/FormatConverter");`

In `_buildProxyRequestPayload`:
Remove: `const FormatConverter = require("../core/FormatConverter");`

- [ ] **Step 3: Run test to verify all handler tests still pass**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/concurrent/ConcurrentRequestHandler.js
git commit -m "refactor(concurrent): promote FormatConverter to top-level require in ConcurrentRequestHandler"
```

---

### Task 4: Full Subsystem Verification and Lint Check (Problem 9)

**Files:**
- Test: `test/concurrent/` (all 6 test files)

- [ ] **Step 1: Run complete Jest test suite across `test/concurrent/`**

Run: `npx jest test/concurrent`
Expected: PASS (6 test suites passed, 87+ tests passed)

- [ ] **Step 2: Run ESLint on the entire codebase**

Run: `npm run lint:js`
Expected: 0 errors, 0 warnings

- [ ] **Step 3: Commit any remaining test cleanup if needed**

```bash
git status
```
Confirm clean git working tree.

---
