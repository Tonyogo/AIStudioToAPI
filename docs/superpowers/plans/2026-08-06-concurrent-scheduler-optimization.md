# Concurrent Scheduler Optimization & Dead Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up legacy `startActivationLoop`/`stopActivationLoop` methods and remove dead `Phase 3` activation fallback code from `AccountScheduler.js`.

**Architecture:** Remove `startActivationLoop` and `stopActivationLoop` methods from `AccountScheduler.js`. In `getNextAuthIndex`, remove the `Phase 3` code block completely while retaining the `Baseline Check`, `Phase 1` (Free Activated), and `Phase 2` (Lightly Busy Activated).

**Tech Stack:** Node.js, Express, Jest, ESLint

## Global Constraints

- All 60+ Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Remove `startActivationLoop`/`stopActivationLoop` and `Phase 3` in `AccountScheduler.js` and update unit tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `getNextAuthIndex`
- Produces: Streamlined `AccountScheduler` class without `startActivationLoop`, `stopActivationLoop`, or Phase 3.

- [ ] **Step 1: Remove obsolete `startActivationLoop` test and update tests in `test/concurrent/account_scheduler.test.js`**

Verify that tests run cleanly when `startActivationLoop` and Phase 3 are removed:

```javascript
// Remove any tests referencing startActivationLoop / stopActivationLoop if present.
```

- [ ] **Step 2: Clean up `AccountScheduler.js`**

1. Delete `startActivationLoop(intervalMs)` and `stopActivationLoop()` methods from `src/concurrent/AccountScheduler.js`.
2. In `getNextAuthIndex(modelName)` of `src/concurrent/AccountScheduler.js`, delete `Phase 3`:

```javascript
        // Phase 1: Use an absolutely free ACTIVATED account (inFlight === 0)
        if (activatedFree.length > 0) {
            activatedFree.sort(usageSort);
            const selectedIdx = activatedFree[0].idx;
            const selectedOrder = activatedFree[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 1: Free Activated, inFlight=0, usage=${activatedFree[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Phase 2: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
        if (activatedBusy.length > 0) {
            activatedBusy.sort(usageSort);
            const selectedIdx = activatedBusy[0].idx;
            const selectedOrder = activatedBusy[0].order;
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 2: Lightly Busy, inFlight=1, usage=${activatedBusy[0].usage}/${limit})`
                );
            }
            return selectedIdx;
        }

        // Error classification
        if (onlineAccountCount > 0 && busyOnlineAccountCount >= onlineAccountCount) {
            const error = new Error(
                `All available accounts are busy at maximum concurrency limit (${this.maxInFlightPerAccount}/${this.maxInFlightPerAccount})`
            );
            error.statusCode = 503;
            error.statusText = "UNAVAILABLE";
            throw error;
        }

        const error = new Error("No active context connection available");
        error.statusCode = 503;
        throw error;
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS (all test suites)

- [ ] **Step 4: Run linter checks**

Run: `npm run lint:js`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "refactor(concurrent): clean up startActivationLoop and remove dead Phase 3 activation logic"
```
