# Dead Code Cleanup and Architecture Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unused dead methods (`isSystemActive` and `_extractCleanModelName`) and associated properties from `AccountScheduler.js` and `ConcurrentRequestHandler.js`, and align documentation in `README.md`.

**Architecture:** Remove obsolete code paths without altering any external interfaces or behaviors, updating unit test assertions to reflect the cleaned state.

**Tech Stack:** Node.js (CommonJS), Jest (Unit Testing), ESLint.

## Global Constraints

- **Language & Runtime:** Node.js CommonJS modules (`module.exports` / `require`).
- **Target Files:** `src/concurrent/AccountScheduler.js`, `src/concurrent/ConcurrentRequestHandler.js`, `src/concurrent/README.md`.
- **Test Files:** `test/concurrent/account_scheduler.test.js`.
- **Code Quality:** `npx eslint src/concurrent/ test/concurrent/` must pass with 0 errors.
- **Testing:** All Jest tests under `test/concurrent/` must pass.

---

### Task 1: Remove unused `isSystemActive` method and properties from `AccountScheduler.js`

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Modify: `test/concurrent/account_scheduler.test.js:259-270`

**Interfaces:**
- Removes: `isSystemActive()`, `this.idleTimeoutMs`, `this.lastSystemActivityAt` from `AccountScheduler.js`.

- [ ] **Step 1: Remove `isSystemActive` test cases from `test/concurrent/account_scheduler.test.js`**

Delete the two test blocks for `isSystemActive`:

```javascript
    test("isSystemActive returns false when idle for longer than idleTimeoutMs", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.lastSystemActivityAt = Date.now() - 300001; // 5 min 1 ms ago
        expect(scheduler.isSystemActive()).toBe(false);
    });

    test("isSystemActive returns true when recent activity exists", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.lastSystemActivityAt = Date.now() - 1000;
        expect(scheduler.isSystemActive()).toBe(true);
    });
```

- [ ] **Step 2: Remove dead properties and `isSystemActive` from `src/concurrent/AccountScheduler.js`**

In `AccountScheduler.js` constructor:
- Delete `this.lastSystemActivityAt = 0;`
- Delete `this.idleTimeoutMs = 300000;`

In `getNextAuthIndex`:
- Delete `this.lastSystemActivityAt = Date.now();`

Delete `isSystemActive()` method:
```javascript
    /**
     * Check if system is active (received request within idleTimeoutMs)
     * @returns {boolean}
     */
    isSystemActive() {
        return Date.now() - this.lastSystemActivityAt < this.idleTimeoutMs;
    }
```

- [ ] **Step 3: Run tests to verify all tests pass**

Run: `npx jest test/concurrent/`
Expected: PASS for all 87 tests.

- [ ] **Step 4: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "refactor(concurrent): remove unused isSystemActive method and properties from AccountScheduler"
```

---

### Task 2: Remove unused `_extractCleanModelName` from `ConcurrentRequestHandler.js` and align `README.md`

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js:158-173`
- Modify: `src/concurrent/README.md:83-85`

**Interfaces:**
- Removes: `_extractCleanModelName(pathStr)` from `ConcurrentRequestHandler.js`.

- [ ] **Step 1: Remove `_extractCleanModelName` from `src/concurrent/ConcurrentRequestHandler.js`**

Delete method:
```javascript
    /**
     * Extract clean model name from request path
     * @param {string} pathStr
     * @returns {string|null}
     */
    _extractCleanModelName(pathStr) {
        if (typeof pathStr !== "string") return null;
        const match = pathStr.match(/\/models\/([^:/?]+)(?::|$)/);
        if (!match) return null;
        const rawModel = match[1];
        const FormatConverter = require("../core/FormatConverter");
        const { cleanModelName: toolStripped } = FormatConverter.parseModelBuiltInToolSuffixes(rawModel);
        const { cleanModelName: streamStripped } = FormatConverter.parseModelStreamingModeSuffix(toolStripped);
        const { cleanModelName } = FormatConverter.parseModelThinkingLevel(streamStripped);
        return cleanModelName;
    }
```

- [ ] **Step 2: Update `src/concurrent/README.md` to remove outdated `_extractCleanModelName` reference**

In `src/concurrent/README.md`:
Remove line `- **模型名标准化 (`_extractCleanModelName`)：**` or align description with `_buildProxyRequestPayload`.

- [ ] **Step 3: Run full concurrent test suite to verify 100% green tests**

Run: `npx jest test/concurrent/`
Expected: PASS for all 87 tests across 6 test suites.

- [ ] **Step 4: Run ESLint to verify 0 errors**

Run: `npx eslint src/concurrent/ test/concurrent/`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js src/concurrent/README.md
git commit -m "refactor(concurrent): remove unused _extractCleanModelName method and align documentation"
```
