# LRU Queue-Based Rebalance and Resurrection Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `rebalanceConcurrentPool` and candidate selection to use a Least-Recently-Used (LRU) `activeQueue` so that active healthy contexts are never closed prematurely and retired accounts are resurrected in a fair round-robin order.

**Architecture:** Maintain a dynamically updated `activeQueue` array of account indices. Move recently selected accounts to the front, and retired accounts to the end. `rebalanceConcurrentPool` partitions `activeQueue` into `healthy` and `retired` to preserve LRU order, then takes the first `maxContexts` elements as targets.

**Tech Stack:** Node.js (CommonJS), Jest (Unit Testing), ESLint.

## Global Constraints

- **Language & Runtime:** Node.js CommonJS modules (`module.exports` / `require`).
- **Target File:** `src/concurrent/AccountScheduler.js`
- **Test File:** `test/concurrent/account_scheduler.test.js`
- **Code Quality:** `npx eslint src/concurrent/ test/concurrent/` must pass with 0 errors.
- **Testing:** All Jest tests under `test/concurrent/` must pass.

---

### Task 1: Implement `_refreshActiveQueue` and LRU queue updates on events

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`

**Interfaces:**
- Produces:
  - `AccountScheduler.prototype._refreshActiveQueue()`: Synchronizes and initializes `this.activeQueue` from `_getAccountIndices()`.
  - Updates `activeQueue` in `getNextAuthIndex` (moves selected index to front).
  - Updates `activeQueue` in `retireAndReplaceAccount` (moves retired index to end).

- [ ] **Step 1: Add `_refreshActiveQueue` helper method and initialize state in `src/concurrent/AccountScheduler.js`**

Add `_refreshActiveQueue()` method to `src/concurrent/AccountScheduler.js`:

```javascript
    /**
     * Synchronize and refresh the LRU active queue with current auth source indices
     * @private
     */
    _refreshActiveQueue() {
        const indices = this._getAccountIndices();
        if (!this.activeQueue) {
            this.activeQueue = [...indices];
            return;
        }

        const currentSet = new Set(this.activeQueue);
        const incomingSet = new Set(indices);

        // Filter out removed accounts
        this.activeQueue = this.activeQueue.filter(idx => incomingSet.has(idx));

        // Append new accounts to the end
        for (const idx of indices) {
            if (!currentSet.has(idx)) {
                this.activeQueue.push(idx);
            }
        }
    }
```

- [ ] **Step 2: Update queue on selection inside `getNextAuthIndex`**

At the very end of `getNextAuthIndex`, right before returning `selectedIdx` (in both Phase 1 and Phase 2 return paths):

```javascript
            // Move selected index to front of activeQueue (LRU Update)
            this._refreshActiveQueue();
            const qIdx = this.activeQueue.indexOf(selectedIdx);
            if (qIdx > -1) {
                this.activeQueue.splice(qIdx, 1);
            }
            this.activeQueue.unshift(selectedIdx);
```

Let's make sure both Phase 1 and Phase 2 blocks perform this unshift before returning.

- [ ] **Step 3: Update queue on retirement inside `retireAndReplaceAccount`**

In `retireAndReplaceAccount(authIndex, reason)`:

```javascript
    async retireAndReplaceAccount(authIndex, reason) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] Deprioritizing account #${authIndex} as RETIRED: ${reason}`);
        }

        this.setAccountStatus(authIndex, "RETIRED");

        // Move retired index to end of activeQueue (LRU Update)
        this._refreshActiveQueue();
        const qIdx = this.activeQueue.indexOf(authIndex);
        if (qIdx > -1) {
            this.activeQueue.splice(qIdx, 1);
        }
        this.activeQueue.push(authIndex);

        this.rebalanceConcurrentPool().catch(err => {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[AccountScheduler] Background rebalance failed after retirement: ${err.message}`);
            }
        });
    }
```

- [ ] **Step 4: Commit Task 1 changes**

```bash
git add src/concurrent/AccountScheduler.js
git commit -m "feat(concurrent): maintain activeQueue with LRU operations on selection and retirement"
```

---

### Task 2: Refactor `rebalanceConcurrentPool` and add tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Modify: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `this.activeQueue` maintained by Task 1.
- Modifies: `rebalanceConcurrentPool` inside `AccountScheduler.js` to derive targets from `activeQueue` instead of sorting via `modelUsageTracker.getUsage`.

- [ ] **Step 1: Write comprehensive unit tests in `test/concurrent/account_scheduler.test.js`**

Add these tests to `test/concurrent/account_scheduler.test.js`:

```javascript
    test("LRU activeQueue correctly tracks selection and retirement priorities", async () => {
        const scheduler = new AccountScheduler(
            { availableIndices: [0, 1, 2] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager
        );

        // Queue starts initialized in original order
        scheduler._refreshActiveQueue();
        expect(scheduler.activeQueue).toEqual([0, 1, 2]);

        // 1. Retirement moves element to end
        await scheduler.retireAndReplaceAccount(1, "test");
        expect(scheduler.activeQueue).toEqual([0, 2, 1]);

        // 2. Selection moves element to front
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(2, "ACTIVATED");
        // Force select candidate (with random mocking for predictability)
        jest.spyOn(Math, "random").mockReturnValue(0);
        const selected = await scheduler.getNextAuthIndex();
        expect(selected).toBe(0);
        expect(scheduler.activeQueue[0]).toBe(0); // 0 is now first

        Math.random.mockRestore();
    });

    test("rebalanceConcurrentPool correctly partitions activeQueue into targets preserving LRU order", async () => {
        const scheduler = new AccountScheduler(
            { availableIndices: [0, 1, 2] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 2 }
        );

        // Assume Account 1 is retired, Account 0 and 2 are healthy
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "RETIRED");
        scheduler.setAccountStatus(2, "ACTIVATED");

        // Force queue order: [0, 2, 1]
        scheduler.activeQueue = [0, 2, 1];

        // Trigger rebalance: healthy are [0, 2], retired is [1]
        // priorityQueue = [0, 2, 1] -> slice(0, maxContexts=2) -> targets Set should contain {0, 2}
        await scheduler.rebalanceConcurrentPool();
        expect(scheduler.getAccountStatus(0)).not.toBe("RETIRED");
        expect(scheduler.getAccountStatus(2)).not.toBe("RETIRED");
    });

    test("all accounts retired resurrects in fair round-robin order based on earliest retirement", async () => {
        const scheduler = new AccountScheduler(
            { availableIndices: [0, 1, 2] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 1 }
        );

        // 1. Retire Account 0 first, then Account 1, then Account 2
        await scheduler.retireAndReplaceAccount(0, "limit");
        await scheduler.retireAndReplaceAccount(1, "limit");
        await scheduler.retireAndReplaceAccount(2, "limit");

        // The queue order must be [0, 1, 2] since they retired sequentially, meaning Account 0 is earliest-retired
        // With maxContexts=1, targets should be {0}.
        // Account 0 is reactivated/resurrected back to INACTIVE
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
        expect(scheduler.getAccountStatus(1)).toBe("RETIRED");
        expect(scheduler.getAccountStatus(2)).toBe("RETIRED");

        // Clear mock calls
        scheduler.rebalanceConcurrentPool = jest.fn();

        // 2. Suppose Account 0 is selected and then retired again
        // Queue was [0, 1, 2] (or [1, 2, 0] after retirement of 0).
        // Let's force queue order [1, 2, 0] and set all to RETIRED again.
        scheduler.activeQueue = [1, 2, 0];
        scheduler.setAccountStatus(0, "RETIRED");
        scheduler.setAccountStatus(1, "RETIRED");
        scheduler.setAccountStatus(2, "RETIRED");

        // Let's run a real rebalance call.
        // It partitions healthy [] and retired [1, 2, 0] in that LRU order.
        // With maxContexts=1, targets should be {1} (earliest retired in current queue).
        // So Account 1 should be resurrected to INACTIVE!
        const realScheduler = new AccountScheduler(
            { availableIndices: [0, 1, 2] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 1 }
        );
        realScheduler.activeQueue = [1, 2, 0];
        realScheduler.setAccountStatus(0, "RETIRED");
        realScheduler.setAccountStatus(1, "RETIRED");
        realScheduler.setAccountStatus(2, "RETIRED");

        await realScheduler.rebalanceConcurrentPool();
        expect(realScheduler.getAccountStatus(1)).toBe("INACTIVE"); // Resurrected!
        expect(realScheduler.getAccountStatus(2)).toBe("RETIRED");
        expect(realScheduler.getAccountStatus(0)).toBe("RETIRED");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "LRU activeQueue"`
Expected: FAIL.

- [ ] **Step 3: Refactor `rebalanceConcurrentPool` inside `src/concurrent/AccountScheduler.js`**

In `rebalanceConcurrentPool()`:

```javascript
    async rebalanceConcurrentPool() {
        if (this.logger && typeof this.logger.info === "function") {
            this.logger.info("[ConcurrentPool] Triggering concurrent context pool rebalance...");
        }
        if (!this.browserManager) return;

        const maxContexts = this.getMaxContexts();
        const isUnlimited = maxContexts === Infinity || maxContexts === 0;

        this._refreshActiveQueue();

        const healthy = [];
        const retired = [];

        for (const idx of this.activeQueue) {
            const isExpired =
                this.authSource && typeof this.authSource.isExpired === "function"
                    ? this.authSource.isExpired(idx)
                    : false;
            if (isExpired) continue;

            const status = this.getAccountStatus(idx);
            if (status === "RETIRED") {
                retired.push(idx);
            } else {
                healthy.push(idx);
            }
        }

        // Implicitly maintains LRU queue order: healthy first (recently used), RETIRED last (earliest retired first)
        const priorityQueue = [...healthy, ...retired];

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
    }
```

- [ ] **Step 4: Run all concurrent tests to verify they pass**

Run: `npx jest test/concurrent/`
Expected: PASS for all 86+ tests.

- [ ] **Step 5: Run ESLint to verify zero linting errors**

Run: `npx eslint src/concurrent/ test/concurrent/`
Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): refactor rebalanceConcurrentPool using LRU activeQueue target indices"
```
