# Account Activation Lifespan and Auto-Expiration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 2-minute strict account activation lifespan and auto-expiration back to `INACTIVE` state.

**Architecture:** Update `AccountScheduler.js` to define `this.activatedLifespanMs = 120000;`. Implement `_refreshAccountStatuses()` and invoke it at the start of `getNextAuthIndex()` and `getAccountStatus()`. Implement comprehensive unit tests.

**Tech Stack:** Node.js, Jest

## Global Constraints

- Expiration must only trigger if the account has `inFlight === 0`.
- All Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Add Expiration Lifespan and Helpers in `AccountScheduler.js` and Write Unit Tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Modify: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `this.accountStatusMap`, `this.activatedLifespanMs`, `this.getInFlightCount`
- Produces: `_refreshAccountStatuses()` inside `AccountScheduler.js` and automatic state refresh inside `getNextAuthIndex()` and `getAccountStatus()`.

- [ ] **Step 1: Write failing test for 2-minute account activation expiration**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
    test("getAccountStatus and getNextAuthIndex expire ACTIVATED account back to INACTIVE after 2 minutes if inFlight is 0", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        
        // Activate account 0
        scheduler.setAccountStatus(0, "ACTIVATED");
        
        // Fast-forward lastActivatedAt by 125 seconds (exceeding 120s limit)
        const entry = scheduler.accountStatusMap.get(0);
        entry.lastActivatedAt = Date.now() - 125000;
        scheduler.accountStatusMap.set(0, entry);
        
        // Calling getAccountStatus should trigger auto-expiration since inFlight is 0
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
    });

    test("getAccountStatus and getNextAuthIndex do NOT expire ACTIVATED account if it has in-flight requests", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        
        // Activate account 0 and set inFlight = 1
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.acquireInFlight(0);
        
        // Fast-forward lastActivatedAt by 125 seconds (exceeding 120s limit)
        const entry = scheduler.accountStatusMap.get(0);
        entry.lastActivatedAt = Date.now() - 125000;
        scheduler.accountStatusMap.set(0, entry);
        
        // Calling getAccountStatus should NOT expire it because in-flight count is > 0
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "expire ACTIVATED"`
Expected: FAIL (returns `"ACTIVATED"` because expiration helper is not implemented yet).

- [ ] **Step 3: Update `AccountScheduler.js`**

1. Set `this.activatedLifespanMs = 120000;` in `AccountScheduler` constructor.
2. Implement `_refreshAccountStatuses()`:
```javascript
    /**
     * Automatically refresh all account statuses, expiring ACTIVATED accounts whose lifespan exceeded 2 mins
     */
    _refreshAccountStatuses() {
        this._checkAndResetCycle();
        const now = Date.now();
        for (const [authIndex, entry] of this.accountStatusMap.entries()) {
            if (entry && entry.status === "ACTIVATED") {
                const elapsed = now - (entry.lastActivatedAt || 0);
                if (elapsed >= this.activatedLifespanMs) {
                    const inFlight = this.getInFlightCount(authIndex);
                    if (inFlight === 0) {
                        if (this.logger && typeof this.logger.info === "function") {
                            this.logger.info(
                                `[AccountScheduler] AuthIndex #${authIndex} activation expired back to INACTIVE (lifespan: ${Math.round(elapsed / 1000)}s)`
                            );
                        }
                        this.setAccountStatus(authIndex, "INACTIVE");
                    }
                }
            }
        }
    }
```
3. Update `getAccountStatus(authIndex)`:
```javascript
    getAccountStatus(authIndex) {
        this._refreshAccountStatuses();
        const entry = this.accountStatusMap.get(authIndex);
        return entry ? entry.status : "INACTIVE";
    }
```
4. Update `setAccountStatus` (remove nested cycle checks to avoid recursion/loops):
```javascript
    setAccountStatus(authIndex, status) {
        this._checkAndResetCycle();
        const existing = this.accountStatusMap.get(authIndex) || { lastActivatedAt: null, lastRequestAt: null };
        this.accountStatusMap.set(authIndex, {
            ...existing,
            lastActivatedAt: status === "ACTIVATED" ? Date.now() : existing.lastActivatedAt,
            status,
        });
    }
```
5. Update `getNextAuthIndex(modelName)` (call `this._refreshAccountStatuses()` at the top):
```javascript
    async getNextAuthIndex(modelName = null) {
        this._refreshAccountStatuses();
        this.lastSystemActivityAt = Date.now();
        const indices = this._getAccountIndices();
        ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Run linter checks**

Run: `npm run lint:js`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): support auto-expiring activated accounts back to inactive after 2 minutes"
```
