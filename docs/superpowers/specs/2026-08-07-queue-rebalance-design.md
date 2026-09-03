# Design Spec: LRU Queue-Based Rebalance and Resurrection Strategy for Concurrent Subsystem

**Date:** 2026-08-07  
**Status:** Approved  
**Target File:** `src/concurrent/AccountScheduler.js`  
**Test File:** `test/concurrent/account_scheduler.test.js`

---

## 1. Background & Problem Statement

Currently, `rebalanceConcurrentPool` calculates `targets` by sorting healthy and retired candidates strictly by their total model usage. However, because `ModelUsageTracker.getUsage(idx)` expects a `modelName` parameter, calling it without one always returns `0`. This causes several major issues:
1. **Inefficient Context Closing:** All healthy accounts have a computed usage of `0`. Sorting them deterministically by alphabetical/numerical order ignores which accounts are actually running. This often closes active, healthy browser contexts prematurely, wasting CPU/memory and causing connection latency.
2. **Account Starvation during Resurrection:** When all accounts are retired, their computed usage is also `0`. Consequently, the same account (usually Account 0) is always chosen for resurrection. This hammers a single account repeatedly while other retired accounts remain idle.

---

## 2. Proposed Solution: LRU Active Queue-Based Rebalance

Implement a Least-Recently-Used (LRU) queue `activeQueue` containing all valid account indices. The queue order directly reflects the priority of each account:

- **Recently Selected/Used:** Moved to the **front (index 0)** of the queue, prioritizing them to remain in memory (`targets`).
- **Retired/Failed:** Moved to the **end (tail)** of the queue, deprioritizing them.
- **Round-Robin Resurrection:** When all accounts are retired, taking the first $N$ elements from `activeQueue` naturally selects the *earliest retired* accounts (least recently used), guaranteeing fair rotation and preventing account starvation.

---

## 3. Detailed Architecture & Design

### 3.1 Queue Initialization & Synchronization

Add `_refreshActiveQueue()` helper method in `AccountScheduler.js`:

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

### 3.2 LRU Operations on Strategy Events

1. **On Selection (`getNextAuthIndex`)**:
   When an account `selectedIdx` is chosen for dispatch, move it to the **front** of the queue:
   ```javascript
   this._refreshActiveQueue();
   const qIdx = this.activeQueue.indexOf(selectedIdx);
   if (qIdx > -1) {
       this.activeQueue.splice(qIdx, 1);
   }
   this.activeQueue.unshift(selectedIdx);
   ```

2. **On Retirement (`retireAndReplaceAccount`)**:
   When an account `authIndex` is retired, move it to the **end** of the queue:
   ```javascript
   this._refreshActiveQueue();
   const qIdx = this.activeQueue.indexOf(authIndex);
   if (qIdx > -1) {
       this.activeQueue.splice(qIdx, 1);
   }
   this.activeQueue.push(authIndex);
   ```

### 3.3 Rebalance Targets Derivation

In `rebalanceConcurrentPool()`:
1. Refresh the queue using `this._refreshActiveQueue()`.
2. Iterate through `activeQueue`, ignoring expired indices, and partition them into `healthy` and `retired` arrays. Because they are read from `activeQueue`, they **implicitly maintain their LRU ordering**:
   - `healthy` maintains the most-recently-used healthy accounts first.
   - `retired` maintains the earliest-retired accounts first.
3. Concatenate `[...healthy, ...retired]` to form the `priorityQueue`.
4. Slice the first `maxContexts` elements from `priorityQueue` as `targets`.

```javascript
this._refreshActiveQueue();
const maxContexts = this.getMaxContexts();
const isUnlimited = maxContexts === Infinity || maxContexts === 0;

const healthy = [];
const retired = [];

for (const idx of this.activeQueue) {
    const isExpired = this.authSource && typeof this.authSource.isExpired === "function"
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

const priorityQueue = [...healthy, ...retired];
const targetIndices = isUnlimited ? priorityQueue : priorityQueue.slice(0, maxContexts);
const targets = new Set(targetIndices);
```

---

## 4. Verification & Testing Plan

1. **Unit Tests (`test/concurrent/account_scheduler.test.js`)**:
   - Verify that successful selection (`getNextAuthIndex`) moves the selected index to the front of `activeQueue`.
   - Verify that retirement (`retireAndReplaceAccount`) moves the retired index to the end of `activeQueue`.
   - Verify `rebalanceConcurrentPool` correctly slices target indices based on queue priority without closing active healthy contexts.
   - Verify that when all accounts are retired, resurrection happens in a fair round-robin order (earliest-retired is resurrected first).
2. **ESLint & Full Concurrent Suite**:
   - Run `npx eslint src/concurrent/ test/concurrent/`
   - Run `npx jest test/concurrent/`
