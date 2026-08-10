# Design Spec: Optimization for Problems 5, 7, 8 & 9 in `src/concurrent/`

**Date:** 2026-08-10  
**Target Subsystem:** `src/concurrent/`  
**Scope:** LRU Queue Operations, Timezone Calculation Delegation, Import Cleanup, Test Environment Stability  

---

## 1. Context & Objectives

The `src/concurrent/` subsystem manages multi-account request routing and scheduling for Gemini API requests in AIStudioToAPI.
Code review identified four specific technical issues to address:

- **Problem 5**: Inconsistent inline array operations on LRU `activeQueue` in `AccountScheduler.js`.
- **Problem 7**: Code duplication of `getBeijingCycleKey` calculation between `ModelUsageTracker.js` and `AccountScheduler.js`.
- **Problem 8**: Redundant inline `require("../core/FormatConverter")` statements inside `ConcurrentRequestHandler.js` methods.
- **Problem 9**: Dependency installation and module resolution issues during test execution in `test/concurrent/`.

---

## 2. Detailed Technical Design

### 2.1 Problem 5: LRU `activeQueue` Synchronization & Encapsulation

**Location:** `src/concurrent/AccountScheduler.js`

**Changes:**
1. Introduce defensive helper methods:
   - `_moveToFront(authIndex)`:
     - Validates integer `authIndex >= 0`.
     - Calls `_refreshActiveQueue()` if uninitialized.
     - Filters out any existing instances of `authIndex` from `this.activeQueue`.
     - Unshifts `authIndex` to index 0.
   - `_moveToBack(authIndex)`:
     - Validates integer `authIndex >= 0`.
     - Calls `_refreshActiveQueue()` if uninitialized.
     - Filters out any existing instances of `authIndex` from `this.activeQueue`.
     - Pushes `authIndex` to the end.

2. Refactor call sites:
   - In `getNextAuthIndex()` (Phase 1 & Phase 2 selection): replace inline `splice` + `unshift` with `this._moveToFront(selectedIdx)`.
   - In `retireAndReplaceAccount()`: replace inline `splice` + `push` with `this._moveToBack(authIndex)`.

---

### 2.2 Problem 7: Beijing 15:00 Timezone Calculation Deduplication

**Locations:** `src/concurrent/ModelUsageTracker.js` and `src/concurrent/AccountScheduler.js`

**Changes:**
1. In `ModelUsageTracker.js`:
   - Implement clean static method `ModelUsageTracker.getBeijingCycleKey(nowDate = new Date())`:
     ```javascript
     static getBeijingCycleKey(nowDate = new Date()) {
         const shifted = new Date(nowDate.getTime() + (8 - 15) * 3600 * 1000);
         const y = shifted.getUTCFullYear();
         const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
         const d = String(shifted.getUTCDate()).padStart(2, "0");
         return `${y}-${m}-${d}_15:00`;
     }
     ```
   - Keep instance method `getBeijingCycleKey(nowDate)` delegating to `ModelUsageTracker.getBeijingCycleKey(nowDate)`.

2. In `AccountScheduler.js`:
   - Refactor `getBeijingCycleKey(nowDate)` to delegate:
     ```javascript
     getBeijingCycleKey(nowDate = new Date()) {
         if (this.modelUsageTracker && typeof this.modelUsageTracker.getBeijingCycleKey === "function") {
             return this.modelUsageTracker.getBeijingCycleKey(nowDate);
         }
         return ModelUsageTracker.getBeijingCycleKey(nowDate);
     }
     ```

---

### 2.3 Problem 8: Top-Level Module Imports

**Location:** `src/concurrent/ConcurrentRequestHandler.js`

**Changes:**
1. Move `const FormatConverter = require("../core/FormatConverter");` to top-level module scope.
2. Remove redundant `require("../core/FormatConverter")` inside `constructor` and `_buildProxyRequestPayload`.

---

### 2.4 Problem 9: Test Suite Stability & Module Resolution

**Locations:** `test/concurrent/` test suites

**Changes:**
1. Verify node dependencies (`npm install --ignore-scripts`) and confirm Jest resolves all required packages (`express`, `axios`, `archiver`, etc.).
2. Run full suite `npx jest test/concurrent` ensuring 100% test pass rate across all 6 test suites.

---

## 3. Verification Plan

1. **Unit & Integration Testing**:
   Run `npx jest test/concurrent` and verify:
   - `model_usage_tracker.test.js` passes (time cycle calculations).
   - `account_scheduler.test.js` passes (LRU queue operations, retirement, cycle delegation).
   - `concurrent_request_handler.test.js` passes.
   - `index.test.js`, `integration.test.js`, `strategies.test.js` pass.

2. **Code Style & Linting**:
   Run `npm run lint:js` to verify zero ESLint errors or warnings.
