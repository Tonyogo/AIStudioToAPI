# Google Cloud Shell 拟人防检测暂停与恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Google Cloud Shell 自动化工具增加 `pause` 与 `resume` 管理子命令，支持随时暂停活跃上下文上的拟人鼠标晃动、微滚动与多账号自动切屏（方便用户手动操作），并在操作完成后通过命令恢复防检测保活循环。

**Architecture:** 在 `options.js` 中将 `pause` 与 `resume` 纳入合法子命令；在 `stateTracker.js` 中支持持久化 `antiDetectionPaused` 字段与维护标记文件 `logs/cloudshell/paused.flag`，并在 `formatStatusOutput` 中呈现暂停/激活状态；在 `CloudShellManager.js` 的 4 秒 tick 循环中动态检测暂停状态，若处于暂停状态则跳过 `performActiveMicroActions` 与 `rotateActiveContext`，但维持 `sendHeartbeat` 键盘保活；在 `runCloudShell.js` 中添加对应的处理分支。

**Tech Stack:** Node.js, Jest, Playwright (Firefox / Camoufox).

## Global Constraints

- 支持 `pause` 和 `resume` 一级子命令。
- 在未启动守护进程时调用 `pause`/`resume`，输出友好提示并正常退出。
- 暂停状态下：
  - 严禁触发活跃页面的鼠标移动、平滑抖动、微滚动或 (1,1) 归位；
  - 严禁触发多账号之间的自动切屏 (`rotateActiveContext`)；
  - 允许并保持周期性键盘心跳 (`sendHeartbeat`) 与弹窗旁路检查。
- 恢复状态后，微操作与定时切屏立即恢复调度。
- 进程停止 (`stop`) 或退出时必须清理 `paused.flag`。
- 所有代码符合 ESLint 和 Prettier 规范。

---

### Task 1: 扩展 CLI 选项解析器支持 `pause` 与 `resume`

**Files:**
- Modify: `scripts/cloudshell/options.js:55-75, 240-275`
- Modify: `test/cloudshell/options.test.js`

**Interfaces:**
- Produces: `parseCliArgs(args)` supporting `command: "pause"` and `command: "resume"`

- [ ] **Step 1: 编写失败的解析测试**

在 `test/cloudshell/options.test.js` 中新增：

```javascript
test("parses pause and resume subcommands correctly", () => {
    expect(parseCliArgs(["pause"]).command).toBe("pause");
    expect(parseCliArgs(["resume"]).command).toBe("resume");
});
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/options.test.js`
Expected: FAIL (因为 `VALID_COMMANDS` 尚未包含 `pause` 和 `resume`)

- [ ] **Step 3: 修改 `options.js`**

1. 将 `VALID_COMMANDS` 扩展为包含 `"pause"` 和 `"resume"`；
2. 更新 `printHelp()` 函数，加入 `pause` 和 `resume` 的说明与用例。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/options.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/options.js test/cloudshell/options.test.js
git commit -m "feat(cloudshell): support pause and resume subcommands in options parser"
```

---

### Task 2: 在 `StateTracker` 中实现暂停标志持久化与状态格式化

**Files:**
- Modify: `scripts/cloudshell/stateTracker.js`
- Modify: `test/cloudshell/state_tracker.test.js`

**Interfaces:**
- Produces:
  - `tracker.setPaused(paused: boolean)`: 更新 `state.json` 中的 `antiDetectionPaused` 并创建/删除 `logs/cloudshell/paused.flag`
  - `tracker.isPaused(): boolean`: 检测 `paused.flag` 是否存在或 state 中的字段
  - `tracker.formatStatusOutput(state, isAlive)`: 渲染 `Anti-Detection` 和 `Auto-Rotation` 状态行

- [ ] **Step 1: 编写 `StateTracker` 暂停相关的失败测试**

在 `test/cloudshell/state_tracker.test.js` 中新增测试：

```javascript
test("sets and gets paused flag correctly", () => {
    const tracker = new StateTracker(testStateFile);
    expect(tracker.isPaused()).toBe(false);

    tracker.setPaused(true);
    expect(tracker.isPaused()).toBe(true);
    expect(fs.existsSync(tracker.flagFilePath)).toBe(true);

    tracker.setPaused(false);
    expect(tracker.isPaused()).toBe(false);
    expect(fs.existsSync(tracker.flagFilePath)).toBe(false);
});

test("formatStatusOutput displays Paused status when antiDetectionPaused is true", () => {
    const tracker = new StateTracker(testStateFile);
    const runningState = {
        accounts: [{ accountName: "test@gmail.com", authIndex: 0, status: "active" }],
        antiDetectionPaused: true,
        currentAuthIndex: 0,
        pid: 8888,
        startedAt: new Date().toISOString(),
        status: "running",
        switchIntervalMinutes: 10,
    };
    const output = tracker.formatStatusOutput(runningState, true);
    expect(output).toContain("Paused (Manual Mode)");
    expect(output).toContain("Auto-Rotation:      ⏸️ Paused");
});
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/state_tracker.test.js`
Expected: FAIL (`tracker.setPaused` is not a function)

- [ ] **Step 3: 修改 `stateTracker.js` 实现���辑**

1. 构造函数中增加 `this.flagFilePath = path.join(path.dirname(this.stateFilePath), "paused.flag");`；
2. 实现 `setPaused(paused)`：
   - 更新 `this.saveState({ antiDetectionPaused: Boolean(paused) })`；
   - 若 `paused`，写入 `fs.writeFileSync(this.flagFilePath, new Date().toISOString(), "utf-8")`；
   - 若 `!paused`，若文件存在则 `fs.unlinkSync(this.flagFilePath)`；
3. 实现 `isPaused()`：返回 `fs.existsSync(this.flagFilePath)`；
4. 在 `clearState()` 中同时清理 `this.flagFilePath`；
5. 在 `formatStatusOutput` 中增加对 `state.antiDetectionPaused` 的展示行：
   - `Anti-Detection:     ${isPaused ? "⏸️ Paused (Manual Mode)" : "▶️ Active (Enabled)"}`
   - `Auto-Rotation:      ${isPaused ? "⏸️ Paused" : `▶️ Active (Every ${state.switchIntervalMinutes} min)`}`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/state_tracker.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/stateTracker.js test/cloudshell/state_tracker.test.js
git commit -m "feat(cloudshell): implement pause flag persistence and status formatting in StateTracker"
```

---

### Task 3: 在 `CloudShellManager` 主控循环中接入暂停感知

**Files:**
- Modify: `scripts/cloudshell/CloudShellManager.js`
- Modify: `test/cloudshell/cloudshell_manager.test.js`

**Interfaces:**
- Consumes: `this.stateTracker.isPaused()` or `options.isPausedFn`
- Behavior: 当暂停时，跳过活跃上下文微操作与自动轮换，但维持心跳与弹窗旁路

- [ ] **Step 1: 编写 `CloudShellManager` 暂停感知的失败测试**

在 `test/cloudshell/cloudshell_manager.test.js` 中新增测试：

```javascript
test("skips micro-actions and rotation when paused, but continues heartbeats", async () => {
    let paused = true;
    const mockStateTracker = {
        clearState: jest.fn(),
        isPaused: () => paused,
        saveState: jest.fn(),
    };

    const mockController = {
        bypassModalsOnce: jest.fn().mockResolvedValue(false),
        performActiveMicroActions: jest.fn().mockResolvedValue(),
        sendHeartbeat: jest.fn().mockResolvedValue(),
    };

    const manager = new CloudShellManager(null, {
        authIndices: [0, 1],
        heartbeatIntervalSeconds: 4, // 1 tick
        keepAliveMinutes: 0.001, // short loop
        stateTracker: mockStateTracker,
        switchIntervalMinutes: 0.05,
    });

    manager.contexts.set(0, {
        controller: mockController,
        page: { isClosed: () => false },
    });
    manager.contexts.set(1, {
        controller: mockController,
        page: { isClosed: () => false },
    });

    const rotateSpy = jest.spyOn(manager, "rotateActiveContext").mockResolvedValue();

    // Run one iteration or loop
    await manager.executeTick(1, 1, 1);

    // In paused mode:
    expect(mockController.performActiveMicroActions).not.toHaveBeenCalled();
    expect(rotateSpy).not.toHaveBeenCalled();
    expect(mockController.sendHeartbeat).toHaveBeenCalled();

    // Now resume
    paused = false;
    await manager.executeTick(2, 1, 1);
    expect(mockController.performActiveMicroActions).toHaveBeenCalled();
    expect(rotateSpy).toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: FAIL (`executeTick` or pause check not yet implemented)

- [ ] **Step 3: 重构 `CloudShellManager.js` 支持暂停感知**

1. 新增辅助方法 `isAntiDetectionPaused()`：
   ```javascript
   isAntiDetectionPaused() {
       if (typeof this.options.isPausedFn === "function") {
           return this.options.isPausedFn();
       }
       if (this.stateTracker && typeof this.stateTracker.isPaused === "function") {
           return this.stateTracker.isPaused();
       }
       return false;
   }
   ```
2. 提取并实现 `async executeTick(tickCount, heartbeatTicks, switchTicks)`：
   - 检查 `const isPaused = this.isAntiDetectionPaused();`；
   - 若 `!isPaused`：执行活跃上下文的 `performActiveMicroActions`；若到达 `switchTicks` 触发 `rotateActiveContext`；
   - 若 `isPaused`：跳过上述两项，记录单次状态切换日志；
   - 无论是否暂停：到达 `heartbeatTicks` 时照常执行全 Context 的 `sendHeartbeat()` 与 `bypassModalsOnce()`；
3. 在 `startRotationAndKeepAliveLoop()` 中调用 `await this.executeTick(...)`；
4. 在 `stop()` 时调用 `this.stateTracker.clearState()`，清理状态及 `paused.flag`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellManager.js test/cloudshell/cloudshell_manager.test.js
git commit -m "feat(cloudshell): dynamically respect pause flag in CloudShellManager keep-alive loop"
```

---

### Task 4: 在 `runCloudShell.js` 中接入 `pause` 与 `resume` 处理

**Files:**
- Modify: `scripts/cloudshell/runCloudShell.js`
- Modify: `test/cloudshell/run_cloudshell.test.js`

**Interfaces:**
- CLI entrypoint handling `pause` and `resume` subcommands

- [ ] **Step 1: 编写 CLI 入口 `pause` 与 `resume` 的单元测试**

在 `test/cloudshell/run_cloudshell.test.js` 中新增测试：

```javascript
test("cloudshell pause outputs message when daemon is not running", () => {
    const res = spawnSync("node", [scriptPath, "pause"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("not running");
});

test("cloudshell resume outputs message when daemon is not running", () => {
    const res = spawnSync("node", [scriptPath, "resume"], { encoding: "utf-8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("not running");
});
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: FAIL (因为 `runCloudShell.js` 尚不支持分发 `pause` 和 `resume`)

- [ ] **Step 3: 在 `runCloudShell.js` 中实现分发逻辑**

1. 实现 `handlePause(stateTracker, daemonManager)`：
   - 获取 PID 检查是否运行中；
   - 若未运行，打印 `CloudShell is not running. Nothing to pause.`；
   - 若运行中，调用 `stateTracker.setPaused(true)`，输出：
     ```text
     ⏸️ [CloudShell] Anti-detection mouse movements & auto-rotation have been PAUSED.
        You can now safely perform manual operations without mouse interruption.
        Run 'npm run cloudshell -- resume' when you are finished.
     ```
2. 实现 `handleResume(stateTracker, daemonManager)`：
   - 获取 PID 检查是否运行中；
   - 若未运行，打印 `CloudShell is not running.`；
   - 若运行中，调用 `stateTracker.setPaused(false)`，输出：
     ```text
     ▶️ [CloudShell] Anti-detection mouse movements & auto-rotation have been RESUMED.
     ```
3. 在 `main` 的 `switch (options.command)` 中添加 `pause` 与 `resume` 分支。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/runCloudShell.js test/cloudshell/run_cloudshell.test.js
git commit -m "feat(cloudshell): handle pause and resume subcommands in CLI entrypoint"
```

---

### Task 5: 文档更新、全量测试回归与质量验收 (Docs & Lint)

**Files:**
- Modify: `scripts/cloudshell/README.md`

- [ ] **Step 1: 更新 `scripts/cloudshell/README.md`**

增加 `pause` 和 `resume` 命令的使用说明，详述临时手动排查场景与命令用法。

- [ ] **Step 2: 代码规范检查与格式化**

Run: `npm run format && npm run lint`
Expected: 0 错误，代码排版与格式符合规范。

- [ ] **Step 3: 运行全量测试套件**

Run: `npx jest test/cloudshell/`
Expected: 全部测试套件（11 个测试套件，60+ 用例）100% 通过。

- [ ] **Step 4: 提交更改**

```bash
git add scripts/cloudshell/README.md
git commit -m "docs(cloudshell): document pause and resume manual mode commands"
```
