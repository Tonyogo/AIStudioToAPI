# Design Spec: Concurrency Failure Accumulation Optimization & Model Exhaustion Removal

**Date:** 2026-08-11  
**Target Subsystem:** `src/concurrent/`  
**Scope:** recordFailure Refactoring, Deletion of General Suspension Quiet Period, Removal of Model Exhaustion Retirement & Configuration  

---

## 1. Context & Objectives

Currently, in `src/concurrent/`:
1. **Problem**: HTTP 403 status code does not trigger account retirement even if it occurs multiple times consecutively. This is because:
   - 403 is not in `immediateSwitchStatusCodes` (which only contains `[429, 503]` by default).
   - In `recordFailure`, non-429 failures undergo a 20-second suspension quiet period once they reach 2 failures, which **incorrectly resets the consecutive failure count back to 0**. Therefore, the failure count never reaches `failureThreshold` (default 3), preventing retirement.
2. **Objective**: Optimize failure tracking so that non-429 status codes (like 403) cleanly accumulate consecutive failures until `failureThreshold` is reached, triggering retirement. Remove the 20-second suspension quiet logic for regular errors.
3. **Objective**: Completely remove the daily model usage limit auto-retirement logic (`exhaustedModelsThreshold` configuration and calculation) across both `AccountScheduler` and `ConfigLoader` as requested.

---

## 2. Detailed Technical Design

### 2.1 Refactoring `AccountScheduler.js` Failure Logic

**Location:** `src/concurrent/AccountScheduler.js`

**Changes:**
1. **Refactor `recordFailure(authIndex, statusCode)`**:
   - Increment `failureCountMap` for `authIndex`.
   - Remove 20-second suspension logic and consecutive failure reset logic for any status code other than `429`.
   - Keep 20-second suspension logic strictly for `429` (Rate Limit) cooling.

2. **Refactor `checkAndRetireAccount(authIndex)`**:
   - Completely remove `exhaustedCount` calculation.
   - Remove the check `else if (exhaustedCount >= maxExhausted)` for daily model limit retirement.
   - Only keep checks for `isImmediateSwitch` and `consecutiveFailures >= failureThreshold`.

---

### 2.2 Refactoring `ConfigLoader.js`

**Location:** `src/utils/ConfigLoader.js`

**Changes:**
1. Remove `exhaustedModelsThreshold` default config property.
2. Remove parsing logic for `EXHAUSTED_MODELS_THRESHOLD` env variable.

---

### 2.3 Refactoring `test/concurrent/account_scheduler.test.js`

**Location:** `test/concurrent/account_scheduler.test.js`

**Changes:**
1. Update tests to match the new behavior:
   - Ensure consecutive 403 errors smoothly increment failure count without quiet reset, eventually triggering retirement.
   - Ensure model usage limit exhaustion no longer triggers retirement.

---

## 3. Verification Plan

1. **Unit Tests**:
   - Run `npx jest test/concurrent` and verify 100% pass rate.
2. **Linting**:
   - Run `npm run lint:js` to verify zero ESLint errors or warnings.
