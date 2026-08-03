# Native Activation Alignment and In-Flight / Model Usage Balanced Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `AccountScheduler` activation and election methods to completely delegate heavy browser switching/activation to `browserManager.launchOrSwitchContext`, eliminating duplicate activation steps and mouse contention while retaining in-flight and model-usage load balancing.

**Architecture:** Update `AccountScheduler` in `src/concurrent/AccountScheduler.js`: Add explicit status sync helpers (`markAccountActivated(authIndex)` and `markAccountInactive(authIndex)`), refactor `activateAccount(authIndex)` to delegate to `browserManager.launchOrSwitchContext` without redundant manual triggers, and maintain 4-phase election sorting by `inFlightCount` ascending then `usageCount` ascending.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Add Native Activation Status API & Refactor activateAccount

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `browserManager.launchOrSwitchContext(authIndex)`.
- Produces: `markAccountActivated(authIndex)`, `markAccountInactive(authIndex)`, refactored `activateAccount(authIndex)`.

- [ ] **Step 1: Write failing test for markAccountActivated and markAccountInactive**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("markAccountActivated and markAccountInactive update accountStatusMap correctly", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
    expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");

    scheduler.markAccountActivated(0);
    expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");

    scheduler.markAccountInactive(0);
    expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "markAccountActivated"`
Expected: FAIL (`scheduler.markAccountActivated is not a function`).

- [ ] **Step 3: Implement markAccountActivated, markAccountInactive, and refactor activateAccount in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:

```javascript
/**
 * Mark an account as ACTIVATED
 * @param {number} authIndex
 */
markAccountActivated(authIndex) {
    this.setAccountStatus(authIndex, "ACTIVATED");
}

/**
 * Mark an account as INACTIVE
 * @param {number} authIndex
 */
markAccountInactive(authIndex) {
    this.setAccountStatus(authIndex, "INACTIVE");
}

/**
 * Activate a specific account by authIndex using BrowserManager native switch
 * @param {number} authIndex
 * @returns {Promise<boolean>}
 */
async activateAccount(authIndex) {
    if (!this.browserManager) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(
                `[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`
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

    this.setAccountStatus(authIndex, "ACTIVATING");
    try {
        await this.browserManager.launchOrSwitchContext(authIndex);
        this.lastGlobalActivationAt = Date.now();
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
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): add native activation status API and delegate activateAccount to BrowserManager

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Full Suite Verification & Linting

**Files:**
- Modify/Verify: `src/concurrent/*`, `test/concurrent/*`

- [ ] **Step 1: Run all concurrent unit tests**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 2: Run linter on JS files**

Run: `npm run lint:js`
Expected: PASS (0 errors)

- [ ] **Step 3: Commit formatting or lint fixes**

```bash
git add .
git commit -m "chore(concurrent): complete native activation alignment and scheduling verification

Co-Authored-By: Claude <noreply@anthropic.com>"
```
