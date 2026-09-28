# Google Cloud Shell 拟人防检测暂停与恢复设计规范

- **日期**：2026-09-28
- **模块**：`scripts/cloudshell/`
- **状态**：已批准 (Approved)

---

## 1. 概述与需求背景

在 Cloud Shell 长驻保活期间，`CloudShellManager` 会周期性执行拟人化鼠标平滑移动、微滚动页面以及多账号定时自动轮转（切换前台 Context）。
当用户需要在 Cloud Shell 终端或通过可视化界面（Headed 模式）临时执行手动排查、调试或键入复杂命令时，自动化的鼠标晃动和自动切屏会干扰用户的正常操作。

本设计为管理命令行增加随时可控的**暂停（`pause`）**与**恢复（`resume`）**机制：
- **`pause`**：进入“临时手动操作模式”，暂停活跃上下文上的拟人鼠标晃动、微滚动与多账号自动切屏，将控制权完全留给用户，同时保留后台基础心跳保活；
- **`resume`**：退出手动操作模式，恢复自动化防检测微操作与多账号轮流激活；
- **`status`**：在状态面板中清晰反映当前的防检测运行模式（`Active` 或 `Paused (Manual Mode)`）。

---

## 2. 命令行交互规范 (CLI Specification)

### 2.1 新增子命令

| 子命令 | 说明 | 运行前置条件 |
| :--- | :--- | :--- |
| `pause` | 暂停拟人鼠标移动、微滚动与自动切屏，进入手动操作模式 | 需存在正在运行的 CloudShell 实例 |
| `resume` | 恢复拟人鼠标移动、微滚动与自动切屏 | 需存在正在运行的 CloudShell 实例 |

### 2.2 控制台交互示例

- **执行暂停**：
  ```bash
  npm run cloudshell -- pause
  ```
  输出：
  ```text
  ⏸️ [CloudShell] Anti-detection mouse movements & auto-rotation have been PAUSED.
     You can now safely perform manual operations without mouse interruption.
     Run 'npm run cloudshell -- resume' when you are finished.
  ```

- **执行恢复**：
  ```bash
  npm run cloudshell -- resume
  ```
  输出：
  ```text
  ▶️ [CloudShell] Anti-detection mouse movements & auto-rotation have been RESUMED.
  ```

- **查看状态 (`status`)**：
  ```text
  ==================================================
  Cloud Shell Status: Running (PID: 12345)
  Anti-Detection:     ⏸️ Paused (Manual Operation Mode)
  Auto-Rotation:      ⏸️ Paused
  Started At:         2026-09-28T06:00:00.000Z
  Uptime:             45m 12s
  Switch Interval:    10 min
  Current Active:     Auth 0
  --------------------------------------------------
  Accounts:
  * [Auth 0] user0@gmail.com | Status: Active (Heartbeat: 2026-09-28T06:45:00.000Z)
    [Auth 1] user1@gmail.com | Status: Ready (Heartbeat: 2026-09-28T06:44:50.000Z)
  ==================================================
  ```

---

## 3. 架构设计与状态同步机制

```
┌─────────────────────────────────────────────────────────────┐
│                 runCloudShell.js (CLI Dispatcher)           │
│           新增支持: pause / resume 子命令分发                │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────���───────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────────┐     ┌───────────────────────┐
│         CLI 暂停/恢复调用       │     │   StateTracker (状态) │
│ ├─ pause: 写入 paused.flag    │     │ ├─ setPaused(true/false)
│ └─ resume: 删除 paused.flag   │     │ ├─ isPaused()         │
└───────────────┬───────────────┘     │ └─ formatStatusOutput │
                │                     └───────────────────────┘
                ▼                                 ▲
┌─────────────────────────────────────────────────┴───────────┐
│                     CloudShellManager                       │
│ ├─ 主控保活循环 (每 4 秒一个 tick):                           │
│ │   ├─ 检查 isPaused():                                     │
│ │   │   ├─ 若 true:                                         │
│ │   │   │   • 跳过 performActiveMicroActions (静止鼠标/滚动) │
│ │   │   │   • 跳过 rotateActiveContext (不切屏)              │
│ │   │   │   • 保持 sendHeartbeat (键盘保活)                  │
│ │   │   └─ 若 false:                                        │
│ │   │       • 正常执行活跃账号微操作与自动轮换                │
│ └─ 退出钩子: 清理 paused.flag                                │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 状态持久化机制 (`StateTracker`)
- 维护标志文件：`logs/cloudshell/paused.flag`；
- 在 `state.json` 中同步记录 `antiDetectionPaused: boolean`；
- 方法扩展：
  - `setPaused(paused: boolean)`：更新 `state.json` 并创建/删除 `paused.flag`；
  - `isPaused(): boolean`：直接判断 `fs.existsSync(paused.flag)`，开销极低；
  - `clearState()`：停止时一并清理 `paused.flag`。

### 3.2 管理器循环感知 (`CloudShellManager`)
- 在主循环 `while (this._running)` 中，每轮 tick：
  - 调用 `this.isAntiDetectionPaused()`；
  - 若为 `true`：
    - 不触发 `performActiveMicroActions`；
    - 不触发 `rotateActiveContext`；
    - 维持 `tickCount % heartbeatTicks === 0` 下的 `sendHeartbeat` 与弹窗旁路检查；
  - 若为 `false`：
    - 恢复常规的活跃上下文微操作与自动轮转。

---

## 4. 容错与异常处理

1. **未启动时调用 `pause` / `resume`**：
   - 检查 PID 是否存活；若未运行，提示 `CloudShell is not running. Nothing to pause/resume.` 并退出；
2. **幂等性**：
   - 连续多次调用 `pause` 或 `resume` 保持幂等成功，不产生副作用；
3. **进程意外崩溃或停止后的状态清理**：
   - 当执行 `stop` 或进程退出捕获时，自动清理 `paused.flag`，保证下次 `start` 时默认处于干净的激活状态。

---

## 5. 测试与质量验收

1. **命令行选项与解析测试 (`test/cloudshell/options.test.js`)**：
   - 验证 `pause` 与 `resume` 子命令解析与 help 文档；
2. **状态管理器测试 (`test/cloudshell/state_tracker.test.js`)**：
   - 验证 `setPaused(true/false)` 与 `isPaused()` 文件创建删除逻辑；
   - 验证格式化输出正确展示暂停与激活状态；
3. **管理器保活循环测试 (`test/cloudshell/cloudshell_manager.test.js`)**：
   - 验证在 `isPaused === true` 时，微操作与切屏函数均未被调用；
   - 验证在 `isPaused === false` 时恢复调用；
4. **CLI 入口集成测试 (`test/cloudshell/run_cloudshell.test.js`)**：
   - 验证未运行时 `pause` / `resume` 退出码与提示；
5. **代码规范检查**：
   - `npm run lint` 和 `npm run format:check` 全绿通过。
