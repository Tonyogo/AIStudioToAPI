# Concurrent Scheduler Error Classification Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify error classification in `AccountScheduler.js` so that when online connected accounts exist but dispatch fails, the system throws `All available accounts are busy`.

**Architecture:** Simplify the error classification at the end of `getNextAuthIndex` in `AccountScheduler.js` to check `if (onlineAccountCount > 0)` and throw `All available accounts are busy` with status code 503 and status text `UNAVAILABLE`.

**Tech Stack:** Node.js, Express, Jest, ESLint

## Global Constraints

- All 63+ Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Simplify error classification in `AccountScheduler.js` and update unit tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `getNextAuthIndex`
- Produces: Simplified error throwing in `getNextAuthIndex`

- [ ] **Step 1: Write/update unit tests in `test/concurrent/account_scheduler.test.js`**

Add/update unit tests verifying:
1. When online connected accounts exist but no account is available to handle the request, `getNextAuthIndex` throws `All available accounts are busy`.
2. When no online connections exist at all, `getNextAuthIndex` throws `No active context connection available`.

```javascript
    test("getNextAuthIndex throws 503 'All available accounts are busy' when online accounts exist but dispatch fails", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager
        );

        // Account 0 is ACTIVATED and full (inFlight = 2)
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.acquireInFlight(0);
        scheduler.acquireInFlight(0);

        await expect(scheduler.getNextAuthIndex("gemini-2.5-flash")).rejects.toMatchObject({
            message: "All available accounts are busy",
            statusCode: 503,
            statusText: "UNAVAILABLE",
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "All available accounts are busy"`
Expected: FAIL (currently throws `All available accounts are busy at maximum concurrency limit (2/2)`).

- [ ] **Step 3: Update `src/concurrent/AccountScheduler.js`**

Simplify error classification at the end of `getNextAuthIndex`:

```javascript
        // Error classification: If online connected accounts exist, any dispatch failure means all accounts are busy
        if (onlineAccountCount > 0) {
            const error = new Error("All available accounts are busy");
            error.statusCode = 503;
            error.statusText = "UNAVAILABLE";
            throw error;
        }

        const error = new Error("No active context connection available");
        error.statusCode = 503;
        error.statusText = "UNAVAILABLE";
        throw error;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS (all test suites)

- [ ] **Step 5: Run linter checks**

Run: `npm run lint:js`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "refactor(concurrent): simplify error message to 'All available accounts are busy'"
```
