# Concurrent Account Switch Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate redundant browser context teardown and rebuild loops during account switching in concurrent mode (`MAX_CONTEXTS > 1`).

**Architecture:** Update `AccountScheduler` to synchronize active queue order on account switch (`_moveToFront`), and enhance `rebalanceConcurrentPool()` to prioritize `currentAuthIndex` and currently loaded healthy browser contexts over unloaded candidate accounts when building target context pools.

**Tech Stack:** Node.js (CommonJS), Jest

## Global Constraints

- Preserve all existing fallback recovery, cycle reset, and round-robin scheduling guarantees.
- Zero breaking changes to single-context mode (`MAX_CONTEXTS = 1`) or unlimited context mode (`MAX_CONTEXTS = 0`).
- Strict linting and code style adherence (`npm run lint`).

---

### Task 1: Add Queue Front Elevation (`_moveToFront`) to `AccountScheduler`

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Produces: `AccountScheduler.prototype._moveToFront(authIndex)` - Elevates an authIndex to the front of `this.activeQueue`.

- [ ] **Step 1: Write failing unit test for `_moveToFront`**

Add a test case in `test/concurrent/account_scheduler.test.js`:

```javascript
test("_moveToFront elevates specified authIndex to the head of activeQueue", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
    scheduler._refreshActiveQueue(); // activeQueue becomes [0, 1, 2]
    expect(scheduler.activeQueue).toEqual([0, 1, 2]);

    scheduler._moveToFront(2);
    expect(scheduler.activeQueue).toEqual([2, 0, 1]);

    // Subsequent _moveToFront calls
    scheduler._moveToFront(1);
    expect(scheduler.activeQueue).toEqual([1, 2, 0]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "_moveToFront elevates"`
Expected: FAIL (`scheduler._moveToFront is not a function`).

- [ ] **Step 3: Implement `_moveToFront` in `src/concurrent/AccountScheduler.js`**

Add `_moveToFront(authIndex)` to `AccountScheduler.js`:

```javascript
/**
 * Move specified authIndex to the front of the activeQueue (MRU/Highest Priority)
 * @param {number} authIndex
 * @private
 */
_moveToFront(authIndex) {
    if (typeof authIndex !== "number" || authIndex < 0) return;
    this._refreshActiveQueue();
    if (!this.activeQueue) return;

    const idx = this.activeQueue.indexOf(authIndex);
    if (idx > -1) {
        this.activeQueue.splice(idx, 1);
        this.activeQueue.unshift(authIndex);
    }
}
```

And update `activateAccount(authIndex)` to call `this._moveToFront(authIndex)`:

```javascript
async activateAccount(authIndex) {
    if (typeof authIndex !== "number" || authIndex < 0) return false;
    this.setAccountStatus(authIndex, "ACTIVATED");
    this._moveToFront(authIndex);
    this.lastGlobalActivationAt = Date.now();
    return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "_moveToFront elevates"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): add _moveToFront queue elevation to AccountScheduler

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Enhance `rebalanceConcurrentPool` Priority Calculation

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `this.browserManager._currentAuthIndex`, `this.browserManager.contexts`
- Produces: Updated `AccountScheduler.prototype.rebalanceConcurrentPool()` priority target calculation that prioritizes current account and live contexts over unloaded candidates.

- [ ] **Step 1: Write failing unit test for `rebalanceConcurrentPool` context preservation**

Add a test case in `test/concurrent/account_scheduler.test.js`:

```javascript
test("rebalanceConcurrentPool prioritizes currentAuthIndex and loaded contexts over candidate accounts", async () => {
    const scheduler = new AccountScheduler(
        mockAuthSource,
        mockConnectionRegistry,
        mockLogger,
        mockBrowserManager,
        null,
        [],
        { maxContexts: 2 }
    );
    scheduler._refreshActiveQueue(); // [0, 1, 2]

    // Contexts Map currently holds #0 and #2
    mockBrowserManager.contexts = new Map([
        [0, { page: {} }],
        [2, { page: {} }],
    ]);
    mockBrowserManager._currentAuthIndex = 2; // Current active account is #2
    mockBrowserManager._closeContextForPoolIfPossible = jest.fn();
    mockBrowserManager._preloadBackgroundContexts = jest.fn();

    await scheduler.rebalanceConcurrentPool();

    // Verify context #2 is NOT closed
    expect(mockBrowserManager._closeContextForPoolIfPossible).not.toHaveBeenCalledWith(2, expect.any(String));
    // Verify preloading does not pull in #1 at the expense of closing #2
    expect(mockBrowserManager._closeContextForPoolIfPossible).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "rebalanceConcurrentPool prioritizes currentAuthIndex"`
Expected: FAIL (because current implementation priorityQueue closes #2 and preloads #1).

- [ ] **Step 3: Update `rebalanceConcurrentPool()` in `src/concurrent/AccountScheduler.js`**

Modify `rebalanceConcurrentPool()` in `AccountScheduler.js` to build `priorityQueue` as follows:

```javascript
async rebalanceConcurrentPool() {
    if (this._isRebalancing) {
        if (this.logger && typeof this.logger.debug === "function") {
            this.logger.debug("[ConcurrentPool] Rebalance already in progress, skipping redundant call.");
        }
        return;
    }
    this._isRebalancing = true;
    try {
        if (this.logger && typeof this.logger.info === "function") {
            this.logger.info("[ConcurrentPool] Triggering concurrent context pool rebalance...");
        }
        if (!this.browserManager) return;

        const maxContexts = this.getMaxContexts();
        const isUnlimited = maxContexts === Infinity || maxContexts === 0;

        this._refreshActiveQueue();

        const currentAuthIndex = typeof this.browserManager._currentAuthIndex === "number" ? this.browserManager._currentAuthIndex : -1;
        if (currentAuthIndex >= 0 && this.getAccountStatus(currentAuthIndex) !== "RETIRED") {
            this._moveToFront(currentAuthIndex);
        }

        const loadedContextKeys = this.browserManager.contexts && typeof this.browserManager.contexts.keys === "function"
            ? new Set(this.browserManager.contexts.keys())
            : new Set();

        const healthyLoaded = [];
        const healthyUnloaded = [];
        const retired = [];

        for (const idx of this.activeQueue) {
            const isExpired =
                this.authSource && typeof this.authSource.isExpired === "function"
                    ? this.authSource.isExpired(idx)
                    : false;
            if (isExpired) continue;

            const isDisabled =
                this.authSource && typeof this.authSource.isDisabled === "function"
                    ? this.authSource.isDisabled(idx)
                    : Array.isArray(this.authSource?.disabledIndices)
                      ? this.authSource.disabledIndices.includes(idx)
                      : false;
            if (isDisabled) continue;

            const status = this.getAccountStatus(idx);
            if (status === "RETIRED") {
                retired.push(idx);
            } else if (loadedContextKeys.has(idx)) {
                healthyLoaded.push(idx);
            } else {
                healthyUnloaded.push(idx);
            }
        }

        // Priority Queue Order:
        // 1. Current account (if healthy and loaded/unloaded)
        // 2. Healthy accounts with loaded browser contexts
        // 3. Healthy accounts without loaded contexts
        // 4. RETIRED accounts
        const priorityQueue = [];

        if (currentAuthIndex >= 0 && !this.authSource?.isExpired?.(currentAuthIndex) && !this.authSource?.isDisabled?.(currentAuthIndex) && this.getAccountStatus(currentAuthIndex) !== "RETIRED") {
            priorityQueue.push(currentAuthIndex);
        }

        for (const idx of healthyLoaded) {
            if (!priorityQueue.includes(idx)) {
                priorityQueue.push(idx);
            }
        }

        for (const idx of healthyUnloaded) {
            if (!priorityQueue.includes(idx)) {
                priorityQueue.push(idx);
            }
        }

        for (const idx of retired) {
            if (!priorityQueue.includes(idx)) {
                priorityQueue.push(idx);
            }
        }

        const targetIndices = isUnlimited ? priorityQueue : priorityQueue.slice(0, maxContexts);
        const targets = new Set(targetIndices);

        // Restore state for target candidates if currently RETIRED
        for (const targetIdx of targetIndices) {
            if (this.getAccountStatus(targetIdx) === "RETIRED") {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[ConcurrentPool] Re-activating retired account #${targetIdx} back to INACTIVE as target candidate`
                    );
                }
                this.setAccountStatus(targetIdx, "INACTIVE");
                this.failureCountMap.set(targetIdx, 0);
            }
        }

        // Close excess contexts not in targets
        if (this.browserManager.contexts && typeof this.browserManager.contexts.keys === "function") {
            for (const activeIdx of this.browserManager.contexts.keys()) {
                if (!targets.has(activeIdx)) {
                    if (this.logger && typeof this.logger.info === "function") {
                        this.logger.info(
                            `[ConcurrentPool] Closing excess active context #${activeIdx} (not in targets=[${[...targets]}])`
                        );
                    }
                    if (typeof this.browserManager._closeContextForPoolIfPossible === "function") {
                        this.browserManager._closeContextForPoolIfPossible(activeIdx, "rebalance_retired");
                    }
                }
            }
        }

        // Candidates: target indices not yet initialized in contexts Map
        const activeContexts =
            this.browserManager.contexts && typeof this.browserManager.contexts.keys === "function"
                ? new Set(this.browserManager.contexts.keys())
                : new Set();
        const candidates = targetIndices.filter(idx => !activeContexts.has(idx));

        if (candidates.length > 0) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[ConcurrentPool] Rebalancing concurrent pool: targets=[${[...targets]}], preloading candidates=[${candidates}]`
                );
            }
            if (typeof this.browserManager._preloadBackgroundContexts === "function") {
                this.browserManager._preloadBackgroundContexts(candidates, isUnlimited ? 0 : maxContexts);
            }
        }
    } finally {
        this._isRebalancing = false;
    }
}
```

- [ ] **Step 4: Run test suite to verify all tests pass**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS (all 61+ tests passing).

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "fix(concurrent): prioritize active account and loaded contexts during pool rebalance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Integration Verification & Code Formatting Check

**Files:**
- Test: `test/concurrent/account_scheduler.test.js`, `test/concurrent/integration.test.js`

- [ ] **Step 1: Run complete Jest test suite across all concurrent tests**

Run: `npx jest test/concurrent/`
Expected: PASS (all concurrent test files passing).

- [ ] **Step 2: Run code formatting and linting check**

Run: `npm run lint`
Expected: Clean output with zero lint errors.

- [ ] **Step 3: Commit any final test cleanups if required**

```bash
git commit --allow-empty -m "test(concurrent): verify account switch efficiency optimizations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
