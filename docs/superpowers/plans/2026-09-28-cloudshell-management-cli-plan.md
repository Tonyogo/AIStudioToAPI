# Google Cloud Shell 管理命令（CLI / Daemon）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Google Cloud Shell 自动化工具改造成支持 `start`、`status`、`stop`、`restart` 和 `logs` 的完整管理命令（Management CLI），支持后台守护进程（Daemon）脱离运行与状态持久化查询。

**Architecture:** 通过 `options.js` 统一解析子命令与参数；新增 `stateTracker.js` 负责原子化维护 `logs/cloudshell/state.json` 运行时状态与终端格式化渲染；新增 `daemonManager.js` 负责 `logs/cloudshell/daemon.pid` 生命周期、Node.js detached 子进程派生与跨平台信号停止；在 `CloudShellManager.js` 中接入实时状态上报，并在 `runCloudShell.js` 中完成各子命令调度。

**Tech Stack:** Node.js (`child_process`, `fs`, `path`), Playwright (Firefox / Camoufox), Jest.

## Global Constraints

- 支持一级子命令：`start`、`status`、`stop`、`restart`、`logs`。若未传子命令，默认执行 `status` 并打印可用帮助。
- `start` 默认以守护进程（Daemon）在后台运行，日志输出至 `logs/cloudshell/daemon.log`，PID 写入 `logs/cloudshell/daemon.pid`；若传入 `--foreground` 或 `--headed` 则在前台阻塞运行。
- `status` 命令根据 PID 与 `logs/cloudshell/state.json` 展示实时信息，进程失效时自动识别并标记为 `Stopped`。
- `stop` 命令向目标 PID 发送 `SIGTERM` 并在 10 秒超时后回退至 `SIGKILL`，确保 Playwright 资源释放完毕。
- 所有代码必须符合 ESLint 和 Prettier 规范。

---

### Task 1: 升级命令行参数与子命令解析器 (`options.js`)

**Files:**
- Modify: `scripts/cloudshell/options.js`
- Modify: `test/cloudshell/options.test.js`

**Interfaces:**
- Consumes: `process.argv.slice(2)`
- Produces: `parseCliArgs(args)` returning `{ command: string, authIndices: number[], all: boolean, foreground: boolean, force: boolean, follow: boolean, switchIntervalMinutes: number, keepAliveMinutes: number, heartbeatIntervalSeconds: number, headless: boolean, proxy: string|null, debug: boolean, help: boolean }`

- [x] **Step 1: 编写子命令解析失败测试**

在 `test/cloudshell/options.test.js` 中新增子命令与新参数的测试：

```javascript
test("parses subcommands start, stop, status, restart, logs correctly", () => {
    expect(parseCliArgs(["start", "--auth", "0,1"]).command).toBe("start");
    expect(parseCliArgs(["stop"]).command).toBe("stop");
    expect(parseCliArgs(["status"]).command).toBe("status");
    expect(parseCliArgs(["restart", "--all"]).command).toBe("restart");
    expect(parseCliArgs(["logs", "-f"]).command).toBe("logs");
});

test("defaults command to status when no subcommand provided", () => {
    const opts = parseCliArgs([]);
    expect(opts.command).toBe("status");
});

test("parses --foreground, --force, --follow flags", () => {
    expect(parseCliArgs(["start", "--foreground"]).foreground).toBe(true);
    expect(parseCliArgs(["start", "-f"]).foreground).toBe(true);
    expect(parseCliArgs(["stop", "--force"]).force).toBe(true);
    expect(parseCliArgs(["logs", "--follow"]).follow).toBe(true);
    expect(parseCliArgs(["logs", "-f"]).follow).toBe(true);
});

test("enables foreground automatically when --headed is passed to start", () => {
    const opts = parseCliArgs(["start", "--headed"]);
    expect(opts.headless).toBe(false);
    expect(opts.foreground).toBe(true);
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/options.test.js`
Expected: FAIL (因为 `options.js` 尚不支持子命令 `command` 字段及 `--foreground` 等标志)

- [x] **Step 3: 实现 `options.js` 中的子命令解析逻辑**

1. 识别第一个非 option 参数作为 `command`（可选集合：`start`, `stop`, `status`, `restart`, `logs`）；若第一个参数以 `-` 开头或为空，且不是 `-h`/`--help`，则默认 `command = "status"`；
2. 识别 `--foreground` / `-f`（在 `logs` 下解析为 `follow`，在 `start` 下解析为 `foreground`）；
3. 识别 `--force`（用于 `stop`）；
4. 当指定 `--headed` 时，将 `foreground` 自动置为 `true`；
5. 更新 `printHelp()` 函数，展示子命令格式 `node scripts/cloudshell/runCloudShell.js <command> [options]`。

- [x] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/options.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/options.js test/cloudshell/options.test.js
git commit -m "feat(cloudshell): support subcommands and management flags in CLI options parser"
```

---

### Task 2: 实现状态持久化管理器 (`stateTracker.js`)

**Files:**
- Create: `scripts/cloudshell/stateTracker.js`
- Create: `test/cloudshell/state_tracker.test.js`

**Interfaces:**
- Produces:
  - `class StateTracker`:
    - `saveState(partialData)`: 将状态原子写入 `logs/cloudshell/state.json`
    - `loadState()`: 读取并解析 `logs/cloudshell/state.json`，若文件不存在或损坏返回 `null`
    - `clearState()`: 移除状态文件
    - `formatStatusOutput(state, isAlive)`: 格式化生成终端展示的 ASCII 表格与账号状态文本

- [x] **Step 1: 编写 `stateTracker` 单元测试**

创建 `test/cloudshell/state_tracker.test.js`：

```javascript
/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const { StateTracker } = require("../../scripts/cloudshell/stateTracker");

describe("CloudShell StateTracker", () => {
    const testStateDir = path.join(process.cwd(), "logs", "cloudshell_test_state");
    const testStateFile = path.join(testStateDir, "state.json");

    beforeEach(() => {
        if (fs.existsSync(testStateDir)) {
            fs.rmSync(testStateDir, { force: true, recursive: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(testStateDir)) {
            fs.rmSync(testStateDir, { force: true, recursive: true });
        }
    });

    test("saves and loads state atomically", () => {
        const tracker = new StateTracker(testStateFile);
        tracker.saveState({
            accounts: [{ authIndex: 0, status: "ready" }],
            currentAuthIndex: 0,
            pid: 1234,
            status: "running",
        });

        const loaded = tracker.loadState();
        expect(loaded).not.toBeNull();
        expect(loaded.pid).toBe(1234);
        expect(loaded.status).toBe("running");
        expect(loaded.accounts).toHaveLength(1);
    });

    test("formats status output correctly for stopped and running states", () => {
        const tracker = new StateTracker(testStateFile);
        const stoppedOutput = tracker.formatStatusOutput(null, false);
        expect(stoppedOutput).toContain("Stopped");

        const runningState = {
            accounts: [
                { accountName: "test@gmail.com", authIndex: 0, lastHeartbeatAt: new Date().toISOString(), status: "active" },
            ],
            currentAuthIndex: 0,
            pid: 9999,
            startedAt: new Date(Date.now() - 60000).toISOString(),
            status: "running",
            switchIntervalMinutes: 10,
        };
        const runningOutput = tracker.formatStatusOutput(runningState, true);
        expect(runningOutput).toContain("Running (PID: 9999)");
        expect(runningOutput).toContain("test@gmail.com");
        expect(runningOutput).toContain("Active");
    });
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/state_tracker.test.js`
Expected: FAIL (`stateTracker.js` not found)

- [x] **Step 3: 编写 `scripts/cloudshell/stateTracker.js`**

1. 实现 `StateTracker` 类，默认状态文件路径指向 `path.join(process.cwd(), "logs", "cloudshell", "state.json")`；
2. `saveState(data)`：合并现有内存状态与新数据，写入同目录下临时文件后 `fs.renameSync`，确保原子性；
3. `loadState()`：捕获文件不存在或 JSON 格式错误，安全返回 `null`；
4. `clearState()`：清理状态文件；
5. `formatStatusOutput(state, isAlive)`：生成清晰的美化格式，展示 PID、启动时间、Uptime、当前选中的 Active Account、各账号列表与心跳时间。

- [x] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/state_tracker.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/stateTracker.js test/cloudshell/state_tracker.test.js
git commit -m "feat(cloudshell): implement StateTracker for runtime persistence and status formatting"
```

---

### Task 3: 实现守护进程与 PID 管理器 (`daemonManager.js`)

**Files:**
- Create: `scripts/cloudshell/daemonManager.js`
- Create: `test/cloudshell/daemon_manager.test.js`

**Interfaces:**
- Produces:
  - `class DaemonManager`:
    - `getPid()`: 获取当前记录的 PID，若不存在返回 `null`
    - `isProcessAlive(pid)`: 检查 PID 是否真实存在
    - `startDaemon(options)`: 若已有活进程抛错；若后台模式则打开日志文件并通过 `spawn` 派生独立脱离进程写入 PID，返回 `{ pid, background: boolean }`
    - `stopDaemon(force = false)`: 读取 PID 发送 `SIGTERM`，循环等待退出；超时则 `SIGKILL`，清理 PID 文件
    - `tailLogs(follow = false)`: 读取或流式追踪 `logs/cloudshell/daemon.log`

- [x] **Step 1: 编写 `daemonManager` 单元测试**

创建 `test/cloudshell/daemon_manager.test.js`，Mock `child_process.spawn` 与 `process.kill`：

```javascript
/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const { DaemonManager } = require("../../scripts/cloudshell/daemonManager");

describe("CloudShell DaemonManager", () => {
    const testDir = path.join(process.cwd(), "logs", "cloudshell_test_daemon");
    const pidFile = path.join(testDir, "daemon.pid");
    const logFile = path.join(testDir, "daemon.log");

    beforeEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { force: true, recursive: true });
        }
    });

    afterEach(() => {
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { force: true, recursive: true });
        }
    });

    test("writes and reads PID correctly", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        expect(dm.getPid()).toBeNull();
        dm.writePid(54321);
        expect(dm.getPid()).toBe(54321);
        dm.removePid();
        expect(dm.getPid()).toBeNull();
    });

    test("isProcessAlive returns true for current process and false for non-existent pid", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        expect(dm.isProcessAlive(process.pid)).toBe(true);
        expect(dm.isProcessAlive(9999999)).toBe(false);
    });
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/daemon_manager.test.js`
Expected: FAIL (`daemonManager.js` not found)

- [x] **Step 3: 编写 `scripts/cloudshell/daemonManager.js`**

1. 管理 `logs/cloudshell/daemon.pid` 与 `logs/cloudshell/daemon.log`；
2. 实现 `isProcessAlive(pid)`，使用 `process.kill(pid, 0)` 进行无副作用探测；
3. 实现 `startDaemon(cliOptions, rawArgs)`：
   - 检查已记录的 PID，若存在且活跃，抛出 `CloudShell is already running (PID: ...)`；
   - 若非 `foreground`，以 `detached: true, stdio: ['ignore', logFd, logFd]` 派生 Node 进程执行 `runCloudShell.js start --foreground <options>`，写入 PID 并 `child.unref()`；
4. 实现 `stopDaemon(force = false)`：
   - 若未运行，返回 `{ stopped: false, message: "Not running" }`；
   - 发送 `SIGTERM`（或 `SIGKILL` if force），轮询最多 10 秒；超时未退出则下发 `SIGKILL`；
   - 清理 PID 与状态文件，返回 `{ pid, stopped: true }`；
5. 实现 `tailLogs(follow = false)`：
   - 检查 `daemon.log` 是否存在；
   - 若 `follow` 则通过 `fs.watch` 或追加读取流输出，若普通读取则打印末尾 50 行。

- [x] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/daemon_manager.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/daemonManager.js test/cloudshell/daemon_manager.test.js
git commit -m "feat(cloudshell): implement DaemonManager for background process management and signals"
```

---

### Task 4: 将 `StateTracker` 接入 `CloudShellManager` 运行周期

**Files:**
- Modify: `scripts/cloudshell/CloudShellManager.js`
- Modify: `test/cloudshell/cloudshell_manager.test.js`

**Interfaces:**
- Consumes: `StateTracker` instance
- Produces: 实时将各账号就绪状态、最后心跳时间、当前选中的 `currentAuthIndex` 持久化到 `state.json`

- [x] **Step 1: 编写 `CloudShellManager` 与状态同步的测试**

在 `test/cloudshell/cloudshell_manager.test.js` 中增加状态更新断言：

```javascript
test("synchronizes state on account ready and context switch", async () => {
    const mockStateTracker = {
        clearState: jest.fn(),
        saveState: jest.fn(),
    };

    const manager = new CloudShellManager(null, {
        authIndices: [0],
        stateTracker: mockStateTracker,
    });

    manager.syncState("running");
    expect(mockStateTracker.saveState).toHaveBeenCalledWith(
        expect.objectContaining({
            currentAuthIndex: 0,
            status: "running",
        })
    );
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: FAIL (`syncState` is not a function)

- [x] **Step 3: 在 `CloudShellManager.js` 中集成 `StateTracker`**

1. 构造函数中支持传入或默认初始化 `this.stateTracker = options.stateTracker || new StateTracker()`；
2. 实现 `syncState(status = "running")` 方法，收集当前已初始化的各账号（`authIndex`, `status`, `accountName`, `lastHeartbeatAt`）并落盘；
3. 在 `init()` 逐个账号就绪时调用 `syncState()`；
4. 在 `switchActiveContext()` 轮换活跃账号时更新并调用 `syncState()`；
5. 在 `sendHeartbeat()` 发送心跳成功后更新对应账号的 `lastHeartbeatAt`；
6. 在 `stop()` 时将状态更新为 `stopped`。

- [x] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellManager.js test/cloudshell/cloudshell_manager.test.js
git commit -m "feat(cloudshell): integrate state tracker into CloudShellManager lifecycle"
```

---

### Task 5: 重构入口 `runCloudShell.js` 支持子命令分发

**Files:**
- Modify: `scripts/cloudshell/runCloudShell.js`
- Modify: `test/cloudshell/run_cloudshell.test.js`

**Interfaces:**
- CLI entrypoint handling `start`, `stop`, `status`, `restart`, `logs` commands

- [x] **Step 1: 编写 CLI 入口子命令分发测试**

在 `test/cloudshell/run_cloudshell.test.js` 中：

```javascript
test("cloudshell status outputs stopped when no daemon is running", () => {
    const res = spawnSync("node", [scriptPath, "status"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Stopped");
});

test("cloudshell stop outputs message when not running", () => {
    const res = spawnSync("node", [scriptPath, "stop"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("not running");
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: FAIL

- [x] **Step 3: 重构 `runCloudShell.js`**

1. 解析命令行参数得到 `options` 与 `options.command`；
2. 分发逻辑：
   - **`status`**：检查 PID 与读取 `stateTracker`，打印格式化状态输出；
   - **`stop`**：调用 `daemonManager.stopDaemon(options.force)`，输出结果；
   - **`restart`**：先执行 `stopDaemon`，再执行 `start` 流程；
   - **`logs`**：调用 `daemonManager.tailLogs(options.follow)`；
   - **`start`**：
     - 若未传 `--foreground` 且不是 `--headed`：调用 `daemonManager.startDaemon(options)`，打印 PID、日志路径并退出；
     - 若为前台模式：执行原有的浏览器启动与 `CloudShellManager` 长驻循环逻辑，并在进程退出时清理 PID 与状态。

- [x] **Step 4: 运行所有测试确认通过**

Run: `npx jest test/cloudshell/`
Expected: PASS (所有测试套件全部通过)

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/runCloudShell.js test/cloudshell/run_cloudshell.test.js
git commit -m "feat(cloudshell): dispatch start, status, stop, restart, and logs in CLI entrypoint"
```

---

### Task 6: 更新文档与代码质量验收 (Docs & Lint)

**Files:**
- Modify: `scripts/cloudshell/README.md`

- [x] **Step 1: 更新 `scripts/cloudshell/README.md`**

增加 `start`、`status`、`stop`、`restart`、`logs` 管理命令完整使用说明，包括后台常驻启动、在线账号状态查看及停止方法。

- [x] **Step 2: 执行代码格式化与 Lint 校验**

Run: `npm run format && npm run lint`
Expected: 无语法与规范报错，自动格式化整洁。

- [x] **Step 3: 运行全量测试套件**

Run: `npx jest test/cloudshell/`
Expected: 所有测试 100% 通过。

- [x] **Step 4: 提交更改**

```bash
git add scripts/cloudshell/README.md
git commit -m "docs(cloudshell): update management commands documentation"
```
