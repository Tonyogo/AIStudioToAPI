# Per-Model Single-Account Quota Limit & Scheduler Cap Interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `modelList` into `AccountScheduler` to extract per-model `dailyLimit` config and filter out accounts that reached the limit, throwing a 429 `RESOURCE_EXHAUSTED` error if all accounts exceed the limit.

**Architecture:** Update `AccountScheduler` constructor to accept `modelList` (passed via `initConcurrentMode` in `src/concurrent/index.js`), implement `getModelDailyLimit(modelName)`, filter candidate accounts in `getNextAuthIndex(modelName)` whose `usage >= limit`, and throw a 429 status error when all online accounts are capped. Update `ConcurrentRequestHandler` to return Gemini 429 JSON response on 429 errors.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Add modelList Dependency & getModelDailyLimit to AccountScheduler

**Files:**

- Modify: `src/concurrent/AccountScheduler.js`
- Modify: `src/concurrent/index.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**

- Consumes: `modelList` array in `AccountScheduler` constructor.
- Produces: `getModelDailyLimit(modelName)` method returning `number` (`dailyLimit` or `Infinity`).

- [ ] **Step 1: Write failing tests for getModelDailyLimit in AccountScheduler**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getModelDailyLimit returns configured dailyLimit or Infinity if omitted", () => {
  const mockModelList = [{ name: "models/gemini-2.5-pro", dailyLimit: 50 }, { name: "models/gemini-2.5-flash" }];
  const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, null, null, mockModelList);

  expect(scheduler.getModelDailyLimit("gemini-2.5-pro")).toBe(50);
  expect(scheduler.getModelDailyLimit("gemini-2.5-flash")).toBe(Infinity);
  expect(scheduler.getModelDailyLimit("unknown-model")).toBe(Infinity);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "getModelDailyLimit"`
Expected: FAIL (`scheduler.getModelDailyLimit is not a function`).

- [ ] **Step 3: Implement getModelDailyLimit and constructor update in AccountScheduler.js and index.js**

In `src/concurrent/AccountScheduler.js`:

1. Update constructor signature:

```javascript
constructor(
    authSource,
    connectionRegistry,
    logger = console,
    browserManager = null,
    modelUsageTracker = null,
    modelList = []
) {
    this.authSource = authSource;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.modelUsageTracker = modelUsageTracker;
    this.modelList = modelList;
    this.currentIndex = 0;
    this.accountStatusMap = new Map();
    this.lastSystemActivityAt = 0;
    this.idleTimeoutMs = 300000;
}
```

2. Add `getModelDailyLimit(modelName)` helper:

```javascript
getModelDailyLimit(modelName) {
    if (!modelName || !Array.isArray(this.modelList)) return Infinity;
    const match = this.modelList.find(m => {
        if (!m || !m.name) return false;
        const cleanName = m.name.replace("models/", "");
        return cleanName === modelName || m.name === modelName;
    });
    if (match && typeof match.dailyLimit === "number" && match.dailyLimit > 0) {
        return match.dailyLimit;
    }
    return Infinity;
}
```

In `src/concurrent/index.js`:
Pass `modelList` when creating `AccountScheduler`:

```javascript
const scheduler = new AccountScheduler(
  authSource,
  connectionRegistry,
  logger,
  browserManager,
  modelUsageTracker,
  modelList
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js src/concurrent/index.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): add modelList parameter and getModelDailyLimit to AccountScheduler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement Quota Limit Filtering and 429 Quota Exceeded Exception in getNextAuthIndex

**Files:**

- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**

- Consumes: `getNextAuthIndex(modelName)`.
- Produces: Filters out accounts with `usage >= dailyLimit`. Throws 429 error if all online accounts are capped.

- [ ] **Step 1: Write failing tests for quota limit filtering and 429 error in getNextAuthIndex**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getNextAuthIndex skips accounts that reached dailyLimit", async () => {
  mockConnectionRegistry.hasConnection.mockReturnValue(true);
  const mockModelList = [{ name: "models/gemini-2.5-pro", dailyLimit: 5 }];
  const mockModelTracker = {
    getUsage: jest.fn((idx, model) => {
      if (idx === 0) return 5; // Account 0 reached limit
      return 2; // Account 1 has 2 uses
    }),
  };

  const scheduler = new AccountScheduler(
    mockAuthSource,
    mockConnectionRegistry,
    mockLogger,
    null,
    mockModelTracker,
    mockModelList
  );
  scheduler.setAccountStatus(0, "ACTIVATED");
  scheduler.setAccountStatus(1, "ACTIVATED");

  const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
  expect(selected).toBe(1);
});

test("getNextAuthIndex throws 429 when all online accounts reach dailyLimit", async () => {
  mockConnectionRegistry.hasConnection.mockReturnValue(true);
  const mockModelList = [{ name: "models/gemini-2.5-pro", dailyLimit: 5 }];
  const mockModelTracker = {
    getUsage: jest.fn(() => 5), // All accounts reached limit
  };

  const scheduler = new AccountScheduler(
    mockAuthSource,
    mockConnectionRegistry,
    mockLogger,
    null,
    mockModelTracker,
    mockModelList
  );
  scheduler.setAccountStatus(0, "ACTIVATED");
  scheduler.setAccountStatus(1, "ACTIVATED");

  await expect(scheduler.getNextAuthIndex("gemini-2.5-pro")).rejects.toMatchObject({
    message: expect.stringContaining("All accounts reached daily limit"),
    statusCode: 429,
    statusText: "RESOURCE_EXHAUSTED",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "dailyLimit"`
Expected: FAIL (account 0 is selected or throws 503 instead of 429).

- [ ] **Step 3: Update getNextAuthIndex in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:

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

    // Check if online accounts exist and if all online accounts are capped
    let onlineAccountCount = 0;
    let cappedOnlineAccountCount = 0;

    const candidateList = [];
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
            onlineAccountCount++;
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
            if (usage >= limit) {
                cappedOnlineAccountCount++;
                continue; // Exclude accounts that reached limit
            }
            if (this.getAccountStatus(candidateIdx) === "ACTIVATED") {
                candidateList.push({ idx: candidateIdx, order: i, usage });
            }
        }
    }

    if (candidateList.length > 0) {
        // Sort primary by usage ascending, secondary by Round-Robin relative order
        candidateList.sort((a, b) => {
            if (a.usage !== b.usage) {
                return a.usage - b.usage;
            }
            return a.order - b.order;
        });

        const selectedIdx = candidateList[0].idx;
        const selectedOrder = candidateList[0].order;
        this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

        if (this.logger && typeof this.logger.debug === "function") {
            this.logger.debug(
                `[AccountScheduler] Selected least-used authIndex #${selectedIdx} for model="${modelName}" (usage=${candidateList[0].usage}/${limit})`
            );
        }
        return selectedIdx;
    }

    // Fallback: Find first online INACTIVE account that is NOT capped, and activate it synchronously
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
            if (usage >= limit) {
                continue;
            }
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] No ACTIVATED accounts available, synchronously activating authIndex #${candidateIdx}...`
                );
            }
            const activated = await this.activateAccount(candidateIdx);
            if (activated) {
                this.currentIndex = (this.currentIndex + i + 1) % total;
                return candidateIdx;
            }
        }
    }

    // If online accounts exist but ALL are capped by dailyLimit, throw 429
    if (onlineAccountCount > 0 && cappedOnlineAccountCount >= onlineAccountCount) {
        const error = new Error(
            `All accounts reached daily limit of ${limit} requests for model "${modelName}"`
        );
        error.statusCode = 429;
        error.statusText = "RESOURCE_EXHAUSTED";
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
git commit -m "feat(concurrent): filter capped accounts and throw 429 error when all accounts reach dailyLimit

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Ensure 429 Error Format Passthrough in ConcurrentRequestHandler

**Files:**

- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**

- Consumes: 429 Error thrown by `this.scheduler.getNextAuthIndex()`.
- Produces: `res.status(429).json({ error: { code: 429, message: err.message, status: "RESOURCE_EXHAUSTED" } })`.

- [ ] **Step 1: Write failing test in concurrent_request_handler.test.js for 429 scheduling error response**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
test("handleGeminiRequest returns 429 RESOURCE_EXHAUSTED when scheduler throws 429 quota error", async () => {
  mockScheduler.getNextAuthIndex.mockImplementation(async () => {
    const err = new Error('All accounts reached daily limit of 50 requests for model "gemini-2.5-pro"');
    err.statusCode = 429;
    err.statusText = "RESOURCE_EXHAUSTED";
    throw err;
  });

  const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

  const req = {
    body: { contents: [] },
    method: "POST",
    path: "/v1beta/models/gemini-2.5-pro:generateContent",
    query: {},
  };

  const res = {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };

  await handler.handleGeminiRequest(req, res);

  expect(res.status).toHaveBeenCalledWith(429);
  expect(res.json).toHaveBeenCalledWith({
    error: {
      code: 429,
      message: 'All accounts reached daily limit of 50 requests for model "gemini-2.5-pro"',
      status: "RESOURCE_EXHAUSTED",
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "returns 429 RESOURCE_EXHAUSTED"`
Expected: FAIL (`res.json` called with status `"UNAVAILABLE"` instead of `"RESOURCE_EXHAUSTED"`).

- [ ] **Step 3: Update handleGeminiRequest error catch block in ConcurrentRequestHandler.js**

In `src/concurrent/ConcurrentRequestHandler.js`:

```javascript
async handleGeminiRequest(req, res) {
    const cleanModelName = this._extractCleanModelName(req.path);
    let authIndex;
    try {
        authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
    } catch (err) {
        const statusCode = err.statusCode || 503;
        const statusText = err.statusText || (statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE");
        if (this.logger && typeof this.logger.error === "function") {
            this.logger.error(`[ConcurrentRequestHandler] Scheduling failed: ${err.message}`);
        }
        return res.status(statusCode).json({
            error: {
                code: statusCode,
                message: err.message,
                status: statusText,
            },
        });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "fix(concurrent): preserve statusText from scheduler errors in handleGeminiRequest

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Full Suite & Lint Verification

**Files:**

- Modify/Verify: `src/concurrent/*`, `test/concurrent/*`

- [ ] **Step 1: Run all concurrent unit tests**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 2: Run linter on JS files**

Run: `npm run lint:js`
Expected: PASS (0 errors)

- [ ] **Step 3: Commit any formatting or lint fixes**

```bash
git add .
git commit -m "chore(concurrent): complete per-model daily limit implementation and linting

Co-Authored-By: Claude <noreply@anthropic.com>"
```
