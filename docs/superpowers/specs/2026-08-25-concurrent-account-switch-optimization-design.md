# Design Spec: Concurrent Account Switch Efficiency Optimization

**Date:** 2026-08-25  
**Target Subsystems:** `src/concurrent/AccountScheduler.js`, `src/core/BrowserManager.js`, `src/auth/AuthSwitcher.js`  
**Scope:** Eliminate redundant browser context teardown and rebuild cycles during manual or automatic account switching when `MAX_CONTEXTS > 1`.

---

## 1. Problem Context

In concurrent mode (`MAX_CONTEXTS > 1`), switching active accounts (via manual UI clicks on `/api/accounts/current` or automatic system switches) triggers a performance penalty where all or excess healthy browser contexts are closed, the target context is activated/launched, and then background rebalancing immediately closes the newly launched context and re-initializes the previously closed contexts.

### Microscopic Root Cause

1. **Queue Stale State in `AccountScheduler`**: When an account switch occurs, `AccountScheduler`'s `activeQueue` retains its original index order (e.g., `[0, 1, 2]`). It does not move the target account to the front of `activeQueue`.
2. **Rebalance Naive Priority Calculation**: In `AccountScheduler.rebalanceConcurrentPool()`, `priorityQueue` was calculated simply as `[...healthy, ...retired]`, where `healthy` follows `activeQueue`'s stale order.
3. **Misidentification & Teardown of Target/Existing Contexts**: If `maxContexts = 2`, `targets` is evaluated as `priorityQueue.slice(0, 2)` (e.g. `{0, 1}`). If the target account is `#2`, rebalancing notices `#2` is NOT in `targets = {0, 1}` and immediately issues a teardown for context `#2` (which was just activated seconds prior!), followed by a background preload of context `#1`.

---

## 2. Alternatives Considered

1. **Queue Front Elevation + Context Retention Rebalancing (Recommended)**:
   - Synchronize queue order by elevating `currentAuthIndex` / target index to the front of `activeQueue` (`_moveToFront`).
   - Re-architect `rebalanceConcurrentPool()` to prioritize `currentAuthIndex` and currently loaded healthy contexts over non-loaded candidate accounts when constructing `targets`.
   - Preserves resource efficiency, ensures 0ms fast switches for preloaded contexts, and completely eliminates pool churn.

2. **Hardcode Exemption for `currentAuthIndex` only**:
   - Force-include `currentAuthIndex` in `targets` during rebalance.
   - Does not update `activeQueue` ordering, causing scheduling strategies (e.g. Round-Robin) to favor obsolete queue positions.

3. **Disable Rebalancing on Manual Switches**:
   - Omit `rebalanceContextPool()` execution after manual switch calls.
   - Fragile: subsequent status polling (`/api/status`) or config reloads would still trigger rebalance and teardown.

---

## 3. Detailed Architecture & Design

### 3.1 Synchronize Queue Order (`AccountScheduler`)

Add `_moveToFront(authIndex)` to `AccountScheduler.js`:

```javascript
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

Whenever `currentAuthIndex` changes or `switchAccount` / `activateAccount` / `launchOrSwitchContext` occurs, `_moveToFront(targetAuthIndex)` is executed.

### 3.2 Enhanced Priority Target Pool Calculation (`AccountScheduler.rebalanceConcurrentPool`)

Update `rebalanceConcurrentPool()` priority queue construction:

1. **Current Account**: `currentAuthIndex` (if valid, not expired, not disabled, and not retired) gets slot #1.
2. **Existing Active Contexts**: Loaded, healthy browser contexts currently residing in `browserManager.contexts` that are not expired/disabled/retired.
3. **Remaining Healthy Accounts**: Other non-loaded healthy accounts in `activeQueue` order.
4. **Retired Accounts**: Accounts marked `RETIRED` (for fallback or last-resort preload).

`targetIndices = isUnlimited ? priorityQueue : priorityQueue.slice(0, maxContexts);`

This guarantees:
- `currentAuthIndex` is never closed during rebalancing.
- Live, healthy browser contexts in `browserManager.contexts` are retained before attempting to spin up uninitialized candidate accounts.

### 3.3 Fast-Switch Integration (`BrowserManager` & `AuthSwitcher`)

When switching to an account already present in `this.browserManager.contexts`:
- `preCleanupForSwitch(targetIndex)` verifies `contexts.has(targetIndex)` and skips removing running contexts.
- `launchOrSwitchContext(targetIndex)` executes the FastSwitch path instantly (0ms latency).
- `rebalanceConcurrentPool()` sees `targetIndex` as `currentAuthIndex` at highest priority and retains existing pool contexts up to `maxContexts`.

---

## 4. Verification & Testing

1. **Unit Tests**:
   - `test/concurrent/AccountScheduler.test.js`: Test `_moveToFront()` queue modification.
   - Verify `rebalanceConcurrentPool()` prioritizes `currentAuthIndex` and live contexts over unloaded candidate accounts.
2. **Integration Verification**:
   - Simulate manual account switch with `maxContexts = 2` across 3+ accounts.
   - Confirm target account switches instantly without closing active contexts or triggering re-launch thrashing.
3. **Code Quality**:
   - Run `npm run lint` to verify code style compliance.
