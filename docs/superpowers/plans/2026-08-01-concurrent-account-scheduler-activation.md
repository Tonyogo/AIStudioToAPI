# Concurrent AccountScheduler Activation and Lazy Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `AccountScheduler` and `initConcurrentMode` to maintain an account activation state machine (`INACTIVE`, `ACTIVATING`, `ACTIVATED`), automatically trigger active probe flows to clear Google AI Studio `Launch/Rocket` button overlays, and apply a 5-minute idle-timeout lazy loading strategy to minimize context switches.

**Architecture:** Inject `browserManager` into `AccountScheduler` via `initConcurrentMode`. `AccountScheduler` maintains an internal `accountStatusMap` and system activity timestamp. In `getNextAuthIndex()`, requests refresh `lastSystemActivityAt` and prioritize `ACTIVATED` accounts. If no `ACTIVATED` account is ready, it synchronously activates a candidate account; in parallel, a lazy-loaded activation loop maintains background accounts while the system is active (`Date.now() - lastSystemActivityAt < 300000`).

**Tech Stack:** Node.js, Express, Jest

## Global Constraints

- Follow existing codebase patterns and comment style in `src/concurrent/AccountScheduler.js`.
- Keep modifications self-contained in `src/concurrent/` without breaking existing interfaces.
- Ensure 100% test pass rate in `test/concurrent/`.

---

### Task 1: Add Account State Machine and Dependency Injection

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Modify: `src/concurrent/index.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `browserManager` passed to `AccountScheduler` constructor.
- Produces: `accountStatusMap` (`Map<number, { status: string, lastActivatedAt: number|null, lastRequestAt: number|null }>`), `getAccountStatus(authIndex)`, `setAccountStatus(authIndex, status)`.

- [ ] **Step 1: Write failing tests for state machine tracking and browserManager injection**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("initializes account status as INACTIVE by default", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
    expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
});

test("updates and retrieves account status correctly", () => {
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
    scheduler.setAccountStatus(0, "ACTIVATED");
    expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "initializes account status"`
Expected: FAIL (`scheduler.getAccountStatus is not a function`).

- [ ] **Step 3: Implement constructor injection & account status methods in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
1. Update constructor signature: `constructor(authSource, connectionRegistry, logger = console, browserManager = null)`
2. Initialize `this.browserManager = browserManager;`, `this.accountStatusMap = new Map();`, `this.lastSystemActivityAt = 0;`, `this.idleTimeoutMs = 300000;`.
3. Add helper methods:
```javascript
getAccountStatus(authIndex) {
    const entry = this.accountStatusMap.get(authIndex);
    return entry ? entry.status : "INACTIVE";
}

setAccountStatus(authIndex, status) {
    const existing = this.accountStatusMap.get(authIndex) || { lastActivatedAt: null, lastRequestAt: null };
    this.accountStatusMap.set(authIndex, {
        ...existing,
        lastActivatedAt: status === "ACTIVATED" ? Date.now() : existing.lastActivatedAt,
        status,
    });
}
```
4. In `src/concurrent/index.js`, update `AccountScheduler` instantiation:
```javascript
const browserManager = system.browserManager || null;
const scheduler = new AccountScheduler(authSource, connectionRegistry, logger, browserManager);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js src/concurrent/index.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): introduce account state machine and browserManager injection in AccountScheduler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Implement Single Account Activation Pipeline

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `browserManager.launchOrSwitchContext(authIndex)` and `browserManager._sendActiveTrigger("[Scheduler]", page)`.
- Produces: `async activateAccount(authIndex)` returning `boolean` (true if activation succeeded and status set to `ACTIVATED`, false otherwise).

- [ ] **Step 1: Write failing tests for activateAccount pipeline**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("activateAccount successfully activates account", async () => {
    const mockBrowserManager = {
        _sendActiveTrigger: jest.fn(),
        launchOrSwitchContext: jest.fn().mockResolvedValue(),
        page: { isClosed: () => false },
    };
    mockConnectionRegistry.hasConnection.mockReturnValue(true);

    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
    const success = await scheduler.activateAccount(0);

    expect(success).toBe(true);
    expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledWith(0);
    expect(mockBrowserManager._sendActiveTrigger).toHaveBeenCalled();
    expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
});

test("activateAccount handles failure gracefully and sets INACTIVE", async () => {
    const mockBrowserManager = {
        launchOrSwitchContext: jest.fn().mockRejectedValue(new Error("Context failed")),
    };

    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
    const success = await scheduler.activateAccount(0);

    expect(success).toBe(false);
    expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "activateAccount"`
Expected: FAIL (`scheduler.activateAccount is not a function`).

- [ ] **Step 3: Implement activateAccount in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
```javascript
async activateAccount(authIndex) {
    if (!this.browserManager) {
        if (this.logger && typeof this.logger.warn === "function") {
            this.logger.warn(`[AccountScheduler] Cannot activate account #${authIndex}: browserManager not injected`);
        }
        return false;
    }

    this.setAccountStatus(authIndex, "ACTIVATING");
    try {
        await this.browserManager.launchOrSwitchContext(authIndex);
        const page = this.browserManager.page;
        if (typeof this.browserManager._sendActiveTrigger === "function") {
            this.browserManager._sendActiveTrigger("[AccountScheduler]", page);
        }
        this.setAccountStatus(authIndex, "ACTIVATED");
        if (this.logger && typeof this.logger.info === "function") {
            this.logger.info(`[AccountScheduler] Account #${authIndex} successfully activated`);
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

Run: `npx jest test/concurrent/account_scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): implement single account activation pipeline

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Implement ACTIVATED Account Filtering and Fallback Activation in getNextAuthIndex

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `getNextAuthIndex()` calls.
- Produces: Selected `authIndex` that is `ACTIVATED` (or synchronously activated via fallback if no `ACTIVATED` account is ready).

- [ ] **Step 1: Write failing tests for getNextAuthIndex filtering and fallback**

Edit `test/concurrent/account_scheduler.test.js`:

```javascript
test("getNextAuthIndex prioritizes ACTIVATED accounts", () => {
    mockConnectionRegistry.hasConnection.mockReturnValue(true);
    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

    scheduler.setAccountStatus(0, "INACTIVE");
    scheduler.setAccountStatus(1, "ACTIVATED");
    scheduler.setAccountStatus(2, "INACTIVE");

    expect(scheduler.getNextAuthIndex()).toBe(1);
});

test("getNextAuthIndex falls back to synchronous activation if no ACTIVATED account exists", async () => {
    mockConnectionRegistry.hasConnection.mockReturnValue(true);
    const mockBrowserManager = {
        _sendActiveTrigger: jest.fn(),
        launchOrSwitchContext: jest.fn().mockResolvedValue(),
    };

    const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
    scheduler.setAccountStatus(0, "INACTIVE");
    scheduler.setAccountStatus(1, "INACTIVE");

    const index = await scheduler.getNextAuthIndex();
    expect(index).toBe(0);
    expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "getNextAuthIndex"`
Expected: FAIL (returns index 0 instead of prioritizing index 1, or fails fallback test).

- [ ] **Step 3: Update getNextAuthIndex in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
1. Mark `getNextAuthIndex` as `async getNextAuthIndex()`.
2. Touch activity timestamp: `this.lastSystemActivityAt = Date.now();`.
3. Filter candidates:
```javascript
async getNextAuthIndex() {
    this.lastSystemActivityAt = Date.now();
    const indices = this._getAccountIndices();
    if (indices.length === 0) {
        const err = new Error("No authentication accounts configured");
        err.statusCode = 503;
        throw err;
    }

    const total = indices.length;
    // 1. Try to find an ACTIVATED account first
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx) && this.getAccountStatus(candidateIdx) === "ACTIVATED") {
            this.currentIndex = (this.currentIndex + i + 1) % total;
            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug(`[AccountScheduler] Selected ACTIVATED authIndex #${candidateIdx}`);
            }
            return candidateIdx;
        }
    }

    // 2. Fallback: Find first online INACTIVE account and activate it synchronously
    for (let i = 0; i < total; i++) {
        const candidateIdx = indices[(this.currentIndex + i) % total];
        if (this._hasConnection(candidateIdx)) {
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[AccountScheduler] No ACTIVATED accounts available, synchronously activating authIndex #${candidateIdx}...`);
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
4. Note: Update `ConcurrentRequestHandler.js` line 146 where `this.scheduler.getNextAuthIndex()` is called to `await this.scheduler.getNextAuthIndex()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js src/concurrent/ConcurrentRequestHandler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): filter ACTIVATED accounts and support fallback activation in getNextAuthIndex

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Implement Lazy Loading Loop and Idle Timeout Policy

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: Idle check interval (`idleTimeoutMs` = 300,000ms / 5 minutes).
- Produces: `startActivationLoop()`, `stopActivationLoop()`, `isSystemActive()`.

- [ ] **Step 1: Write failing tests for lazy loading loop and idle timeout**

Edit `test/concurrent/account_scheduler.test.js`:

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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "isSystemActive"`
Expected: FAIL (`scheduler.isSystemActive is not a function`).

- [ ] **Step 3: Implement lazy loading loop and activity helpers in AccountScheduler.js**

In `src/concurrent/AccountScheduler.js`:
```javascript
isSystemActive() {
    return Date.now() - this.lastSystemActivityAt < this.idleTimeoutMs;
}

startActivationLoop(intervalMs = 30000) {
    if (this._activationTimer) return;
    this._activationTimer = setInterval(async () => {
        if (!this.isSystemActive()) {
            if (this.logger && typeof this.logger.debug === "function") {
                this.logger.debug("[AccountScheduler] System is idle, skipping background account activation");
            }
            return;
        }

        const indices = this._getAccountIndices();
        for (const idx of indices) {
            if (this._hasConnection(idx) && this.getAccountStatus(idx) === "INACTIVE") {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(`[AccountScheduler] Lazy loading activation loop activating authIndex #${idx}...`);
                }
                await this.activateAccount(idx);
                // Pause slightly between context switches to allow page stabilization
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }, intervalMs);
}

stopActivationLoop() {
    if (this._activationTimer) {
        clearInterval(this._activationTimer);
        this._activationTimer = null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): implement lazy loading activation loop and idle timeout policy

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Full Suite & Integration Verification

**Files:**
- Modify/Verify: `src/concurrent/*`, `test/concurrent/*`

- [ ] **Step 1: Run all concurrent tests**

Run: `npx jest test/concurrent/`
Expected: ALL PASS

- [ ] **Step 2: Run linter on JS files**

Run: `npm run lint:js`
Expected: PASS (0 errors)

- [ ] **Step 3: Commit formatting or lint cleanups**

```bash
git add .
git commit -m "chore(concurrent): complete AccountScheduler activation and lazy loading implementation

Co-Authored-By: Claude <noreply@anthropic.com>"
```
