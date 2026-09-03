# Model-Based Daily Quota Load Balancing Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `ModelUsageTracker` to track account usage per model resetting at Beijing 15:00:00 (UTC+8) with debounced file persistence, and integrate it into `AccountScheduler` so `getNextAuthIndex(modelName)` prioritizes least-used accounts for the requested model.

**Architecture:** Create `src/concurrent/ModelUsageTracker.js` with `getBeijingCycleKey()`, debounced file I/O (`data/concurrent-model-usage.json`), and `recordUsage(authIndex, modelName)`. Integrate `ModelUsageTracker` into `AccountScheduler` and update `getNextAuthIndex(modelName)` to sort candidates by model usage before falling back to Round-Robin. Call `recordUsage` in `ConcurrentRequestHandler` upon dispatching requests.

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Create ModelUsageTracker Component with Beijing 15:00 Cycle Management

**Files:**

- Create: `src/concurrent/ModelUsageTracker.js`
- Create: `test/concurrent/model_usage_tracker.test.js`

**Interfaces:**

- Consumes: `authIndex` (number), `modelName` (string).
- Produces: `ModelUsageTracker` class with:
  - `getBeijingCycleKey(nowDate)`: returns `YYYY-MM-DD_15:00`
  - `getUsage(authIndex, modelName)`: returns current cycle count (number)
  - `recordUsage(authIndex, modelName)`: increments count and debounces save to `data/concurrent-model-usage.json`
  - `loadSync()`, `saveSync()`

- [ ] **Step 1: Write failing tests for ModelUsageTracker cycle key and usage counting**

Create `test/concurrent/model_usage_tracker.test.js`:

```javascript
/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const ModelUsageTracker = require("../../src/concurrent/ModelUsageTracker");

describe("ModelUsageTracker", () => {
  const testDataDir = path.join(process.cwd(), "tmp_test_data");
  const testFilePath = path.join(testDataDir, "concurrent-model-usage.json");

  afterEach(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    if (fs.existsSync(testDataDir)) {
      fs.rmdirSync(testDataDir);
    }
  });

  test("getBeijingCycleKey calculates correct cycle key before and after 15:00 Beijing time", () => {
    const tracker = new ModelUsageTracker(null, testFilePath);

    // Beijing time: 2026-08-02 10:00:00 (UTC: 2026-08-02 02:00:00) -> before 15:00 -> cycle key is 2026-08-01_15:00
    const before15 = new Date("2026-08-02T02:00:00Z");
    expect(tracker.getBeijingCycleKey(before15)).toBe("2026-08-01_15:00");

    // Beijing time: 2026-08-02 16:00:00 (UTC: 2026-08-02 08:00:00) -> after 15:00 -> cycle key is 2026-08-02_15:00
    const after15 = new Date("2026-08-02T08:00:00Z");
    expect(tracker.getBeijingCycleKey(after15)).toBe("2026-08-02_15:00");
  });

  test("recordUsage increments count and retrieves current count", () => {
    const tracker = new ModelUsageTracker(null, testFilePath);
    expect(tracker.getUsage(0, "gemini-2.5-flash")).toBe(0);

    tracker.recordUsage(0, "gemini-2.5-flash");
    expect(tracker.getUsage(0, "gemini-2.5-flash")).toBe(1);

    tracker.recordUsage(0, "gemini-2.5-flash");
    expect(tracker.getUsage(0, "gemini-2.5-flash")).toBe(2);
    expect(tracker.getUsage(1, "gemini-2.5-flash")).toBe(0);
  });

  test("persists and restores stats from disk file", () => {
    const tracker = new ModelUsageTracker(null, testFilePath);
    tracker.recordUsage(0, "gemini-2.5-pro");
    tracker.saveSync();

    const tracker2 = new ModelUsageTracker(null, testFilePath);
    tracker2.loadSync();
    expect(tracker2.getUsage(0, "gemini-2.5-pro")).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/model_usage_tracker.test.js`
Expected: FAIL (`Cannot find module '../../src/concurrent/ModelUsageTracker'`).

- [ ] **Step 3: Implement ModelUsageTracker.js**

Create `src/concurrent/ModelUsageTracker.js`:

```javascript
/**
 * File: ModelUsageTracker.js
 * Description: Tracks model request counts per account reset daily at Beijing 15:00:00 (UTC+8)
 */

const fs = require("fs");
const path = require("path");

class ModelUsageTracker {
  /**
   * @param {Object} [logger] - Logger instance
   * @param {string} [filePath] - Custom JSON file path
   */
  constructor(logger = console, filePath = null) {
    this.logger = logger;
    this.filePath = filePath || path.join(process.cwd(), "data", "concurrent-model-usage.json");
    this.currentCycleKey = this.getBeijingCycleKey();
    this.stats = {}; // authIndex -> { modelName -> count }
    this.saveTimeout = null;

    this.loadSync();
  }

  /**
   * Calculate Beijing 15:00 cycle key (YYYY-MM-DD_15:00)
   * @param {Date} [nowDate]
   * @returns {string}
   */
  getBeijingCycleKey(nowDate = new Date()) {
    const beijingTime = new Date(nowDate.getTime() + 8 * 3600 * 1000);
    const year = beijingTime.getUTCFullYear();
    const month = String(beijingTime.getUTCMonth() + 1).padStart(2, "0");
    const day = beijingTime.getUTCDate();
    const hours = beijingTime.getUTCHours();

    const cycleDate = new Date(Date.UTC(year, beijingTime.getUTCMonth(), day));
    if (hours < 15) {
      cycleDate.setUTCDate(cycleDate.getUTCDate() - 1);
    }

    const cYear = cycleDate.getUTCFullYear();
    const cMonth = String(cycleDate.getUTCMonth() + 1).padStart(2, "0");
    const cDay = String(cycleDate.getUTCDate()).padStart(2, "0");

    return `${cYear}-${cMonth}-${cDay}_15:00`;
  }

  /**
   * Check if cycle key changed and reset stats if needed
   */
  _checkAndResetCycle() {
    const newKey = this.getBeijingCycleKey();
    if (newKey !== this.currentCycleKey) {
      if (this.logger && typeof this.logger.info === "function") {
        this.logger.info(`[ModelUsageTracker] Resetting model usage cycle from ${this.currentCycleKey} to ${newKey}`);
      }
      this.currentCycleKey = newKey;
      this.stats = {};
      this.saveSync();
    }
  }

  /**
   * Get usage count for given authIndex and modelName
   * @param {number} authIndex
   * @param {string} modelName
   * @returns {number}
   */
  getUsage(authIndex, modelName) {
    this._checkAndResetCycle();
    if (!this.stats[authIndex] || !modelName) {
      return 0;
    }
    return this.stats[authIndex][modelName] || 0;
  }

  /**
   * Record usage for given authIndex and modelName
   * @param {number} authIndex
   * @param {string} modelName
   */
  recordUsage(authIndex, modelName) {
    if (authIndex === undefined || authIndex < 0 || !modelName) return;

    this._checkAndResetCycle();
    if (!this.stats[authIndex]) {
      this.stats[authIndex] = {};
    }
    this.stats[authIndex][modelName] = (this.stats[authIndex][modelName] || 0) + 1;

    this.scheduleDebouncedSave();
  }

  /**
   * Schedule debounced save to file (500ms)
   */
  scheduleDebouncedSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => {
      this.saveSync();
    }, 500);
  }

  /**
   * Synchronously load stats from JSON file
   */
  loadSync() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(content);
        const currentKey = this.getBeijingCycleKey();
        if (data && data.cycleKey === currentKey && data.stats) {
          this.currentCycleKey = data.cycleKey;
          this.stats = data.stats;
        } else {
          this.currentCycleKey = currentKey;
          this.stats = {};
        }
      }
    } catch (e) {
      if (this.logger && typeof this.logger.warn === "function") {
        this.logger.warn(`[ModelUsageTracker] Failed to load stats from file: ${e.message}`);
      }
      this.stats = {};
    }
  }

  /**
   * Synchronously save stats to JSON file
   */
  saveSync() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        cycleKey: this.currentCycleKey,
        stats: this.stats,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      if (this.logger && typeof this.logger.error === "function") {
        this.logger.error(`[ModelUsageTracker] Failed to save stats to file: ${e.message}`);
      }
    }
  }
}

module.exports = ModelUsageTracker;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/model_usage_tracker.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ModelUsageTracker.js test/concurrent/model_usage_tracker.test.js
git commit -m "feat(concurrent): add ModelUsageTracker component with Beijing 15:00 cycle reset and debounced persistence

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Integrate ModelUsageTracker into AccountScheduler for Least-Used Selection

**Files:**

- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**

- Consumes: `ModelUsageTracker` instance, `modelName` parameter in `getNextAuthIndex(modelName)`.
- Produces: `getNextAuthIndex(modelName)` sorting `ACTIVATED` candidates by `modelUsageCount` ascending, with Round-Robin fallback on tie. `recordUsage(authIndex, modelName)` wrapper method.

- [ ] **Step 1: Write failing tests for Least-Used model scheduling in AccountScheduler**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getNextAuthIndex selects least-used account for specified model", async () => {
  mockConnectionRegistry.hasConnection.mockReturnValue(true);
  const mockModelTracker = {
    getUsage: jest.fn((idx, model) => {
      if (model === "gemini-2.5-pro") {
        if (idx === 0) return 5;
        if (idx === 1) return 1; // Account 1 has least usage for pro
        if (idx === 2) return 3;
      }
      return 0;
    }),
  };

  const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, null, mockModelTracker);
  scheduler.setAccountStatus(0, "ACTIVATED");
  scheduler.setAccountStatus(1, "ACTIVATED");
  scheduler.setAccountStatus(2, "ACTIVATED");

  const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
  expect(selected).toBe(1);
});

test("recordUsage delegates to modelUsageTracker", () => {
  const mockModelTracker = {
    recordUsage: jest.fn(),
  };
  const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, null, mockModelTracker);
  scheduler.recordUsage(0, "gemini-2.5-flash");

  expect(mockModelTracker.recordUsage).toHaveBeenCalledWith(0, "gemini-2.5-flash");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "least-used"`
Expected: FAIL (selected index is 0 instead of 1).

- [ ] **Step 3: Update AccountScheduler.js constructor and getNextAuthIndex**

In `src/concurrent/AccountScheduler.js`:

1. Update constructor signature to accept `modelUsageTracker`:

```javascript
constructor(authSource, connectionRegistry, logger = console, browserManager = null, modelUsageTracker = null) {
    this.authSource = authSource;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.modelUsageTracker = modelUsageTracker;
    this.currentIndex = 0;
    this.accountStatusMap = new Map();
    this.lastSystemActivityAt = 0;
    this.idleTimeoutMs = 300000;
}
```

2. Add `recordUsage` method:

```javascript
recordUsage(authIndex, modelName) {
    if (this.modelUsageTracker && typeof this.modelUsageTracker.recordUsage === "function") {
        this.modelUsageTracker.recordUsage(authIndex, modelName);
    }
}
```

3. Update `getNextAuthIndex(modelName)` to sort online/ACTIVATED candidates by usage:

```javascript
async getNextAuthIndex(modelName = null) {
    this.lastSystemActivityAt = Date.now();
    const indices = this._getAccountIndices();
    if (indices.length === 0) {
        const err = new Error("No authentication accounts configured");
        err.statusCode = 503;
        throw err;
    }

    const total = indices.length;
    // Collect online & ACTIVATED candidates ordered from current Round-Robin index
    const candidateList = [];
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx) && this.getAccountStatus(candidateIdx) === "ACTIVATED") {
            const usage = this.modelUsageTracker ? this.modelUsageTracker.getUsage(candidateIdx, modelName) : 0;
            candidateList.push({ idx: candidateIdx, order: i, usage });
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
                `[AccountScheduler] Selected least-used authIndex #${selectedIdx} for model="${modelName}" (usage=${candidateList[0].usage})`
            );
        }
        return selectedIdx;
    }

    // Fallback: Find first online INACTIVE account and activate it synchronously
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
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
git commit -m "feat(concurrent): update AccountScheduler getNextAuthIndex to select least-used account per model

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Extract Clean Model Name and Record Usage in ConcurrentRequestHandler & Facade

**Files:**

- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Modify: `src/concurrent/index.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**

- Consumes: `req.path` in `handleGeminiRequest`.
- Produces: Calls `this.scheduler.getNextAuthIndex(cleanModelName)` and `this.scheduler.recordUsage(authIndex, cleanModelName)` upon request dispatch. Instantiate `ModelUsageTracker` in `initConcurrentMode`.

- [ ] **Step 1: Write failing test in concurrent_request_handler.test.js for model extraction and usage recording**

Edit `test/concurrent/concurrent_request_handler.test.js`:

```javascript
test("handleGeminiRequest passes clean model name to scheduler and records usage", async () => {
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

  mockScheduler.getNextAuthIndex = jest.fn().mockResolvedValue(0);
  mockScheduler.recordUsage = jest.fn();

  const handler = new ConcurrentRequestHandler(minimalRegistry, mockScheduler, mockLogger);

  const req = {
    body: { contents: [] },
    method: "POST",
    path: "/v1beta/models/gemini-2.5-flash-think-high:generateContent",
    query: {},
  };

  const res = {
    headersSent: false,
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };

  await handler.handleGeminiRequest(req, res);

  expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledWith("gemini-2.5-flash");
  expect(mockScheduler.recordUsage).toHaveBeenCalledWith(0, "gemini-2.5-flash");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "passes clean model name"`
Expected: FAIL (`mockScheduler.getNextAuthIndex` called with no arguments).

- [ ] **Step 3: Extract clean model name and integrate usage recording in ConcurrentRequestHandler.js & index.js**

In `src/concurrent/ConcurrentRequestHandler.js`:

1. Add model extraction helper:

```javascript
_extractCleanModelName(pathStr) {
    if (typeof pathStr !== "string") return null;
    const match = pathStr.match(/\/models\/([^:/?]+)(?::|$)/);
    if (!match) return null;
    const rawModel = match[1];
    // Strip suffixes using FormatConverter utilities if available, or regex
    const FormatConverter = require("../core/FormatConverter");
    const { cleanModelName: toolStripped } = FormatConverter.parseModelBuiltInToolSuffixes(rawModel);
    const { cleanModelName: streamStripped } = FormatConverter.parseModelStreamingModeSuffix(toolStripped);
    const { cleanModelName } = FormatConverter.parseModelThinkingLevel(streamStripped);
    return cleanModelName;
}
```

2. In `handleGeminiRequest(req, res)`:

```javascript
const cleanModelName = this._extractCleanModelName(req.path);
let authIndex;
try {
    authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
} catch (err) { ... }
```

3. After `authIndex` is successfully selected and request is forwarded, call usage recording:

```javascript
if (typeof this.scheduler.recordUsage === "function" && cleanModelName) {
  this.scheduler.recordUsage(authIndex, cleanModelName);
}
```

In `src/concurrent/index.js`:

1. Require `ModelUsageTracker`:

```javascript
const ModelUsageTracker = require("./ModelUsageTracker");
```

2. Instantiate `ModelUsageTracker` and pass to `AccountScheduler`:

```javascript
const modelUsageTracker = new ModelUsageTracker(logger);
const scheduler = new AccountScheduler(authSource, connectionRegistry, logger, browserManager, modelUsageTracker);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js src/concurrent/index.js src/concurrent/ModelUsageTracker.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): extract clean model name and record model usage upon request dispatch

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
git commit -m "chore(concurrent): complete model usage load balancing scheduler implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
