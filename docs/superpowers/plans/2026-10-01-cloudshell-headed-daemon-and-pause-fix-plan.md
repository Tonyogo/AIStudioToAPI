# Google Cloud Shell 有头模式后台守护与彻底暂停机制实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解耦 Cloud Shell 运行器的 `--headed` 与前台阻塞绑定，使有头模式支持后台脱离守护运行，并在 `pause` 时彻底冻结一切页面自动化交互（微操作、切屏轮换、键盘心跳与弹窗物理点击），保障手动操作排查不受干扰。

**Architecture:** 
1. 解耦 CLI 参数解析中 `--headed` 与 `foreground` 的硬绑定，`start --headed` 默认以后台守护进程启动；
2. 在 `DaemonManager.buildForwardArgs` 中追加透传 `--headless false`，并在 `runCloudShell.js` 中解除后台启动对 `headless: true` 的守卫限制；
3. 在 `CloudShellManager.executeTick` 中将 `pause` 从部分跳过升级为彻底冻结（包括心跳 Space/Backspace 和弹窗物理���拟点击均挂起），并在状态面板呈现完整的手动模式指示。

**Tech Stack:** Node.js, Playwright (Firefox/Camoufox), Jest

**Spec:** `docs/superpowers/specs/2026-10-01-cloudshell-headed-daemon-and-pause-fix-design.md`

## Global Constraints

- 遵循项目现有的 ESLint 与 Prettier 代码规范；
- 保持子命令接口向后兼容，所有现存无头命令行为保持不变；
- 所有的改动必须附带单元测试覆盖，且 `test/cloudshell/` 全量通过；
- 每次任务实现严格按 TDD 步骤（编写失败测试 -> 验证失败 -> 最小化实现 -> 验证通过 -> 提交）。

## Review Focus

1. **`start --headed` 参数下 `foreground` 保持为 `false`**：验证用户执行 `start --headed` 时不会被误判为前台模式，只有显式传入 `-f` / `--foreground` 时 `foreground` 才是 `true`；
2. **`DaemonManager` 能够正确透传 `--headless false`**：验证派生的子进程参数列表中包含 `["--headless", "false"]`；
3. **`runCloudShell.js` 在有头且非前台时正确调用 `daemonManager.startDaemon`**：验证 `!options.foreground` 就能触发守护进程启���，而不再受 `options.headless` 约束；
4. **处于暂停状态时主控循环绝对不触发心跳按键与弹窗点击**：验证 `executeTick` 在 `isPaused = true` 时，`sendHeartbeat` 与 `bypassModalsOnce` 均被跳过，避免敲入 Space/Backspace 或强抢焦点；
5. **恢复状态后所有心跳、弹窗穿透、微操作与轮换恢复执行**：验证 `resume`（`isPaused = false`）后下一周期正常调用所有保活机制。

---

### Task 1: 解耦 CLI 选项中 `--headed` 与 `foreground` 的绑定

**Files:**
- Modify: `scripts/cloudshell/options.js:158-163`
- Modify: `test/cloudshell/options.test.js:104-108`

**Interfaces:**
- Produces: `parseCliArgs(args)` where `--headed` sets `headless: false` without setting `foreground: true`.

- [ ] **Step 1: 修改并扩展 `options.test.js` 中的测试**

将原来期待 `--headed` 自动启用 `foreground: true` 的测试修改为期待 `foreground: false`，并新增 `--headed -f` 测试：

```javascript
    test("sets headless to false without forcing foreground when --headed is passed", () => {
        const opts = parseCliArgs(["start", "--headed"]);
        expect(opts.headless).toBe(false);
        expect(opts.foreground).toBe(false);
    });

    test("sets foreground to true when -f or --foreground is combined with --headed", () => {
        expect(parseCliArgs(["start", "--headed", "-f"]).foreground).toBe(true);
        expect(parseCliArgs(["start", "--headed", "--foreground"]).foreground).toBe(true);
    });
```

- [ ] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/options.test.js`
Expected: FAIL（因为当前代码中 `--headed` 仍将 `foreground` 设为 `true`）。

- [ ] **Step 3: 修改 `scripts/cloudshell/options.js`**

找到第 158-162 行：
```javascript
        if (arg === "--headed") {
            options.headless = false;
            continue;
        }
```
移除 `options.foreground = true;` 这一行。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/cloudshell/options.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/options.js test/cloudshell/options.test.js
git commit -m "feat(cloudshell): decouple --headed option from foreground mode

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 在 `DaemonManager` 中增加 `--headless false` 参数透传

**Files:**
- Modify: `scripts/cloudshell/daemonManager.js:62-85`
- Modify: `test/cloudshell/daemon_manager.test.js`

**Interfaces:**
- Produces: `DaemonManager.buildForwardArgs(options)` supporting forwarding of `--headless false` when `options.headless === false`.

- [ ] **Step 1: 在 `daemon_manager.test.js` 中编写失败测试**

在 `test/cloudshell/daemon_manager.test.js` 中新增测试用例：

```javascript
    test("buildForwardArgs includes --headless false when options.headless is false", () => {
        const dm = new DaemonManager({ logFile, pidFile });
        const args = dm.buildForwardArgs({
            authIndices: [0],
            headless: false,
        });
        expect(args).toContain("--headless");
        const idx = args.indexOf("--headless");
        expect(args[idx + 1]).toBe("false");
    });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest test/cloudshell/daemon_manager.test.js`
Expected: FAIL (`expect(args).toContain("--headless")` failed).

- [ ] **Step 3: 修改 `scripts/cloudshell/daemonManager.js`**

在 `buildForwardArgs(options = {})` 中增加对 `options.headless === false` 的透传：

```javascript
        if (options.headless === false) {
            args.push("--headless", "false");
        }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/cloudshell/daemon_manager.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/daemonManager.js test/cloudshell/daemon_manager.test.js
git commit -m "feat(cloudshell): forward --headless false in DaemonManager child arguments

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 在 `runCloudShell.js` 中统一守护启动守卫

**Files:**
- Modify: `scripts/cloudshell/runCloudShell.js:77-85`
- Modify: `test/cloudshell/run_cloudshell.test.js`

**Interfaces:**
- Modifies: `handleStart(options, stateTracker, daemonManager)` to trigger daemon start for any `!options.foreground` invocation, including `--headed`.

- [ ] **Step 1: 在 `test/cloudshell/run_cloudshell.test.js` 中增加测试**

编写测试验证在 `options.headless === false` 但 `options.foreground === false` 时，`handleStart` 调用 `daemonManager.startDaemon`：

```javascript
    test("handleStart launches daemon when headless is false but foreground is false", async () => {
        const { handleStart } = require("../../scripts/cloudshell/runCloudShell");
        if (typeof handleStart === "function") {
            const mockTracker = {};
            const mockDaemon = {
                logFile: "/dummy/path.log",
                startDaemon: jest.fn().mockReturnValue({ pid: 5678 }),
            };
            const mockExit = jest.spyOn(process, "exit").mockImplementation(() => {});
            const mockConsole = jest.spyOn(console, "log").mockImplementation(() => {});

            await handleStart({ authIndices: [0], foreground: false, headless: false }, mockTracker, mockDaemon);

            expect(mockDaemon.startDaemon).toHaveBeenCalled();
            expect(mockExit).toHaveBeenCalledWith(0);

            mockExit.mockRestore();
            mockConsole.mockRestore();
        }
    });
```

并在 `runCloudShell.js` 的 `module.exports` 中导出 `handleStart` 便于单元测试：
`module.exports = { handlePause, handleResume, handleStart, main };`

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: FAIL (`handleStart is not a function` 或 `mockDaemon.startDaemon` 未被调用).

- [ ] **Step 3: 修改 `scripts/cloudshell/runCloudShell.js`**

1. 修改守卫条件为仅检查 `!options.foreground`：
```javascript
    if (!options.foreground) {
        const result = daemonManager.startDaemon(options);
        console.log(`🚀 [CloudShell] Daemon started in background (PID: ${result.pid}).`);
        console.log(`   Log file: ${daemonManager.logFile}`);
        console.log(`   Run 'npm run cloudshell -- status' to check status.`);
        console.log(`   Run 'npm run cloudshell -- logs -f' to view logs.`);
        process.exit(0);
    }
```
2. 在文件底部导出 `handleStart`：
```javascript
module.exports = { handlePause, handleResume, handleStart, main };
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/cloudshell/run_cloudshell.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/runCloudShell.js test/cloudshell/run_cloudshell.test.js
git commit -m "feat(cloudshell): allow headed mode to start as daemon in background

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 纯净手动模式实现：彻底冻结主控循环与更新状态展示

**Files:**
- Modify: `scripts/cloudshell/CloudShellManager.js:254-301`
- Modify: `scripts/cloudshell/stateTracker.js:115-135`
- Modify: `test/cloudshell/cloudshell_manager.test.js:190-240`
- Modify: `test/cloudshell/state_tracker.test.js:125-140`

**Interfaces:**
- Modifies: `CloudShellManager.prototype.executeTick(tickCount, heartbeatTicks, switchTicks)`:
  - When `isPaused === true`, skips `performActiveMicroActions`, `rotateActiveContext`, `sendHeartbeat`, and `bypassModalsOnce`.
- Modifies: `StateTracker.prototype.formatStatusOutput`:
  - Displays `Heartbeat:          ⏸️ Paused (Manual Mode)` when paused.

- [ ] **Step 1: 编写彻底暂停冻结的测试**

在 `test/cloudshell/cloudshell_manager.test.js` 中更新/添加测试：

```javascript
    test("freezes all interactions (micro-actions, rotation, heartbeat, modal bypass) when paused, and resumes on unpause", async () => {
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
            keepAliveMinutes: 0.001,
            stateTracker: mockStateTracker,
            switchIntervalMinutes: 0.05,
        });

        manager.contexts.set(0, {
            controller: mockController,
            page: { isClosed: () => false },
        });

        const rotateSpy = jest.spyOn(manager, "rotateActiveContext").mockResolvedValue();

        // 1. In paused mode (tick 1 matches heartbeat and switch ticks):
        await manager.executeTick(1, 1, 1);

        expect(mockController.performActiveMicroActions).not.toHaveBeenCalled();
        expect(mockController.sendHeartbeat).not.toHaveBeenCalled();
        expect(mockController.bypassModalsOnce).not.toHaveBeenCalled();
        expect(rotateSpy).not.toHaveBeenCalled();

        // 2. Unpause and execute tick 2:
        paused = false;
        await manager.executeTick(2, 1, 1);

        expect(mockController.performActiveMicroActions).toHaveBeenCalled();
        expect(mockController.sendHeartbeat).toHaveBeenCalled();
        expect(mockController.bypassModalsOnce).toHaveBeenCalled();
        expect(rotateSpy).toHaveBeenCalled();
    });
```

同时在 `test/cloudshell/state_tracker.test.js` 中增加对手动模式 Heartbeat 展示的断言：
```javascript
        expect(output).toContain("Paused (Manual Mode)");
        expect(output).toContain("Heartbeat:          ⏸️ Paused (Manual Mode)");
        expect(output).toContain("Auto-Rotation:      ⏸️ Paused");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js test/cloudshell/state_tracker.test.js`
Expected: FAIL (`sendHeartbeat` was called).

- [ ] **Step 3: 修改 `scripts/cloudshell/CloudShellManager.js` 与 `scripts/cloudshell/stateTracker.js`**

1. 修改 `scripts/cloudshell/CloudShellManager.js` 中的 `executeTick`：
```javascript
    async executeTick(tickCount, heartbeatTicks, switchTicks) {
        const isPaused = this.isAntiDetectionPaused();
        if (isPaused) {
            if (!this._wasPaused) {
                this.log(
                    "⏸️ Anti-detection micro-actions, auto-rotation, heartbeats and modal clicking are PAUSED (manual mode active)."
                );
                this._wasPaused = true;
            }
        } else if (this._wasPaused) {
            this.log(
                "▶️ Anti-detection micro-actions, auto-rotation, heartbeats and modal clicking have RESUMED."
            );
            this._wasPaused = false;
        }

        // 1. Micro-actions on active context (skipped if paused)
        if (!isPaused) {
            const activeEntry = this.contexts.get(this.currentAuthIndex);
            if (activeEntry && activeEntry.controller && activeEntry.page && !activeEntry.page.isClosed()) {
                try {
                    await activeEntry.controller.performActiveMicroActions(tickCount);
                } catch (err) {
                    this.warn(`Active micro-actions error on Account #${this.currentAuthIndex}: ${err.message}`);
                }
            }
        }

        // 2. Periodic anti-idle heartbeat and modal bypass on all contexts (skipped if paused)
        if (!isPaused && tickCount % heartbeatTicks === 0) {
            for (const [authIndex, entry] of this.contexts) {
                if (entry.page && !entry.page.isClosed() && entry.controller) {
                    try {
                        await entry.controller.sendHeartbeat();
                        await entry.controller.bypassModalsOnce();
                        const accMeta = this.accountMetadata.get(authIndex);
                        if (accMeta) {
                            accMeta.lastHeartbeatAt = new Date().toISOString();
                        }
                        this.syncState("running");
                    } catch (err) {
                        this.warn(`Heartbeat/modal bypass error on Account #${authIndex}: ${err.message}`);
                    }
                }
            }
        }

        // 3. Periodic active context rotation if multiple accounts exist (skipped if paused)
        if (!isPaused && this.authIndices.length > 1 && tickCount % switchTicks === 0) {
            await this.rotateActiveContext();
        }
    }
```

2. 修改 `scripts/cloudshell/stateTracker.js` 中的 `formatStatusOutput`：
```javascript
        const isPaused = Boolean(state.antiDetectionPaused);
        const autoRotationStr = isPaused
            ? "⏸️ Paused"
            : `▶️ Active (Every ${state.switchIntervalMinutes ? `${state.switchIntervalMinutes} min` : "N/A"})`;
        const heartbeatStr = isPaused ? "⏸️ Paused (Manual Mode)" : "▶️ Active (Enabled)";

        const lines = [
            "==================================================",
            `Cloud Shell Status: Running (PID: ${state.pid})`,
            `Anti-Detection:     ${isPaused ? "⏸️ Paused (Manual Mode)" : "▶️ Active (Enabled)"}`,
            `Heartbeat:          ${heartbeatStr}`,
            `Auto-Rotation:      ${autoRotationStr}`,
            `Started At:         ${state.startedAt || "N/A"}`,
            `Uptime:             ${uptimeStr}`,
            `Switch Interval:    ${state.switchIntervalMinutes ? `${state.switchIntervalMinutes} min` : "N/A"}`,
            `Current Active:     Auth ${state.currentAuthIndex !== undefined ? state.currentAuthIndex : "N/A"}`,
            "--------------------------------------------------",
            "Accounts:",
        ];
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js test/cloudshell/state_tracker.test.js`
Expected: PASS

- [ ] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellManager.js scripts/cloudshell/stateTracker.js test/cloudshell/cloudshell_manager.test.js test/cloudshell/state_tracker.test.js
git commit -m "feat(cloudshell): completely freeze automation during pause for pure manual mode

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 更新 README 文档与全量回归验收

**Files:**
- Modify: `scripts/cloudshell/README.md`

- [ ] **Step 1: 更新 `scripts/cloudshell/README.md`**

在 README 中：
1. 更新参数说明：`--headed` 说明为“在桌面环境中弹出可视化浏览器窗口（默认后台守护运行，添加 `-f` 可在前台阻塞运行）”；
2. 更新使用场景中“4. 可视化界面排查调试 (Headed 模式)”：说明执行 `npm run cloudshell -- start --headed` 将在后台启动并打开浏览器窗口；
3. 更新“6. 临时手动排查与恢复 (Manual Mode)”：说明 `pause` 将彻底静默鼠标、键盘心跳与弹窗点击，完全让出输入焦点。

- [ ] **Step 2: 执行代码格式化与规范检查**

Run: `npm run format && npm run lint`
Expected: 0 错误，代码完全符合 Prettier 与 ESLint 规范。

- [ ] **Step 3: 运行全量测试套件**

Run: `npx jest test/cloudshell/`
Expected: 11 个测试套件，所有测试用例 100% PASS。

- [ ] **Step 4: 提交更改**

```bash
git add scripts/cloudshell/README.md
git commit -m "docs(cloudshell): document headed background daemon mode and pure manual pause

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---
