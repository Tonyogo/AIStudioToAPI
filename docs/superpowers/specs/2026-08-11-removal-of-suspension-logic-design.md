# Design Spec: Complete Removal of Suspension & Isolation Logic

**Date:** 2026-08-11  
**Target Subsystem:** `src/concurrent/`, `src/utils/`, `src/routes/`  
**Scope:** Complete Removal of `suspendedUntilMap`, `suspensionDurationMs`, `isAccountSuspended`, `concurrentSuspensionDurationMs`, and `CONCURRENT_SUSPENSION_DURATION_MS`  

---

## 1. Context & Objectives

The multi-account concurrent system previously used a 20-second suspension mechanism (`suspendedUntilMap`, `isAccountSuspended`) that isolated accounts temporarily after certain error status codes.
This logic has been deemed unnecessary and counter-productive as it introduced silent delay periods and reset failure counters.

**Objective**: Completely remove all suspension/isolation code, variables, config options, and helper methods across `AccountScheduler.js`, `ConfigLoader.js`, and `StatusRoutes.js`, leaving zero dead suspension code.

---

## 2. Detailed Technical Design

### 2.1 Refactoring `AccountScheduler.js`

**Location:** `src/concurrent/AccountScheduler.js`

**Changes:**
1. Remove `this.suspendedUntilMap` and `this.suspensionDurationMs` from `constructor`.
2. Remove `this.suspendedUntilMap.clear()` from `_checkAndResetCycle()`.
3. Delete method `isAccountSuspended(authIndex)` completely.
4. Simplify `recordFailure(authIndex, statusCode)`:
   ```javascript
   recordFailure(authIndex, statusCode) {
       this._checkAndResetCycle();
       if (authIndex === undefined || authIndex < 0) return;
       if (this.getAccountStatus(authIndex) === "RETIRED") return;
       if (typeof statusCode === "number") {
           this.lastStatusCodeMap.set(authIndex, statusCode);
       }

       const currentFailures = (this.failureCountMap.get(authIndex) || 0) + 1;
       this.failureCountMap.set(authIndex, currentFailures);
   }
   ```
5. Remove `if (this.isAccountSuspended(candidateIdx))` check in candidate scanning loop of `getNextAuthIndex()`.

---

### 2.2 Refactoring `ConfigLoader.js`

**Location:** `src/utils/ConfigLoader.js`

**Changes:**
1. Remove `concurrentSuspensionDurationMs: 20000` default property.
2. Remove environment parsing for `CONCURRENT_SUSPENSION_DURATION_MS`.
3. Remove logger print statement for `concurrentSuspensionDurationMs`.

---

### 2.3 Refactoring `StatusRoutes.js`

**Location:** `src/routes/StatusRoutes.js`

**Changes:**
1. Update `detail.isSuspended = false;` (or remove `detail.isSuspended` property) in status detail mapping.

---

### 2.4 Refactoring `test/concurrent/account_scheduler.test.js`

**Location:** `test/concurrent/account_scheduler.test.js`

**Changes:**
1. Remove test cases and assertions referencing `isAccountSuspended` or `suspendedUntilMap`.
2. Update tests to verify `recordFailure` cleanly increments failure counts for all status codes without suspension.

---

## 3. Verification Plan

1. **Unit Tests**: Run `npx jest test/concurrent` and verify 100% pass rate.
2. **Linting**: Run `npm run lint:js` to verify zero ESLint errors or warnings.
