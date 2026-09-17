# 账号启动序号持久化与记忆续跑实施计划 (Persist Auth Index on Restart)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现服务重启后自动接续上次激活/切换的账号序号，并在上次账号被删除或失效时自动顺延至下一个可用账号。

**Architecture:** 
- 创建独立状态追踪模块 `src/core/AuthStateTracker.js` 统一管理 `data/auth-state.json`，实现安全读写与启动序号判定决策算法；
- 在 `BrowserManager._activateContext` 中注入 `AuthStateTracker`，实现所有模式（普通单账号轮换、恢复切换、多账号并发调度）激活账号时的即时原子落盘；
- 在 `ProxyServerSystem.start` 启动链路中接入 `AuthStateTracker.resolveStartupIndex`，完成“上次记录有效 -> 顺延下一个 -> 环境变量 -> 首位”的启动顺序重排。

**Tech Stack:** Node.js (CommonJS), Jest, fs/fs.promises, Playwright proxy server system.

## Global Constraints

- 持久化文件存储在 `data/auth-state.json`，结构为 `{ "lastActiveAuthIndex": number, "updatedAt": string }`。
- 读写过程必须包裹完整 `try-catch` 容错，文件丢失或损坏时安全降级，绝不阻断系统启动与运行。
- 自动创建不存在的 `data/` 目录；落盘采用原子写入（写临时文件再 rename）或安全同步写入。
- 遵循现有的 ESLint 和 Prettier 规范。

---

### Task 1: 实现并单测 `src/core/AuthStateTracker.js` 的读写与顺延决策逻辑

**Files:**
- Create: `src/core/AuthStateTracker.js`
- Test: `test/core/auth_state_tracker.test.js`

**Interfaces:**
- Consumes: `fs`, `path`, `logger`
- Produces:
  - `class AuthStateTracker`:
    - `constructor(logger, filePath = null)`
    - `getLastAuthIndex(): number | null`
    - `saveLastAuthIndex(authIndex: number): boolean`
    - `resolveStartupIndex({ availableIndices: number[], rotationIndices: number[], canonicalIndexGetter: (idx: number) => number | null, envInitialIndex?: number | null }): { chosenIndex: number, startupOrder: number[], source: "persisted" | "persisted_fallback" | "env" | "default" }`

- [x] **Step 1: 编写失败的单元测试 `test/core/auth_state_tracker.test.js`**

```javascript
/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const AuthStateTracker = require("../../src/core/AuthStateTracker");

describe("AuthStateTracker", () => {
    const testDataDir = path.join(process.cwd(), "tmp_test_auth_state_data");
    const testStateFile = path.join(testDataDir, "auth-state.json");
    let tracker = null;

    beforeEach(() => {
        if (!fs.existsSync(testDataDir)) {
            fs.mkdirSync(testDataDir, { recursive: true });
        }
        if (fs.existsSync(testStateFile)) {
            fs.unlinkSync(testStateFile);
        }
        tracker = new AuthStateTracker(null, testStateFile);
    });

    afterEach(() => {
        if (fs.existsSync(testStateFile)) {
            fs.unlinkSync(testStateFile);
        }
        if (fs.existsSync(testDataDir)) {
            fs.rmdirSync(testDataDir);
        }
    });

    test("returns null when state file does not exist", () => {
        expect(tracker.getLastAuthIndex()).toBeNull();
    });

    test("saves and loads lastActiveAuthIndex accurately", () => {
        const saved = tracker.saveLastAuthIndex(3);
        expect(saved).toBe(true);
        expect(tracker.getLastAuthIndex()).toBe(3);

        const content = JSON.parse(fs.readFileSync(testStateFile, "utf-8"));
        expect(content.lastActiveAuthIndex).toBe(3);
        expect(typeof content.updatedAt).toBe("string");
    });

    test("handles corrupted state file gracefully", () => {
        fs.writeFileSync(testStateFile, "invalid-json-content{");
        expect(tracker.getLastAuthIndex()).toBeNull();
    });

    describe("resolveStartupIndex", () => {
        const rotationIndices = [0, 2, 4];
        const availableIndices = [0, 1, 2, 4];
        const canonicalIndexGetter = idx => (idx === 1 ? 2 : idx);

        test("uses persisted index directly when present in rotationIndices", () => {
            tracker.saveLastAuthIndex(2);
            const result = tracker.resolveStartupIndex({
                availableIndices,
                rotationIndices,
                canonicalIndexGetter,
                envInitialIndex: 0,
            });
            expect(result.chosenIndex).toBe(2);
            expect(result.startupOrder).toEqual([2, 0, 4]);
            expect(result.source).toBe("persisted");
        });

        test("resolves duplicate account to canonical index", () => {
            tracker.saveLastAuthIndex(1); // 1 maps to 2
            const result = tracker.resolveStartupIndex({
                availableIndices,
                rotationIndices,
                canonicalIndexGetter,
                envInitialIndex: 0,
            });
            expect(result.chosenIndex).toBe(2);
            expect(result.startupOrder).toEqual([2, 0, 4]);
            expect(result.source).toBe("persisted");
        });

        test("advances to next available index when persisted index was removed (fallback)", () => {
            tracker.saveLastAuthIndex(3); // 3 not in [0, 2, 4], next is 4
            const result = tracker.resolveStartupIndex({
                availableIndices,
                rotationIndices,
                canonicalIndexGetter,
                envInitialIndex: 0,
            });
            expect(result.chosenIndex).toBe(4);
            expect(result.startupOrder).toEqual([4, 0, 2]);
            expect(result.source).toBe("persisted_fallback");
        });

        test("wraps around to first index when persisted index exceeds max index", () => {
            tracker.saveLastAuthIndex(5); // 5 not in [0, 2, 4], exceeds max -> wrap around to 0
            const result = tracker.resolveStartupIndex({
                availableIndices,
                rotationIndices,
                canonicalIndexGetter,
                envInitialIndex: 2,
            });
            expect(result.chosenIndex).toBe(0);
            expect(result.startupOrder).toEqual([0, 2, 4]);
            expect(result.source).toBe("persisted_fallback");
        });

        test("falls back to envInitialIndex when no persisted index exists", () => {
            const result = tracker.resolveStartupIndex({
                availableIndices,
                rotationIndices,
                canonicalIndexGetter,
                envInitialIndex: 4,
            });
            expect(result.chosenIndex).toBe(4);
            expect(result.startupOrder).toEqual([4, 0, 2]);
            expect(result.source).toBe("env");
        });

        test("falls back to first index when no persisted index and invalid envInitialIndex", () => {
            const result = tracker.resolveStartupIndex({
                availableIndices,
                rotationIndices,
                canonicalIndexGetter,
                envInitialIndex: 99,
            });
            expect(result.chosenIndex).toBe(0);
            expect(result.startupOrder).toEqual([0, 2, 4]);
            expect(result.source).toBe("default");
        });
    });
});
```

- [x] **Step 2: 运行测试并确认失败**

运行: `npx jest test/core/auth_state_tracker.test.js`
预期: 失败（`Cannot find module '../../src/core/AuthStateTracker'`）

- [x] **Step 3: 实现 `src/core/AuthStateTracker.js`**

```javascript
/**
 * File: src/core/AuthStateTracker.js
 * Description: Persists and resolves active auth index state across server restarts
 */

const fs = require("fs");
const path = require("path");

class AuthStateTracker {
    /**
     * @param {Object} [logger] - Logger instance
     * @param {string} [filePath] - Custom JSON file path for testing
     */
    constructor(logger = console, filePath = null) {
        this.logger = logger;
        this.filePath = filePath || path.join(process.cwd(), "data", "auth-state.json");
    }

    /**
     * Get the last recorded active auth index
     * @returns {number|null}
     */
    getLastAuthIndex() {
        try {
            if (!fs.existsSync(this.filePath)) {
                return null;
            }
            const rawContent = fs.readFileSync(this.filePath, "utf-8");
            const data = JSON.parse(rawContent);
            if (data && Number.isInteger(data.lastActiveAuthIndex) && data.lastActiveAuthIndex >= 0) {
                return data.lastActiveAuthIndex;
            }
            return null;
        } catch (error) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AuthStateTracker] Failed to read auth state from ${this.filePath}: ${error.message}`);
            }
            return null;
        }
    }

    /**
     * Save active auth index to persistent file
     * @param {number} authIndex
     * @returns {boolean}
     */
    saveLastAuthIndex(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) {
            return false;
        }
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = {
                lastActiveAuthIndex: authIndex,
                updatedAt: new Date().toISOString(),
            };
            const tempFile = `${this.filePath}.tmp.${Date.now()}`;
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), "utf-8");
            fs.renameSync(tempFile, this.filePath);
            return true;
        } catch (error) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[AuthStateTracker] Failed to save auth state to ${this.filePath}: ${error.message}`);
            }
            return false;
        }
    }

    /**
     * Resolve startup index and order based on persisted index, envInitialIndex, and available accounts
     * @param {Object} params
     * @param {number[]} params.availableIndices
     * @param {number[]} params.rotationIndices
     * @param {Function} [params.canonicalIndexGetter]
     * @param {number|null} [params.envInitialIndex]
     * @returns {{ chosenIndex: number, startupOrder: number[], source: "persisted" | "persisted_fallback" | "env" | "default" }}
     */
    resolveStartupIndex({
        availableIndices = [],
        rotationIndices = [],
        canonicalIndexGetter = idx => idx,
        envInitialIndex = null,
    }) {
        const pool = rotationIndices.length > 0 ? [...rotationIndices] : [...availableIndices];
        if (pool.length === 0) {
            return { chosenIndex: null, startupOrder: [], source: "default" };
        }

        const sortedPool = [...pool].sort((a, b) => a - b);
        const persisted = this.getLastAuthIndex();

        // 1. Try persisted index
        if (persisted !== null) {
            const canonicalPersisted = typeof canonicalIndexGetter === "function" ? canonicalIndexGetter(persisted) : persisted;
            const targetPersisted = canonicalPersisted !== null ? canonicalPersisted : persisted;

            if (pool.includes(targetPersisted)) {
                const startupOrder = [targetPersisted, ...pool.filter(i => i !== targetPersisted)];
                return { chosenIndex: targetPersisted, startupOrder, source: "persisted" };
            }

            // Persisted account unavailable -> Fallback to next available in rotation pool
            const nextCandidate = sortedPool.find(idx => idx > persisted);
            const chosenIndex = nextCandidate !== undefined ? nextCandidate : sortedPool[0];
            const startupOrder = [chosenIndex, ...pool.filter(i => i !== chosenIndex)];
            return { chosenIndex, startupOrder, source: "persisted_fallback" };
        }

        // 2. Try envInitialIndex
        if (Number.isInteger(envInitialIndex)) {
            const canonicalEnv = typeof canonicalIndexGetter === "function" ? canonicalIndexGetter(envInitialIndex) : envInitialIndex;
            const targetEnv = canonicalEnv !== null ? canonicalEnv : envInitialIndex;

            if (pool.includes(targetEnv)) {
                const startupOrder = [targetEnv, ...pool.filter(i => i !== targetEnv)];
                return { chosenIndex: targetEnv, startupOrder, source: "env" };
            }
        }

        // 3. Default to first in pool
        const chosenIndex = pool[0];
        const startupOrder = [...pool];
        return { chosenIndex, startupOrder, source: "default" };
    }
}

module.exports = AuthStateTracker;
```

- [x] **Step 4: 运行测试并确认全部通过**

运行: `npx jest test/core/auth_state_tracker.test.js`
预期: PASS

- [x] **Step 5: 提交任务 1 代码**

```bash
git add src/core/AuthStateTracker.js test/core/auth_state_tracker.test.js
git commit -m "feat(auth): implement AuthStateTracker with persistence and fallback logic"
```

---

### Task 2: 在 `BrowserManager` 中接入 `AuthStateTracker` 实��激活实时落盘

**Files:**
- Modify: `src/core/BrowserManager.js`
- Test: `test/core/browser_manager_auth_state.test.js`

**Interfaces:**
- Consumes: `AuthStateTracker` instance via `setAuthStateTracker(tracker)`
- Produces: `_activateContext(ctx, pg, authIndex)` triggers `this.authStateTracker?.saveLastAuthIndex(authIndex)`

- [x] **Step 1: 编写单元测试验证 `BrowserManager` 调用 `saveLastAuthIndex`**

```javascript
/* eslint-env jest */
const BrowserManager = require("../../src/core/BrowserManager");

describe("BrowserManager AuthStateTracker integration", () => {
    test("calls saveLastAuthIndex when _activateContext is executed", () => {
        const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const mockConfig = { maxContexts: 1 };
        const mockAuthSource = { availableIndices: [0, 1], getRotationIndices: () => [0, 1] };
        const manager = new BrowserManager(mockLogger, mockConfig, mockAuthSource);

        const mockTracker = { saveLastAuthIndex: jest.fn() };
        manager.setAuthStateTracker(mockTracker);

        const mockContext = {};
        const mockPage = { isClosed: () => false };

        // Stub internal helper methods that interact with browser
        manager._startHealthMonitor = jest.fn();
        manager._startBackgroundWakeup = jest.fn();
        manager._sendActiveTrigger = jest.fn();

        manager._activateContext(mockContext, mockPage, 2);

        expect(manager.currentAuthIndex).toBe(2);
        expect(mockTracker.saveLastAuthIndex).toHaveBeenCalledWith(2);
    });
});
```

- [x] **Step 2: 运行测试确认失败**

运行: `npx jest test/core/browser_manager_auth_state.test.js`
预期: FAIL (`manager.setAuthStateTracker is not a function`)

- [x] **Step 3: 在 `src/core/BrowserManager.js` 中添加 `setAuthStateTracker` 并在 `_activateContext` 中调用**

修改 `src/core/BrowserManager.js`:
- 在构造函数中初始化 `this.authStateTracker = null;`
- 添加方法：
  ```javascript
  setAuthStateTracker(tracker) {
      this.authStateTracker = tracker;
  }
  ```
- 在 `_activateContext(ctx, pg, authIndex)` 末尾添加：
  ```javascript
  if (this.authStateTracker && typeof this.authStateTracker.saveLastAuthIndex === "function") {
      try {
          this.authStateTracker.saveLastAuthIndex(authIndex);
      } catch (err) {
          this.logger.warn(`[Browser] Failed to persist auth state for account #${authIndex}: ${err.message}`);
      }
  }
  ```

- [x] **Step 4: 运行测试确认通过**

运行: `npx jest test/core/browser_manager_auth_state.test.js`
预期: PASS

- [x] **Step 5: 提交任务 2 代码**

```bash
git add src/core/BrowserManager.js test/core/browser_manager_auth_state.test.js
git commit -m "feat(browser): save active auth index via AuthStateTracker in _activateContext"
```

---

### Task 3: 在 `ProxyServerSystem` 中接入 `AuthStateTracker` 并执行启动序号重排

**Files:**
- Modify: `src/core/ProxyServerSystem.js`
- Test: `test/core/proxy_server_system_startup_auth.test.js`

**Interfaces:**
- Consumes: `AuthStateTracker`, `AuthSource`, `BrowserManager`
- Produces: `ProxyServerSystem.start(initialAuthIndex)` resolves startup order from `AuthStateTracker.resolveStartupIndex` and logs startup source.

- [x] **Step 1: 编写单元测试验证 `ProxyServerSystem` 启动序号决策与日志**

```javascript
/* eslint-env jest */
const ProxyServerSystem = require("../../src/core/ProxyServerSystem");

describe("ProxyServerSystem startup auth index resolution", () => {
    test("initializes authStateTracker and attaches it to browserManager", () => {
        const system = new ProxyServerSystem();
        expect(system.authStateTracker).toBeDefined();
        expect(system.browserManager.authStateTracker).toBe(system.authStateTracker);
    });

    test("resolves startup order using authStateTracker", async () => {
        const system = new ProxyServerSystem();
        // Stub servers and browser operations
        system._startHttpServer = jest.fn().mockResolvedValue();
        system._startWebSocketServer = jest.fn().mockResolvedValue();
        system.authSource.availableIndices = [0, 1, 2];
        system.authSource.getRotationIndices = () => [0, 1, 2];
        system.authSource.getCanonicalIndex = idx => idx;

        // Mock preload and switch
        system.browserManager.preloadContextPool = jest.fn().mockResolvedValue({ firstReady: 2 });
        system.browserManager.launchOrSwitchContext = jest.fn().mockResolvedValue();

        // Mock tracker to simulate having persisted index #2
        jest.spyOn(system.authStateTracker, "getLastAuthIndex").mockReturnValue(2);

        await system.start(0); // Pass env initial index 0, but persisted 2 should take precedence

        expect(system.browserManager.preloadContextPool).toHaveBeenCalledWith([2, 0, 1], expect.any(Number));
        expect(system.browserManager.launchOrSwitchContext).toHaveBeenCalledWith(2);
    });
});
```

- [x] **Step 2: 运行测试确认失败**

运行: `npx jest test/core/proxy_server_system_startup_auth.test.js`
预期: FAIL (`system.authStateTracker is not defined`)

- [x] **Step 3: 修改 `src/core/ProxyServerSystem.js`**

1. 引入 `AuthStateTracker`：
   ```javascript
   const AuthStateTracker = require("./AuthStateTracker");
   ```
2. 在构造函数中初始化并注入：
   ```javascript
   this.authStateTracker = new AuthStateTracker(this.logger);
   this.browserManager.setAuthStateTracker(this.authStateTracker);
   ```
3. 重构 `start(initialAuthIndex = null)` 中的 startupOrder 计算：
   使用 `this.authStateTracker.resolveStartupIndex(...)`：
   ```javascript
   const { chosenIndex, startupOrder, source } = this.authStateTracker.resolveStartupIndex({
       availableIndices: allAvailableIndices,
       rotationIndices: allRotationIndices,
       canonicalIndexGetter: idx => this.authSource.getCanonicalIndex(idx),
       envInitialIndex: initialAuthIndex,
   });

   if (source === "persisted") {
       this.logger.info(`[System] 🔄 Resuming from last active auth index #${chosenIndex}.`);
   } else if (source === "persisted_fallback") {
       this.logger.warn(`[System] ⚠️ Last active auth index unavailable, falling back to next available index #${chosenIndex}.`);
   } else if (source === "env") {
       this.logger.info(`[System] Detected specified startup index #${chosenIndex}, will try it first.`);
   } else {
       this.logger.info(`[System] No valid startup index specified or persisted, activating first available context #${chosenIndex}.`);
   }
   ```

- [x] **Step 4: 运行测试确认通过**

运行: `npx jest test/core/proxy_server_system_startup_auth.test.js`
预期: PASS

- [x] **Step 5: 提交任务 3 代码**

```bash
git add src/core/ProxyServerSystem.js test/core/proxy_server_system_startup_auth.test.js
git commit -m "feat(system): wire AuthStateTracker into ProxyServerSystem startup sequence"
```

---

### Task 4: 端到端集成验证与代码规范清理

**Files:**
- Test: 全量单元测试 `npm test`
- Code quality: `npm run lint:js` & `npm run format:check`

- [x] **Step 1: 运行所有单元测试**

运行: `npx jest`
预期: 所有单元测试套件全部通过 (All test suites pass)

- [x] **Step 2: 运行代码规范检查与格式检查**

运行: `npm run lint:js`
运行: `npm run format:check`
预期: 无 ESLint 错误，无 Prettier 格式差异

- [x] **Step 3: 清理临时测试用例或保留回归测试，提交最终代码**

```bash
git add test/
git commit -m "test(auth): add unit test suites for auth state tracking and persistence"
```
