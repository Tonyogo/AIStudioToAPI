# Concurrent Retirement Strategy Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `retireAndReplaceAccount` in `AccountScheduler.js` to decouple context closing and replacement launching by triggering `browserManager.rebalanceContextPool()`.

**Architecture:** Simplify `retireAndReplaceAccount` to mark account `RETIRED`, close context, and trigger `rebalanceContextPool()` in background. Remove the `forceCooldown` parameter from `activateAccount`. Update unit tests in `account_scheduler.test.js`.

**Tech Stack:** Node.js, Express, Jest, ESLint

## Global Constraints

- All 61+ Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Refactor `retireAndReplaceAccount` and `activateAccount` in `AccountScheduler.js` and update unit tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `this.browserManager.closeContext`, `this.browserManager.rebalanceContextPool`
- Produces: `AccountScheduler.prototype.retireAndReplaceAccount` that triggers background pool rebalancing upon account retirement.

- [ ] **Step 1: Write/Update unit test in `test/concurrent/account_scheduler.test.js`**

Update `retireAndReplaceAccount` unit test to verify that retiring an account closes context and calls `rebalanceContextPool`:

```javascript
    test("retireAndReplaceAccount marks account RETIRED, closes context, and triggers rebalanceContextPool", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            rebalanceContextPool: jest.fn().mockResolvedValue(),
        };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager
        );

        scheduler.setAccountStatus(0, "ACTIVATED");

        await scheduler.retireAndReplaceAccount(0, "test retirement");

        expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
        expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(0);
        expect(mockBrowserManager.rebalanceContextPool).toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: Fail or pass depending on existing `retireAndReplaceAccount` implementation.

- [ ] **Step 3: Refactor `src/concurrent/AccountScheduler.js`**

1. Revert `activateAccount` signature by removing `forceCooldown` parameter:
```javascript
    /**
     * Activate a specific account by authIndex using BrowserManager native switch
     * @param {number} authIndex
     * @returns {Promise<boolean>}
     */
    async activateAccount(authIndex) {
        if (this.getAccountStatus(authIndex) === "RETIRED") return false;
        if (!this.browserManager) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(
                    `[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`
                );
            }
            return false;
        }

        if (this.isActivatingAny) {
            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Skipping activation for account #${authIndex}: another account activation is currently in progress`
                );
            }
            return false;
        }

        const elapsed = Date.now() - this.lastGlobalActivationAt;
        if (this.lastGlobalActivationAt > 0 && elapsed < this.activationCooldownMs) {
            const remaining = Math.ceil((this.activationCooldownMs - elapsed) / 1000);
            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(
                    `[AccountScheduler] Skipping activation for account #${authIndex}: 30s global cooldown active (${remaining}s remaining)`
                );
            }
            return false;
        }

        this.isActivatingAny = true;
        this.lastGlobalActivationAt = Date.now();
        this.setAccountStatus(authIndex, "ACTIVATING");
        try {
            await this.browserManager.launchOrSwitchContext(authIndex);
            this.setAccountStatus(authIndex, "ACTIVATED");
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[AccountScheduler] Account #${authIndex} successfully activated via BrowserManager`);
            }
            return true;
        } catch (error) {
            this.setAccountStatus(authIndex, "INACTIVE");
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[AccountScheduler] Failed to activate account #${authIndex}: ${error.message}`);
            }
            return false;
        } finally {
            this.isActivatingAny = false;
        }
    }
```

2. Refactor `retireAndReplaceAccount` in `src/concurrent/AccountScheduler.js`:
```javascript
    /**
     * Retire an account, close its browser context, and trigger background context pool rebalance
     * @param {number} authIndex
     * @param {string} reason
     * @returns {Promise<void>}
     */
    async retireAndReplaceAccount(authIndex, reason) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] Retiring account #${authIndex}: ${reason}`);
        }

        this.setAccountStatus(authIndex, "RETIRED");

        if (this.browserManager) {
            if (typeof this.browserManager.closeContext === "function") {
                try {
                    await this.browserManager.closeContext(authIndex);
                } catch (e) {
                    if (this.logger && typeof this.logger.warn === "function") {
                        this.logger.warn(`[AccountScheduler] Error closing retired context #${authIndex}: ${e.message}`);
                    }
                }
            }

            if (typeof this.browserManager.rebalanceContextPool === "function") {
                this.browserManager.rebalanceContextPool().catch(err => {
                    if (this.logger && typeof this.logger.error === "function") {
                        this.logger.error(
                            `[AccountScheduler] Background rebalance failed after retirement: ${err.message}`
                        );
                    }
                });
            }
        }
    }
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
git commit -m "refactor(concurrent): trigger rebalanceContextPool on account retirement"
```
