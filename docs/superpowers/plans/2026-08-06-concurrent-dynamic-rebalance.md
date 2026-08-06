# Dynamic Concurrent Pool Rebalance & State Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `rebalanceConcurrentPool()` in `AccountScheduler.js` to dynamically prioritize healthy accounts, deprioritize RETIRED accounts, restore target RETIRED account states to INACTIVE before background preloading, and smoothly close excess RETIRED contexts.

**Architecture:** Add `rebalanceConcurrentPool()` to `AccountScheduler.js` which ranks healthy accounts first (sorted by usage ascending) and RETIRED accounts last. Resets `RETIRED` state to `INACTIVE` for accounts selected in target pool, requests `_closeContextForPoolIfPossible` for active contexts not in target pool, and triggers `_preloadBackgroundContexts` for uninitialized target candidates.

**Tech Stack:** Node.js, Express, Jest, ESLint

## Global Constraints

- All 61+ Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Implement `rebalanceConcurrentPool()` in `AccountScheduler.js` and update `retireAndReplaceAccount` and unit tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `this.authSource.isExpired`, `this.browserManager._closeContextForPoolIfPossible`, `this.browserManager._preloadBackgroundContexts`
- Produces: `AccountScheduler.prototype.rebalanceConcurrentPool`

- [ ] **Step 1: Write failing unit test in `test/concurrent/account_scheduler.test.js`**

Add unit tests verifying:
1. `rebalanceConcurrentPool` deprioritizes RETIRED accounts and restores target RETIRED accounts to INACTIVE.
2. `retireAndReplaceAccount` marks status as `RETIRED` and triggers `rebalanceConcurrentPool` (without closing context directly).

```javascript
    test("rebalanceConcurrentPool deprioritizes RETIRED accounts and restores state for target RETIRED candidates", async () => {
        const mockBrowserManager = {
            _closeContextForPoolIfPossible: jest.fn(),
            _preloadBackgroundContexts: jest.fn(),
            contexts: new Map([
                [0, { page: {} }],
                [1, { page: {} }],
            ]),
        };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 2 }
        );

        // Account 0 is RETIRED, Account 1 & 2 are INACTIVE
        scheduler.setAccountStatus(0, "RETIRED");
        scheduler.failureCountMap.set(0, 3);
        scheduler.setAccountStatus(1, "INACTIVE");
        scheduler.setAccountStatus(2, "INACTIVE");

        await scheduler.rebalanceConcurrentPool();

        // Target pool should pick 1 & 2 (healthy) first, leaving 0 (RETIRED) out
        // Context 0 should be closed via _closeContextForPoolIfPossible
        expect(mockBrowserManager._closeContextForPoolIfPossible).toHaveBeenCalledWith(0, "rebalance_retired");
        // Candidate 2 should be preloaded
        expect(mockBrowserManager._preloadBackgroundContexts).toHaveBeenCalledWith([2], 2);
    });

    test("rebalanceConcurrentPool restores RETIRED account to INACTIVE when target pool requires it", async () => {
        const mockBrowserManager = {
            _closeContextForPoolIfPossible: jest.fn(),
            _preloadBackgroundContexts: jest.fn(),
            contexts: new Map(),
        };

        const scheduler = new AccountScheduler(
            { availableIndices: [0] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 1 }
        );

        scheduler.setAccountStatus(0, "RETIRED");
        scheduler.failureCountMap.set(0, 3);

        await scheduler.rebalanceConcurrentPool();

        // Account 0 is the only account available, so it is picked as target and restored to INACTIVE
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
        expect(scheduler.failureCountMap.get(0)).toBe(0);
        expect(mockBrowserManager._preloadBackgroundContexts).toHaveBeenCalledWith([0], 1);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "rebalanceConcurrentPool"`
Expected: FAIL (method `rebalanceConcurrentPool` not defined yet).

- [ ] **Step 3: Update `src/concurrent/AccountScheduler.js`**

1. Add `rebalanceConcurrentPool()`:
```javascript
    /**
     * Rebalance concurrent context pool based on dynamic priorities and state restoration
     */
    async rebalanceConcurrentPool() {
        if (!this.browserManager) return;

        const maxContexts = this.getMaxContexts();
        const isUnlimited = maxContexts === 0;

        const indices = this._getAccountIndices();

        // 1. Filter out expired auth sources
        const validIndices = indices.filter(idx => {
            const isExpired =
                this.authSource && typeof this.authSource.isExpired === "function"
                    ? this.authSource.isExpired(idx)
                    : false;
            return !isExpired;
        });

        const healthy = [];
        const retired = [];

        for (const idx of validIndices) {
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(idx) : 0;
            const status = this.getAccountStatus(idx);
            if (status === "RETIRED") {
                retired.push({ idx, usage });
            } else {
                healthy.push({ idx, usage });
            }
        }

        healthy.sort((a, b) => a.usage - b.usage);
        retired.sort((a, b) => a.usage - b.usage);

        // Dynamic priority queue: healthy first (least-used), RETIRED last (least-used)
        const priorityQueue = [...healthy.map(h => h.idx), ...retired.map(r => r.idx)];

        const targetIndices = isUnlimited ? priorityQueue : priorityQueue.slice(0, maxContexts);
        const targets = new Set(targetIndices);

        // Restore state for target candidates if currently RETIRED
        for (const targetIdx of targetIndices) {
            if (this.getAccountStatus(targetIdx) === "RETIRED") {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[AccountScheduler] Re-activating retired account #${targetIdx} back to INACTIVE as target candidate`
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
                    `[AccountScheduler] Rebalancing concurrent pool: targets=[${[...targets]}], preloading candidates=[${candidates}]`
                );
            }
            if (typeof this.browserManager._preloadBackgroundContexts === "function") {
                this.browserManager._preloadBackgroundContexts(candidates, isUnlimited ? 0 : maxContexts);
            }
        }
    }
```

2. Simplify `retireAndReplaceAccount`:
```javascript
    /**
     * Deprioritize an account to RETIRED status and trigger dynamic concurrent pool rebalance
     * @param {number} authIndex
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async retireAndReplaceAccount(authIndex, reason) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] Deprioritizing account #${authIndex} as RETIRED: ${reason}`);
        }

        this.setAccountStatus(authIndex, "RETIRED");

        this.rebalanceConcurrentPool().catch(err => {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[AccountScheduler] Background rebalance failed after retirement: ${err.message}`);
            }
        });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Run linter checks**

Run: `npm run lint:js`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): implement rebalanceConcurrentPool with dynamic priority and state restoration"
```
