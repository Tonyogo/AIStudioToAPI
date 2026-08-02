# Proactive Scale-Out Concurrency Spreading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update `AccountScheduler.getNextAuthIndex` so that when all existing `ACTIVATED` accounts are processing requests (`inFlight > 0`), it proactively attempts to activate an online `INACTIVE` account (subject to the 30s cooldown) to spread concurrent load across accounts.

**Architecture:** Reorder election stages in `getNextAuthIndex` in `src/concurrent/AccountScheduler.js`: Phase 1 checks for `inFlight === 0` `ACTIVATED` accounts; Phase 2 proactively triggers `activateAccount` on online `INACTIVE` accounts if all `ACTIVATED` accounts are busy (`inFlight > 0`) and 30s cooldown has elapsed; Phase 3 reuses `inFlight === 1` `ACTIVATED` accounts; Phase 4 falls back to forced activation when all `ACTIVATED` accounts are at max cap (`inFlight >= 2`).

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Refactor getNextAuthIndex Selection Pipeline for Proactive Scale-Out Spreading

**Files:**

- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**

- Consumes: `getNextAuthIndex(modelName)`.
- Produces: Proactively activates online `INACTIVE` accounts when existing `ACTIVATED` accounts have `inFlight > 0` and 30s cooldown is satisfied.

- [ ] **Step 1: Write failing test for proactive scale-out activation when inFlight > 0**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getNextAuthIndex proactively activates INACTIVE account when existing ACTIVATED accounts have inFlight > 0 and 30s cooldown is met", async () => {
  mockConnectionRegistry.hasConnection.mockReturnValue(true);
  const mockBrowserManager = {
    _sendActiveTrigger: jest.fn(),
    launchOrSwitchContext: jest.fn().mockResolvedValue(),
  };
  const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

  // Account 0 is ACTIVATED and handling 1 request (inFlight = 1)
  scheduler.setAccountStatus(0, "ACTIVATED");
  scheduler.acquireInFlight(0);

  // Account 1 is INACTIVE and online
  scheduler.setAccountStatus(1, "INACTIVE");

  // Fast-forward cooldown so 30s has elapsed
  scheduler.lastGlobalActivationAt = Date.now() - 31000;

  // Call getNextAuthIndex: should NOT re-use Account 0 (inFlight=1), but proactively activate Account 1
  const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
  expect(selected).toBe(1);
  expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "proactively activates INACTIVE account"`
Expected: FAIL (selected index 0 instead of 1 because previous logic re-used `inFlight=1` before attempting activation).

- [ ] **Step 3: Implement multi-stage proactive scale-out selection in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`, update `getNextAuthIndex(modelName)`:

```javascript
async getNextAuthIndex(modelName = null) {
    this.lastSystemActivityAt = Date.now();
    const indices = this._getAccountIndices();
    if (indices.length === 0) {
        const err = new Error("No authentication accounts configured");
        err.statusCode = 503;
        throw err;
    }

    const limit = this.getModelDailyLimit(modelName);
    const total = indices.length;

    let onlineAccountCount = 0;
    let cappedOnlineAccountCount = 0;
    let busyOnlineAccountCount = 0;

    const activatedFree = [];  // inFlight === 0
    const activatedBusy = [];  // inFlight === 1
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

    // Sort function: primary by usage ascending, secondary by Round-Robin order
    const usageSort = (a, b) => {
        if (a.usage !== b.usage) {
            return a.usage - b.usage;
        }
        return a.order - b.order;
    };

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
    const canCooldown = this.lastGlobalActivationAt === 0 || (Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs);
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

    // Phase 4: Forced fallback activation (when no ACTIVATED accounts exist or all are capped at inFlight >= 2)
    if (inactiveCandidates.length > 0) {
        inactiveCandidates.sort(usageSort);
        for (const candidate of inactiveCandidates) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Synchronously activating authIndex #${candidate.idx}...`
                );
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
git commit -m "feat(concurrent): proactively activate INACTIVE accounts to spread concurrent load when inFlight > 0

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
git commit -m "chore(concurrent): complete proactive scale-out concurrency spreading implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
