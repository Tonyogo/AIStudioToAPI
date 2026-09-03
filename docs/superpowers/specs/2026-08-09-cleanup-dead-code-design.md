# Design Spec: Dead Code Cleanup & Architecture Optimization for Concurrent Subsystem

**Date:** 2026-08-09  
**Status:** Approved  
**Target Files:**
- `src/concurrent/AccountScheduler.js`
- `src/concurrent/ConcurrentRequestHandler.js`
- `src/concurrent/README.md`  
**Test Files:**
- `test/concurrent/account_scheduler.test.js`
- `test/concurrent/concurrent_request_handler.test.js`

---

## 1. Summary of Changes

During code audit of `src/concurrent/`, two unused dead methods and associated constructor properties were identified that can be safely removed to keep the codebase clean, lean, and maintainable.

### Identified Items for Cleanup
1. **`AccountScheduler.js`**:
   - Remove unused method `isSystemActive()`.
   - Remove unused instance properties `this.idleTimeoutMs` and `this.lastSystemActivityAt`.
2. **`ConcurrentRequestHandler.js`**:
   - Remove unused private helper method `_extractCleanModelName(pathStr)`.
3. **`README.md`**:
   - Update documentation to remove outdated references to `_extractCleanModelName`.

---

## 2. Detailed Specification

### 2.1 Refactoring `AccountScheduler.js`
- Delete `this.idleTimeoutMs = 300000;` and `this.lastSystemActivityAt = 0;` from constructor.
- Remove `this.lastSystemActivityAt = Date.now();` line from `getNextAuthIndex`.
- Delete `isSystemActive()` method.
- Update tests in `test/concurrent/account_scheduler.test.js` to remove tests targeting `isSystemActive`.

### 2.2 Refactoring `ConcurrentRequestHandler.js`
- Delete `_extractCleanModelName(pathStr)` method.
- Update tests in `test/concurrent/concurrent_request_handler.test.js` if `_extractCleanModelName` is tested directly.

### 2.3 Documentation Alignment (`README.md`)
- Remove section reference for `_extractCleanModelName` in `src/concurrent/README.md`.

---

## 3. Verification & Testing Plan

1. **Unit Tests**:
   - `npx jest test/concurrent/` (all tests pass).
2. **ESLint**:
   - `npx eslint src/concurrent/ test/concurrent/` (0 warnings, 0 errors).
