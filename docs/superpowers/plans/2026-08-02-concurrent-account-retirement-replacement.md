# Account Retirement, Replacement, and Default Quotas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement account retirement (`RETIRED` state) when an account hits quota limits on N models (default 1) or reaches consecutive failure threshold (default 3), close its Playwright context to free ~700MB RAM, and automatically activate an unlaunched replacement account from the rotation pool.

**Architecture:** Add `exhaustedModelsThreshold` setting to `ConfigLoader.js` (env `EXHAUSTED_MODELS_THRESHOLD`, default 1). Update `AccountScheduler.getModelDailyLimit` to return 1000 when unconfigured. Implement `checkAndRetireAccount(authIndex)` and `retireAndReplaceAccount(authIndex, reason)` in `AccountScheduler.js` to mark `RETIRED`, invoke `browserManager.closeContext(authIndex)`, and trigger `activateAccount` for a fresh idle account. Trigger `checkAndRetireAccount` in `ConcurrentRequestHandler.js` upon request completion.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Add exhaustedModelsThreshold Configuration and Default Model Limit = 1000

**Files:**
- Modify: `src/utils/ConfigLoader.js`
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `process.env.EXHAUSTED_MODELS_THRESHOLD`.
- Produces: `config.exhaustedModelsThreshold` (default `1`), `AccountScheduler.getModelDailyLimit(modelName)` returning `1000` when `dailyLimit` is unconfigured.

- [ ] **Step 1: Write failing tests for default model daily limit = 1000**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getModelDailyLimit returns 1000 when model dailyLimit is not configured", () => {
    const mockModelList = [{ name: "models/gemini-2.5-flash" }];
    const scheduler = new AccountScheduler(
        mockAuthSource,
        mockConnectionRegistry,
        mockLogger,
        null,
        null,
        mockModelList
    );

    expect(scheduler.getModelDailyLimit("gemini-2.5-flash")).toBe(1000);
    expect(scheduler.getModelDailyLimit("unknown-model")).toBe(1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "returns 1000"`
Expected: FAIL (returns `Infinity` instead of `1000`).

- [ ] **Step 3: Update ConfigLoader.js and AccountScheduler.js**

In `src/utils/ConfigLoader.js`:
1. Add `exhaustedModelsThreshold: 1,` to initial `config` object in `loadConfiguration()`.
2. Add env parsing:
```javascript
if (process.env.EXHAUSTED_MODELS_THRESHOLD) {
    const parsed = parseInt(process.env.EXHAUSTED_MODELS_THRESHOLD, 10);
    config.exhaustedModelsThreshold = Number.isFinite(parsed) ? Math.max(1, parsed) : config.exhaustedModelsThreshold;
}
```

In `src/concurrent/AccountScheduler.js`:
Update `getModelDailyLimit(modelName)`:
```javascript
getModelDailyLimit(modelName) {
    if (!Array.isArray(this.modelList) || this.modelList.length === 0) return 1000;
    if (!modelName) return 1000;
    const match = this.modelList.find(m => {
        if (!m || !m.name) return false;
        const cleanName = m.name.replace("models/", "");
        return cleanName === modelName || m.name === modelName;
    });
    if (match && typeof match.dailyLimit === "number" && match.dailyLimit > 0) {
        return match.dailyLimit;
    }
    return 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/utils/ConfigLoader.js src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): default model dailyLimit to 1000 and add exhaustedModelsThreshold config

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement checkAndRetireAccount and retireAndReplaceAccount in AccountScheduler

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: Account model usage and failure counts, `config.exhaustedModelsThreshold`, `config.failureThreshold`.
- Produces: `async checkAndRetireAccount(authIndex)` and `async retireAndReplaceAccount(authIndex, reason)`. Ignores `RETIRED` accounts in candidate selection.

- [ ] **Step 1: Write failing tests for account retirement and replacement**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("checkAndRetireAccount retires account when model usage reaches dailyLimit", async () => {
    const mockModelTracker = {
        getUsage: jest.fn((idx, model) => (idx === 0 ? 1000 : 0)),
    };
    const mockBrowserManager = {
        closeContext: jest.fn().mockResolvedValue(),
        launchOrSwitchContext: jest.fn().mockResolvedValue(),
    };
    const mockConfig = { exhaustedModelsThreshold: 1, failureThreshold: 3 };

    const scheduler = new AccountScheduler(
        mockAuthSource,
        mockConnectionRegistry,
        mockLogger,
        mockBrowserManager,
        mockModelTracker,
        [{ name: "models/gemini-2.5-flash" }],
        mockConfig
    );
    scheduler.setAccountStatus(0, "ACTIVATED");

    const retired = await scheduler.checkAndRetireAccount(0);
    expect(retired).toBe(true);
    expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
    expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(0);
});

test("checkAndRetireAccount retires account when consecutive failures reach failureThreshold", async () => {
    const mockBrowserManager = {
        closeContext: jest.fn().mockResolvedValue(),
        launchOrSwitchContext: jest.fn().mockResolvedValue(),
    };
    const mockConfig = { exhaustedModelsThreshold: 1, failureThreshold: 3 };

    const scheduler = new AccountScheduler(
        mockAuthSource,
        mockConnectionRegistry,
        mockLogger,
        mockBrowserManager,
        null,
        [],
        mockConfig
    );
    scheduler.setAccountStatus(0, "ACTIVATED");

    scheduler.recordFailure(0, 500);
    scheduler.recordFailure(0, 500);
    scheduler.recordFailure(0, 500); // 3 failures

    const retired = await scheduler.checkAndRetireAccount(0);
    expect(retired).toBe(true);
    expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "checkAndRetireAccount"`
Expected: FAIL (`scheduler.checkAndRetireAccount is not a function`).

- [ ] **Step 3: Implement retirement methods in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
1. Constructor update to accept `config = {}`:
```javascript
constructor(
    authSource,
    connectionRegistry,
    logger = console,
    browserManager = null,
    modelUsageTracker = null,
    modelList = [],
    config = {}
) {
    this.authSource = authSource;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.modelUsageTracker = modelUsageTracker;
    this.modelList = modelList;
    this.config = config;
    this.currentIndex = 0;
    this.accountStatusMap = new Map();
    this.inFlightMap = new Map();
    this.failureCountMap = new Map();
    this.suspendedUntilMap = new Map();
    this.maxInFlightPerAccount = 2;
    this.lastSystemActivityAt = 0;
    this.idleTimeoutMs = 300000;
    this.lastGlobalActivationAt = 0;
    this.activationCooldownMs = 30000;
}
```
2. Implement `checkAndRetireAccount(authIndex)`:
```javascript
async checkAndRetireAccount(authIndex) {
    if (authIndex === undefined || authIndex < 0) return false;
    if (this.getAccountStatus(authIndex) === "RETIRED") return false;

    let exhaustedCount = 0;
    const modelList = Array.isArray(this.modelList) && this.modelList.length > 0 ? this.modelList : [{ name: "models/gemini-2.5-flash" }];
    for (const modelConfig of modelList) {
        if (!modelConfig || !modelConfig.name) continue;
        const cleanName = modelConfig.name.replace("models/", "");
        const limit = this.getModelDailyLimit(cleanName);
        const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(authIndex, cleanName) : 0;
        if (usage >= limit) {
            exhaustedCount++;
        }
    }

    const maxExhausted = this.config?.exhaustedModelsThreshold || 1;
    const failureThreshold = this.config?.failureThreshold || 3;
    const consecutiveFailures = this.failureCountMap.get(authIndex) || 0;

    let shouldRetire = false;
    let reason = "";

    if (exhaustedCount >= maxExhausted) {
        shouldRetire = true;
        reason = `reached daily usage limit on ${exhaustedCount} model(s) (threshold: ${maxExhausted})`;
    } else if (consecutiveFailures >= failureThreshold) {
        shouldRetire = true;
        reason = `reached ${consecutiveFailures} consecutive failures (threshold: ${failureThreshold})`;
    }

    if (shouldRetire) {
        await this.retireAndReplaceAccount(authIndex, reason);
        return true;
    }
    return false;
}
```
3. Implement `retireAndReplaceAccount(authIndex, reason)`:
```javascript
async retireAndReplaceAccount(authIndex, reason) {
    if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn(`[AccountScheduler] Retiring account #${authIndex}: ${reason}`);
    }

    this.setAccountStatus(authIndex, "RETIRED");
    if (this.browserManager && typeof this.browserManager.closeContext === "function") {
        try {
            await this.browserManager.closeContext(authIndex);
        } catch (e) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AccountScheduler] Error closing retired context #${authIndex}: ${e.message}`);
            }
        }
    }

    const available = this._getAccountIndices();
    for (const nextIdx of available) {
        const status = this.getAccountStatus(nextIdx);
        if (status !== "RETIRED" && status !== "ACTIVATED" && status !== "ACTIVATING") {
            const canCooldown =
                this.lastGlobalActivationAt === 0 ||
                Date.now() - this.lastGlobalActivationAt >= this.activationCooldownMs;

            if (canCooldown) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[AccountScheduler] Loading new replacement account #${nextIdx} after retiring #${authIndex}...`
                    );
                }
                await this.activateAccount(nextIdx);
                break;
            }
        }
    }
}
```
4. Reset `RETIRED` statuses in `ModelUsageTracker` / `AccountScheduler` cycle reset if applicable (reset `accountStatusMap` and `failureCountMap` on Beijing 15:00 cycle reset).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): implement checkAndRetireAccount and retireAndReplaceAccount in AccountScheduler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Trigger Retirement Checks in ConcurrentRequestHandler & Facade Injection

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Modify: `src/concurrent/index.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `scheduler.checkAndRetireAccount(authIndex)`.
- Produces: Calls `checkAndRetireAccount` in `handleGeminiRequest` after request completes or errors out. Passes `system.config` in `src/concurrent/index.js`.

- [ ] **Step 1: Write failing test for retirement check trigger in ConcurrentRequestHandler**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
test("handleGeminiRequest triggers checkAndRetireAccount after request completes", async () => {
    const mockWS = { send: jest.fn() };
    const mockQueue = {
        dequeue: jest
            .fn()
            .mockResolvedValueOnce({ data: '{"ok":true}', event_type: "chunk" })
            .mockResolvedValueOnce({ type: "STREAM_END" }),
    };
    const minimalRegistry = {
        createMessageQueue: jest.fn().mockReturnValue(mockQueue),
        getConnectionByAuth: jest.fn().mockReturnValue(mockWS),
        removeMessageQueue: jest.fn(),
    };

    mockScheduler.checkAndRetireAccount = jest.fn().mockResolvedValue(false);

    const handler = new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

    const req = {
        body: { contents: [] },
        method: "POST",
        path: "/v1beta/models/gemini-2.5-flash:generateContent",
        query: {},
    };

    const res = {
        headersSent: false,
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
    };

    await handler.handleGeminiRequest(req, res);

    expect(mockScheduler.checkAndRetireAccount).toHaveBeenCalledWith(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "triggers checkAndRetireAccount"`
Expected: FAIL (`mockScheduler.checkAndRetireAccount` not called).

- [ ] **Step 3: Update ConcurrentRequestHandler.js & index.js**

In `src/concurrent/ConcurrentRequestHandler.js`:
Call `await this.scheduler.checkAndRetireAccount(authIndex)` in `finally` or after attempt completes:
```javascript
finally {
    if (typeof this.scheduler.releaseInFlight === "function") {
        this.scheduler.releaseInFlight(authIndex);
    }
    if (typeof this.scheduler.checkAndRetireAccount === "function" && authIndex !== undefined) {
        this.scheduler.checkAndRetireAccount(authIndex).catch(() => {});
    }
}
```

In `src/concurrent/index.js`:
Pass `system.config` to `AccountScheduler`:
```javascript
const config = system.config || {};
const scheduler = new AccountScheduler(
    authSource,
    connectionRegistry,
    logger,
    browserManager,
    modelUsageTracker,
    modelList,
    config
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js src/concurrent/index.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): trigger retirement check upon request completion and wire system config in facade

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Full Suite Verification & Linting

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
git commit -m "chore(concurrent): complete account retirement and replacement implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
