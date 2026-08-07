# Design Spec: Remaining Capacity Weighted Scheduling Strategy for Concurrent Subsystem

**Date:** 2026-08-07  
**Status:** Approved  
**Target File:** `src/concurrent/AccountScheduler.js`  
**Test File:** `test/concurrent/account_scheduler.test.js`

---

## 1. Problem Statement & Background

In the current `AccountScheduler`, request routing relies on deterministic ascending usage sorting (`a.usage - b.usage`). When traffic is low and multiple accounts are free (`inFlight === 0`), the account with the strictly lowest usage receives 100% of incoming requests until its usage catches up with other accounts.

This creates an under-utilization issue where one account works continuously while other healthy accounts remain completely idle if a usage gap exists between them.

---

## 2. Proposed Solution: Remaining Capacity Weighted Selection

Instead of deterministic ascending sorting, the scheduler will use **Weighted Random Selection** based on each account's remaining daily quota ($W_i = \max(1, \text{dailyLimit} - \text{usage}_i)$).

### Key Benefits
- **Proportional Traffic Distribution:** Accounts with lower usage receive a higher proportion of requests.
- **No Account Starvation:** Accounts with higher usage still receive some traffic (e.g., 10% when usage is 900 vs 100).
- **Self-Balancing:** As usage gaps narrow, probabilities automatically converge smoothly to equal 50/50 distribution.

---

## 3. Detailed Design

### 3.1 Weight Calculation Formula

For candidate account $i$ on model $m$:

$$W_i = \max\Big(1, \text{dailyLimit}(m) - \text{usage}_i(m)\Big)$$

Where:
- $\text{dailyLimit}(m)$ is retrieved via `this.getModelDailyLimit(modelName)` (default: 1000).
- $\text{usage}_i(m)$ is the daily usage count tracked by `ModelUsageTracker`.
- A floor value of `1` guarantees that an account remains selectable until it is formally marked as `RETIRED` by `checkAndRetireAccount`.

### 3.2 Candidate Selection Helper Method

Add helper method `selectWeightedCandidate(candidates, limit)` to `AccountScheduler`:

```javascript
/**
 * Select a candidate using Weighted Random Selection based on remaining capacity
 * @param {Array<Object>} candidates - List of candidates { idx, inFlight, order, usage }
 * @param {number} limit - Daily limit for current model
 * @returns {Object} Selected candidate
 */
selectWeightedCandidate(candidates, limit) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const weights = candidates.map(c => Math.max(1, limit - c.usage));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    let random = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
        random -= weights[i];
        if (random <= 0) {
            return candidates[i];
        }
    }
    return candidates[candidates.length - 1];
}
```

### 3.3 Integration into `getNextAuthIndex`

Replace deterministic sorting `candidates.sort(usageSort)[0]` in:
1. **Baseline Activation (`inactiveCandidates`)**:
   - Pick `baselineCandidate = this.selectWeightedCandidate(inactiveCandidates, limit)`.
   - Remove `baselineCandidate` from `inactiveCandidates`.
2. **Phase 1 (`activatedFree`)**:
   - Pick `selected = this.selectWeightedCandidate(activatedFree, limit)`.
3. **Phase 2 (`activatedBusy`)**:
   - Pick `selected = this.selectWeightedCandidate(activatedBusy, limit)`.

### 3.4 Updated Logging

Include remaining capacity/weight in scheduler log messages:

```text
[AccountScheduler] Selected authIndex #1 for model="gemini-2.5-pro" (Phase 1: Free Activated, inFlight=0, usage=100/1000, weight=900)
```

---

## 4. Verification & Testing Plan

1. **Unit Tests (`test/concurrent/account_scheduler.test.js`)**:
   - Add a statistical distribution test: Run `getNextAuthIndex` 1000 times with two active accounts (Usage A = 100, Usage B = 900) and verify that Account A receives ~90% (85%-95%) and Account B receives ~10% (5%-15%) of selections.
   - Verify all existing lifecycle, retirement, and recovery unit tests continue to pass.
2. **ESLint & Format Verification**:
   - Run `npm run lint:js` to ensure 0 lint errors.
