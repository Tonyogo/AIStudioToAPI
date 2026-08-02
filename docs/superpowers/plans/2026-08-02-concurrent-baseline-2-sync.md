# Concurrent AccountScheduler Baseline=2 and Sync Initial Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure `AccountScheduler` automatically marks `browserManager.currentAuthIndex` as `ACTIVATED` on start/check, and automatically maintains a baseline of at least 2 `ACTIVATED` accounts before serving or expanding load.

**Architecture:** Update `AccountScheduler.getNextAuthIndex` in `src/concurrent/AccountScheduler.js`: Sync `browserManager.currentAuthIndex` status to `ACTIVATED` if online. Before Phase 1, check if `activatedCount < 2` and 30s cooldown is satisfied; if so, trigger `activateAccount` on the next online `INACTIVE` account to maintain the 2-account baseline.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Automatically Sync currentAuthIndex and Maintain Baseline = 2 ACTIVATED Accounts in getNextAuthIndex

**Files:**

- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**

- Consumes: `browserManager.currentAuthIndex`.
- Produces: Automatically sets `status = "ACTIVATED"` for `browserManager.currentAuthIndex` when online, and automatically activates a second `INACTIVE` account when `activatedCount < 2` and cooldown is satisfied.

- [ ] **Step 1: Write failing test for currentAuthIndex auto-sync and baseline=2 auto-activation**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getNextAuthIndex automatically marks browserManager.currentAuthIndex as ACTIVATED", async () => {
  mockConnectionRegistry.hasConnection.mockReturnValue(true);
  const mockBrowserManager = {
    _currentAuthIndex: 0,
    _sendActiveTrigger: jest.fn(),
    launchOrSwitchContext: jest.fn().mockResolvedValue(),
  };
  const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

  // Initial status for 0 is INACTIVE
  expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");

  // Call getNextAuthIndex: should auto-sync Account 0 to ACTIVATED
  await scheduler.getNextAuthIndex("gemini-2.5-flash");
  expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
});

test("getNextAuthIndex maintains baseline = 2 ACTIVATED accounts when 30s cooldown is met", async () => {
  mockConnectionRegistry.hasConnection.mockReturnValue(true);
  const mockBrowserManager = {
    _currentAuthIndex: 0,
    _sendActiveTrigger: jest.fn(),
    launchOrSwitchContext: jest.fn().mockResolvedValue(),
  };
  const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

  // Account 0 is ACTIVATED
  scheduler.setAccountStatus(0, "ACTIVATED");
  scheduler.setAccountStatus(1, "INACTIVE");

  // Fast-forward cooldown
  scheduler.lastGlobalActivationAt = Date.now() - 31000;

  // Call getNextAuthIndex: only 1 ACTIVATED account exists (< 2). It should trigger baseline activation for Account 1!
  const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
  expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledWith(1);
  expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED");
  expect(selected).toBe(0); // Free activated account 0 selected for this request
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "maintains baseline = 2"`
Expected: FAIL (`launchOrSwitchContext` was not called for Account 1).

- [ ] **Step 3: Implement currentAuthIndex sync and Baseline = 2 check in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`, update `getNextAuthIndex`:

```javascript
async getNextAuthIndex(modelName = null) {
    this.lastSystemActivityAt = Date.now();
    const indices = this._getAccountIndices();
    if (indices.length === 0) {
        const err = new Error("No authentication accounts configured");
        err.statusCode = 503;
        throw err;
    }

    // Auto-sync browserManager.currentAuthIndex as ACTIVATED if online and currently INACTIVE
    if (this.browserManager && typeof this.browserManager.currentAuthIndex === "number") {
        const currentIdx = this.browserManager.currentAuthIndex;
        if (currentIdx >= 0 && this._hasConnection(currentIdx) && this.getAccountStatus(currentIdx) === "INACTIVE") {
            this.setAccountStatus(currentIdx, "ACTIVATED");
        }
    }

    const limit = this.getModelDailyLimit(modelName);
    const total = indices.length;

    let onlineAccountCount = 0;
    let cappedOnlineAccountCount = 0;
    let busyOnlineAccountCount = 0;

    const activatedFree = []; // inFlight === 0
    const activatedBusy = []; // inFlight === 1
    const inactiveCandidates = []; // INACTIVE & inFlight < 2

    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
            onlineAccountCount++;
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
            if (usage >= limit) {
                cappedOnlineAccountCount++;
                continue;
            }
            const inFlight = this.getInFlightCount(candidateIdx);
            if (inFlight >= this.maxInFlightPerAccount) {
                busyOnlineAccountCount++;
                continue;
            }

            const status = this.getAccountStatus(candidateIdx);
            if (status === "ACTIVATED") {
                if (inFlight === 0) {
                    activatedFree.push({ idx: candidateIdx, inFlight, order: i, usage });
                } else {
                    activatedBusy.push({ idx: candidateIdx, inFlight, order: i, usage });
                }
            } else if (status === "INACTIVE") {
                inactiveCandidates.push({ idx: candidateIdx, inFlight, order: i, usage });
            }
        }
    }

    const usageSort = (a, b) => {
        if (a.usage !== b.usage) {
            return a.usage - b.usage;
        }
        return a.order - b.order;
    };

    const totalActivated = activatedFree.length + activatedBusy.length;
    const canCooldown =
        this.lastGlobalActivationAt === 0 || Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs;

    // Baseline = 2 Check: If activated count < 2 and inactive candidates exist and 30s cooldown met, trigger background baseline activation
    if (totalActivated < 2 && inactiveCandidates.length > 0 && canCooldown) {
        inactiveCandidates.sort(usageSort);
        const baselineCandidate = inactiveCandidates.shift();
        if (this.logger && typeof this.logger.info === "function") {
            this.logger.info(
                `[AccountScheduler] Activated accounts count (${totalActivated}) < 2, activating authIndex #${baselineCandidate.idx} for baseline...`
            );
        }
        await this.activateAccount(baselineCandidate.idx);
    }

    // Phase 1: Use an absolutely free ACTIVATED account (inFlight === 0)
    if (activatedFree.length > 0) {
        activatedFree.sort(usageSort);
        const selectedIdx = activatedFree[0].idx;
        const selectedOrder = activatedFree[0].order;
        this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

        if (this.logger && typeof this.logger.debug === "function") {
            this.logger.debug(
                `[AccountScheduler] Selected free ACTIVATED authIndex #${selectedIdx} for model="${modelName}" (usage=${activatedFree[0].usage}/${limit})`
            );
        }
        return selectedIdx;
    }

    // Phase 2: Proactive Scale-Out: If all ACTIVATED accounts have inFlight > 0 and INACTIVE accounts exist, try activating one if 30s cooldown met
    if (inactiveCandidates.length > 0 && canCooldown) {
        inactiveCandidates.sort(usageSort);
        for (const candidate of inactiveCandidates) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Proactively activating INACTIVE authIndex #${candidate.idx} to spread concurrent load...`
                );
            }
            const activated = await this.activateAccount(candidate.idx);
            if (activated) {
                this.currentIndex = (this.currentIndex + candidate.order + 1) % total;
                return candidate.idx;
            }
        }
    }

    // Phase 3: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
    if (activatedBusy.length > 0) {
        activatedBusy.sort(usageSort);
        const selectedIdx = activatedBusy[0].idx;
        const selectedOrder = activatedBusy[0].order;
        this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

        if (this.logger && typeof this.logger.debug === "function") {
            this.logger.debug(
                `[AccountScheduler] Selected busy ACTIVATED authIndex #${selectedIdx} for model="${modelName}" (inFlight=1, usage=${activatedBusy[0].usage}/${limit})`
            );
        }
        return selectedIdx;
    }

    // Phase 4: Forced fallback activation
    if (inactiveCandidates.length > 0) {
        inactiveCandidates.sort(usageSort);
        for (const candidate of inactiveCandidates) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[AccountScheduler] Synchronously activating authIndex #${candidate.idx}...`);
            }
            const activated = await this.activateAccount(candidate.idx);
            if (activated) {
                this.currentIndex = (this.currentIndex + candidate.order + 1) % total;
                return candidate.idx;
            }
        }
    }

    // Error classification
    if (onlineAccountCount > 0 && cappedOnlineAccountCount >= onlineAccountCount) {
        const error = new Error(`All accounts reached daily limit of ${limit} requests for model "${modelName}"`);
        error.statusCode = 429;
        error.statusText = "RESOURCE_EXHAUSTED";
        throw error;
    }

    if (onlineAccountCount > 0 && busyOnlineAccountCount + cappedOnlineAccountCount >= onlineAccountCount) {
        const error = new Error(
            `All available accounts are busy at maximum concurrency limit (${this.maxInFlightPerAccount}/${this.maxInFlightPerAccount})`
        );
        error.statusCode = 503;
        error.statusText = "UNAVAILABLE";
        throw error;
    }

    const error = new Error("No active context connection available");
    error.statusCode = 503;
    throw error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): auto-sync currentAuthIndex and maintain baseline = 2 ACTIVATED accounts in AccountScheduler

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
git commit -m "chore(concurrent): complete baseline = 2 and initial account auto-sync implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
