# Google Cloud Shell 有头模式后台守护与彻底暂停机制设计规范

- **日期**：2026-10-01
- **模块**：`scripts/cloudshell/`
- **状态**：待评审 (Pending User Review)

---

## 1. 概述与问题背景

### 1.1 现状与问题分析
在现有 Cloud Shell 运行器中，用户尝试开启有头模式（Headed 模式）时遇到以下核心问题：
1. **Headed 模式无法作为后台守护进程启动**：
   - `scripts/cloudshell/options.js` 中解析 `--headed` 时强行设置了 `foreground = true`；
   - `scripts/cloudshell/runCloudShell.js` 中启动守护进程的守卫条件排斥了有头模式（`if (!options.foreground && options.headless)`）；
   - `scripts/cloudshell/daemonManager.js` 的 `buildForwardArgs` 遗漏了透传 `--headless false`，即使派生守护进程也会回落为无头模式。
2. **Headed 模式下 `pause` 不生效（依然干扰手动排查）**：
   - 现有的 `pause` 仅跳过了拟人鼠标微移动和多账号轮换；
   - 但终端心跳保活 `sendHeartbeat()` 与弹窗旁路 `bypassModalsOnce()` 依然在周期性执行；
   - `sendHeartbeat()` 会强行执行 `target.screen.click({ force: true })` 并在终端键入 `Space` 和 `Backspace`，导致用户在 Headed 浏览器手动操作时焦点被抢夺、输入内容被破坏；
   - `bypassModalsOnce()` 还会调用 `simulateHumanMovement` 模拟鼠标移动，破坏用户自己的鼠标位置。

### 1.2 核心目标
1. **解耦 Headed 与 Foreground**：`--headed` 仅决定浏览器是否显示真实可视化窗口，不再与前台阻塞绑定。`npm run cloudshell -- start --headed` 默认以后台守护进程运行，释放当前终端，并在图形桌面环境显示浏览器界面。
2. **实现彻底的纯净手动模式（Complete Automation Freeze）**：当用户调用 `pause` 时，完全冻结一切对浏览器的自动化干预（包括微操作、切屏轮换、键盘心跳键入、屏幕点击抢焦、弹窗模拟点击），将浏览器的全部输入控制权交给用户。调用 `resume` 后恢复正常的自动化调度。

---

## 2. 详细架构设计

### 2.1 命令行参数解析与守护派生解耦

#### 2.1.1 移除 `--headed` 的前台硬编码 (`scripts/cloudshell/options.js`)
- 当解析到 `--headed` 时，仅设置 `options.headless = false`，不修改 `options.foreground`；
- 只有显式传入 `-f` 或 `--foreground` 时，`options.foreground` 才为 `true`。
```javascript
if (arg === "--headed") {
    options.headless = false;
    continue;
}
```

#### 2.1.2 统一后台守护进程启动守卫 (`scripts/cloudshell/runCloudShell.js`)
- 启动守护进程的唯一条件是 `!options.foreground`，不再限制 `options.headless`：
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

#### 2.1.3 守护进程参数透传补齐 (`scripts/cloudshell/daemonManager.js`)
- 在 `buildForwardArgs(options)` 中，当 `options.headless === false` 时，追加透传参数：
```javascript
if (options.headless === false) {
    args.push("--headless", "false");
}
```
这样后台派生的守护子进程将带着 `--headless false` 启动，在桌面环境中打开浏览器窗口，而命令行进程直接退出。

---

### 2.2 彻底的纯净手动模式 (Pure Manual Mode)

#### 2.2.1 `CloudShellManager` 主控循环交互冻结 (`scripts/cloudshell/CloudShellManager.js`)
在 `executeTick(tickCount, heartbeatTicks, switchTicks)` 中：
1. **状态检查与提示日志**：
   - 检查 `isPaused = this.isAntiDetectionPaused()`；
   - 首次进入暂停时打印：`⏸️ Anti-detection micro-actions, auto-rotation, heartbeats and modal clicking are PAUSED (manual mode active).`
   - 退出暂停时打印：`▶️ Anti-detection micro-actions, auto-rotation, heartbeats and modal clicking have RESUMED.`
2. **冻结逻辑**：
   - 若 `isPaused === true`：
     - **跳过** 活跃上下文微操作 `performActiveMicroActions`；
     - **跳过** 键盘心跳与焦点点击 `sendHeartbeat`；
     - **跳过** 弹窗侦测与物理模拟点击 `bypassModalsOnce`；
     - **跳过** 多账号活跃上下文自动轮换 `rotateActiveContext`；
     - 保留主循环 tick 计数与进程保活睡眠，轮询等待 `resume`。
   - 若 `isPaused === false`：
     - 正常按周期执行上述全部自动化保活与防休眠任务。

#### 2.2.2 状态格式化输出更新 (`scripts/cloudshell/stateTracker.js`)
在 `formatStatusOutput(state, isAlive)` 中，展示更精确的手动模式说明：
```text
Anti-Detection:     ⏸️ Paused (Manual Mode)
Auto-Rotation:      ⏸️ Paused
Heartbeat & Modals: ⏸️ Paused
```
明确向用户指示键盘和鼠标交互均已静止，可安全在 Headed 窗口中操作。

---

## 3. 兼容性与影响评估

1. **现有无头运行模式**：
   - `npm run cloudshell -- start` 仍默认无头后台运行，不受影响；
   - `npm run cloudshell -- start -f` 仍在前台运行，不受影响。
2. **Headed 前台模式**：
   - 若用户依然希望在前台查看有头模式的控制台日志，可通过组合参数：
     `npm run cloudshell -- start --headed -f`
3. **`pause` 与 `resume` 指令**：
   - 指令语义完全向后兼容，但对用户手动排查的保护程度从“部分暂停”升级为“彻底纯净暂停”。

---

## 4. 测试与验证方案

1. **选项解析单元测试** (`test/cloudshell/options.test.js`)：
   - 测试 `--headed` 仅使 `headless = false`，`foreground` 保持为 `false`；
   - 测试 `--headed -f` / `--headed --foreground` 使 `headless = false` 且 `foreground = true`。
2. **守护管理器参数透传单元测试** (`test/cloudshell/daemon_manager.test.js`)：
   - 测试 `buildForwardArgs({ headless: false })` 正确输出包含 `["--headless", "false"]`。
3. **主控管理器暂停冻结单元测试** (`test/cloudshell/cloudshell_manager.test.js`)：
   - 测试在 `isPaused = true` 时，`performActiveMicroActions`、`rotateActiveContext`、`sendHeartbeat`、`bypassModalsOnce` 均不被调用；
   - 测试在 `isPaused = false` 时，全部正常按周期被调用。
4. **状态格式化测试** (`test/cloudshell/state_tracker.test.js`)：
   - 验证暂停状态下格式化输出的准确性。
5. **文档与回归测试**：
   - 更新 `scripts/cloudshell/README.md` 中关于 `--headed` 和 `pause` 的说明；
   - 执行 `npm run lint` 与 `npx jest test/cloudshell/`，确保全量测试通过。
