# Google Cloud Shell 拟人防检测与多 Context 轮询保活实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Google Cloud Shell 自动化工具增加拟人化鼠标移动防检测机制，支持多账号并发拉起与独立 BrowserContext 管理，并实现定时自动轮换活跃上下文（Active Context）与全生命周期防休眠长驻。

**Architecture:** 单例 Playwright Firefox 实例内管理多个 `BrowserContext`（`CloudShellManager`），支持 `--auth 0,1,2`、`--auth 0-3` 与 `--all` 发现模式；彻底移除 `--cmd` 与 `--file` 参数；复刻原项目 `BrowserManager.js` 的 3 段带抖动平滑鼠标移动算法（`_simulateHumanMovement`）与双层防休眠守护（活跃上下文高频微滚动+鼠标微抖动+左上角防超时移动，后台上下文周期性心跳与弹窗旁路），并按 `--switch-interval` 自动轮流切换 active context。

**Tech Stack:** Node.js, Playwright (Firefox / Camoufox), Jest.

## Global Constraints

- 移除 `--cmd` 与 `--file` 命令行参数及代码逻辑。
- ��令行支持 `--auth <indices>`（单数字、逗号分隔、短横线范围）、`--all`（自动扫描 `configs/auth/auth-N.json`）、`--switch-interval <min>`（默认 10 分钟）、`--keep-alive <min>`（默认 -1 无限长驻）。
- 拟人鼠标移动算法严格采用原项目 3 段微抖动与平滑步进设计。
- 保持所有代码风格符合项目 ESLint 和 Prettier 规范。

---

### Task 1: 升级命令行参数解析器 (CLI Options Refactor)

**Files:**

- Modify: `scripts/cloudshell/options.js`
- Test: `test/cloudshell/options.test.js`

**Interfaces:**

- Consumes: process argv array
- Produces: `parseCliArgs(args)` returning `{ authIndices: number[], all: boolean, switchIntervalMinutes: number, keepAliveMinutes: number, heartbeatIntervalSeconds: number, headless: boolean, proxy: string|null, debug: boolean, help: boolean }`

- [x] **Step 1: 编写失败的单元测试**

在 `test/cloudshell/options.test.js` 中新增/修改针对移除 `--cmd`/`--file`、支持 `--auth 0,1,2`、`--auth 0-2`、`--all` 以及 `--switch-interval` 的测试用例：

```javascript
test("parses multi-auth indices and ranges correctly", () => {
  expect(parseCliArgs(["--auth", "0,1,2"]).authIndices).toEqual([0, 1, 2]);
  expect(parseCliArgs(["--auth", "0-3"]).authIndices).toEqual([0, 1, 2, 3]);
  expect(parseCliArgs(["--auth=1,3"]).authIndices).toEqual([1, 3]);
  expect(parseCliArgs(["--all"]).all).toBe(true);
});

test("defaults keepAliveMinutes to -1 and switchIntervalMinutes to 10", () => {
  const opts = parseCliArgs([]);
  expect(opts.keepAliveMinutes).toBe(-1);
  expect(opts.switchIntervalMinutes).toBe(10);
  expect(opts.authIndices).toEqual([0]);
});

test("parses custom switch-interval", () => {
  expect(parseCliArgs(["--switch-interval", "15"]).switchIntervalMinutes).toBe(15);
  expect(parseCliArgs(["--switch-interval=5"]).switchIntervalMinutes).toBe(5);
  expect(() => parseCliArgs(["--switch-interval", "-1"])).toThrow(/switch-interval/i);
});

test("throws error when cmd or file is provided with helpful deprecation message", () => {
  expect(() => parseCliArgs(["--cmd", "echo 1"])).toThrow(/--cmd is deprecated and no longer supported/i);
  expect(() => parseCliArgs(["--file", "script.sh"])).toThrow(/--file is deprecated and no longer supported/i);
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/options.test.js`
Expected: FAIL (因为 `options.js` 尚不支持新的多账号解析与弃用拦截)

- [x] **Step 3: 实现 `scripts/cloudshell/options.js` 解析逻辑**

实现多账号解析辅助函数 `parseAuthIndices(raw)`，支持短横线与逗号分隔，去重并排序；对 `--cmd` 和 `--file` 抛出废弃提示；添加 `--all` 与 `--switch-interval`；将默认 `keepAliveMinutes` 设为 `-1`。更新 `printHelp()` 函数的文档输出。

- [x] **Step 4: 重新运行测试以确认全部通过**

Run: `npx jest test/cloudshell/options.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/options.js test/cloudshell/options.test.js
git commit -m "feat(cloudshell): refactor CLI options for multi-auth and deprecate cmd/file"
```

---

### Task 2: 升级 `CloudShellController` 拟人鼠标移动防检测能力

**Files:**

- Modify: `scripts/cloudshell/CloudShellController.js`
- Test: `test/cloudshell/cloudshell_controller_mouse.test.js`
- Modify: `test/cloudshell/cloudshell_controller_terminal.test.js`

**Interfaces:**

- Consumes: Playwright Page instance (`page.mouse`, `page.viewportSize`, `page.evaluate`)
- Produces:
  - `controller.simulateHumanMovement(targetX, targetY)`
  - `controller.performActiveMicroActions(tickCount)`
  - `controller.waitForTerminalReady(timeoutMs)` (内置 30% 概率拟人移动)
  - 移除已废弃的 `executeCommand` 和 `executeCommands` 方法

- [x] **Step 1: 编写针对拟人鼠标算法与微操作的测试**

创建 `test/cloudshell/cloudshell_controller_mouse.test.js`：

```javascript
/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Anti-Detection Mouse Movement", () => {
  test("simulateHumanMovement splits path into 3 segments with smooth step moves", async () => {
    const moves = [];
    const mockPage = {
      isClosed: () => false,
      mouse: {
        move: async (x, y, options) => {
          moves.push({ options, x, y });
        },
      },
    };
    const controller = new CloudShellController(mockPage);
    await controller.simulateHumanMovement(500, 300);

    expect(moves.length).toBe(3);
    // The last segment must hit exact destination
    expect(moves[2].x).toBe(500);
    expect(moves[2].y).toBe(300);
    expect(moves[2].options.steps).toBeGreaterThanOrEqual(5);
  });

  test("performActiveMicroActions executes corner reset every 15 ticks", async () => {
    const moves = [];
    const mockPage = {
      evaluate: async () => {},
      isClosed: () => false,
      mouse: {
        move: async (x, y) => moves.push({ x, y }),
      },
      viewportSize: () => ({ height: 1080, width: 1920 }),
    };
    const controller = new CloudShellController(mockPage);
    await controller.performActiveMicroActions(15);

    // tick 15 triggers corner reset to (1, 1)
    expect(moves.some(m => m.x === 1 && m.y === 1)).toBe(true);
  });
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/cloudshell_controller_mouse.test.js`
Expected: FAIL (`simulateHumanMovement` is not a function)

- [x] **Step 3: 在 `CloudShellController.js` 中实现拟人防检测算法与移除废弃方法**

1. 将原项目中的 3 段带抖动算法引入并封装为 `async simulateHumanMovement(targetX, targetY)`；
2. 实现 `async performActiveMicroActions(tickCount)`：
   - 30% 概率触发视口微滚动（`window.scrollBy(0, (Math.random() - 0.5) * 20)`）加随机坐标平滑拟人移动；
   - 每 15 个 tick��约 60 秒）平滑移动至 `(1, 1)`；
3. 在 `waitForTerminalReady` 循环内加入 30% 概率随机拟人移动；
4. 移除 `executeCommand` 和 `executeCommands` 方法，更新 `test/cloudshell/cloudshell_controller_terminal.test.js`。

- [x] **Step 4: 运行相关测试以确认全部通过**

Run: `npx jest test/cloudshell/cloudshell_controller_mouse.test.js test/cloudshell/cloudshell_controller_terminal.test.js test/cloudshell/cloudshell_controller_heartbeat.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellController.js test/cloudshell/
git commit -m "feat(cloudshell): implement human-like mouse movement and active micro-actions anti-detection"
```

---

### Task 3: 实现 `CloudShellManager` 多 Context 与轮换保活管理器

**Files:**

- Create: `scripts/cloudshell/CloudShellManager.js`
- Test: `test/cloudshell/cloudshell_manager.test.js`

**Interfaces:**

- Consumes: Playwright Browser instance from `browserSetup.js`, options from `options.js`
- Produces:
  - `class CloudShellManager`
  - `manager.init()`: 并发/依次为所有账号创建 context，初始化并导航页面，等待终端就绪
  - `manager.switchActiveContext(targetAuthIndex)`: 切换当前选中的 context 并调用 `bringToFront()`
  - `manager.startRotationAndKeepAliveLoop()`: 启动长驻保活与定时轮换循环
  - `manager.stop()`: 安全停止循环并释放所有 context 资源

- [x] **Step 1: 编写 `CloudShellManager` 的单元测试**

创建 `test/cloudshell/cloudshell_manager.test.js`：测试多 context 初始化、active context 初始设定、定时轮换触发以及 graceful shutdown：

```javascript
/* eslint-env jest */
const { CloudShellManager } = require("../../scripts/cloudshell/CloudShellManager");

describe("CloudShellManager Multi-Context Lifecycle", () => {
  test("initializes contexts and sets first account as active", async () => {
    const mockPage0 = {
      bringToFront: jest.fn().mockResolvedValue(),
      isClosed: () => false,
      mouse: { move: jest.fn().mockResolvedValue() },
      viewportSize: () => ({ height: 1080, width: 1920 }),
    };
    const mockContext0 = { newPage: jest.fn().mockResolvedValue(mockPage0) };

    const mockBrowser = {
      newContext: jest.fn().mockResolvedValue(mockContext0),
    };

    const manager = new CloudShellManager(mockBrowser, {
      authIndices: [0, 1],
      keepAliveMinutes: 0,
      switchIntervalMinutes: 10,
    });

    expect(manager.authIndices).toEqual([0, 1]);
    expect(manager.currentAuthIndex).toBe(0);
  });

  test("rotates active context correctly on switch interval", async () => {
    const manager = new CloudShellManager(null, {
      authIndices: [0, 1, 2],
      switchIntervalMinutes: 10,
    });
    manager.currentAuthIndex = 0;

    const next1 = manager.getNextAuthIndex();
    expect(next1).toBe(1);
    manager.currentAuthIndex = 1;

    const next2 = manager.getNextAuthIndex();
    expect(next2).toBe(2);
    manager.currentAuthIndex = 2;

    const next3 = manager.getNextAuthIndex();
    expect(next3).toBe(0);
  });
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: FAIL (`CloudShellManager.js` not found)

- [x] **Step 3: 编写 `CloudShellManager.js` 完整实现**

1. 管理单例 `browser` 与 `contexts: Map<authIndex, { context, page, controller }>`；
2. 实现 `discoverAvailableAuthIndices()`，在用户传入 `--all` 时扫描 `configs/auth/auth-N.json`；
3. 实现 `init()` 逐个账号拉起并调用 `controller.waitForTerminalReady()`；
4. 实现 `switchActiveContext(targetAuthIndex)`：调用目标 `page.bringToFront()`，并进行一次拟人唤醒；
5. 实现长驻保活与防休眠循环：
   - 每 4 秒跑一次 micro-actions tick，调用活跃账号的 `performActiveMicroActions`；
   - 每隔 `heartbeatIntervalSeconds` 给所有存活 context 下发 `sendHeartbeat()` 与 `bypassModalsOnce()`；
   - 当多个账号存在且达到 `switchIntervalMinutes` 时，触发 `rotateActiveContext()`；
6. 实现 `stop()` 清理所有定时器与 context 资源。

- [x] **Step 4: 运行测试以确认全部通过**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellManager.js test/cloudshell/cloudshell_manager.test.js
git commit -m "feat(cloudshell): implement CloudShellManager for multi-context rotation and keep-alive"
```

---

### Task 4: 更新入口 `runCloudShell.js` 与 `browserSetup.js`

**Files:**

- Modify: `scripts/cloudshell/runCloudShell.js`
- Modify: `scripts/cloudshell/browserSetup.js`
- Test: `test/cloudshell/run_cloudshell.test.js`

**Interfaces:**

- CLI entrypoint integrating `options.js`, `browserSetup.js`, and `CloudShellManager.js`

- [x] **Step 1: 更新入口端到端测试**

在 `test/cloudshell/run_cloudshell.test.js` 中更新测试断言：

- 验证 `--help` 输出不再包含 `--cmd` 或 `--file`，而是显示 `--auth <indices>`、`--all`、`--switch-interval`；
- 验证 `--cmd` 报错拦截。

- [x] **Step 2: 运行测试确认失败**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: FAIL

- [x] **Step 3: 调整 `runCloudShell.js` 与 `browserSetup.js`**

1. 在 `browserSetup.js` 中导出通用的 `createBrowserContext(browser, authIndex, proxyConfig)` 函数，方便 `CloudShellManager` 为每个账号创建独立 context 并注入对应的 storageState 和 anti-fingerprint script；
2. 重构 `runCloudShell.js`：
   - 移除所有 `--cmd` / `--file` 处理逻辑；
   - 实例化 `CloudShellManager` 并调用 `manager.init()`；
   - 启动 `manager.startRotationAndKeepAliveLoop()`；
   - 在 `SIGINT` 和 `SIGTERM` 中调用 `manager.stop()`。

- [x] **Step 4: 运行全套测试确认通过**

Run: `npx jest test/cloudshell/`
Expected: PASS (所有 7 个测试套件全绿)

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/runCloudShell.js scripts/cloudshell/browserSetup.js test/cloudshell/run_cloudshell.test.js
git commit -m "feat(cloudshell): wire up CLI entrypoint to CloudShellManager multi-context runner"
```

---

### Task 5: 文档更新与代码质量验收 (Docs & Lint)

**Files:**

- Modify: `scripts/cloudshell/README.md`

- [x] **Step 1: 更新 `scripts/cloudshell/README.md`**

更新功能特性说明、命令行参数表格、多账号切换/并发长驻使用场景，彻底删除已废弃的 `--cmd` 和 `--file` 执行命令章节。

- [x] **Step 2: 执行代码格式化与 Lint 检查**

Run: `npm run format && npm run lint:fix`
Expected: 无语法与规范报错，自动格式化整洁。

- [x] **Step 3: 运行全套 Cloud Shell 自动化测试**

Run: `npx jest test/cloudshell/`
Expected: 所有测试 100% 通过。

- [x] **Step 4: 提交更改**

```bash
git add scripts/cloudshell/README.md
git commit -m "docs(cloudshell): update documentation for anti-detection and multi-context rotation"
```
