# Google Cloud Shell 管理命令（CLI / Daemon）设计规范

- **日期**：2026-09-28
- **模块**：`scripts/cloudshell/`
- **状态**：已批准 (Approved)

---

## 1. 概述与目标

随着 Cloud Shell 脚本升级为支持多账号并发长驻与拟人化防检测，需要将其由原来的前台阻塞脚本封装为完备的**管理命令工具（Management CLI / Daemon Controller）**，支持：
1. **`start`**：支持后台守护模式（Daemon，默认）与前台调试模式（`--foreground` / `--headed`）启动多账号 Cloud Shell；
2. **`status`**：查看当前管理器的运行状态、PID、已运行时长、当前活跃（Active）选中的账号、全部在线账号及其最后心跳时间；
3. **`stop`**：安全下发终止信号，优雅关闭所有浏览器上下文并退出；
4. **`restart`**：快捷重启守护进程；
5. **`logs`**：查看后台日志，支持流式跟踪（`-f` / `--follow`）。

---

## 2. 命令行子命令与参数规范 (CLI & Subcommands)

统一入口为 `scripts/cloudshell/runCloudShell.js`，通过 `npm run cloudshell -- <command> [options]` 调用。

### 2.1 子命令定义

| 子命令 | 说明 | 主要参数 |
| :--- | :--- | :--- |
| `start` | 启动 Cloud Shell 管理器（默认后台运行） | `--auth`, `--all`, `--switch-interval`, `--heartbeat-interval`, `--keep-alive`, `--foreground`, `--headed`, `--proxy`, `--debug` |
| `status` | 查看当前后台守护进程状态与在线账号详情 | 无 |
| `stop` | 停止当前正在运行的后台守护进程 | `--force`（可选，直接强杀） |
| `restart` | 重启后台守护进程 | 继承 `start` 的参数 |
| `logs` | 查看后台日志 `logs/cloudshell/daemon.log` | `-f`, `--follow`（持续流式跟踪） |

### 2.2 参数规则与默认值

- **`--foreground` / `-f`**：在前台运行进程并直接输出日志（默认后台模式）。若指定了 `--headed`，则自动开启 `--foreground`。
- **`--auth <indices>`**：指定启动的账号列表（如 `0,1,2` 或 `0-3`，默认 `0`）。
- **`--all`**：自动扫描拉起所有 `configs/auth/auth-N.json`。
- **`--switch-interval <min>`**：Active Context 轮换间隔（默认 `10` 分钟）。
- **`--keep-alive <min>`**：保活总时长（默认 `-1` 表示无限长驻）。
- **未指定子命令**：若用户未指定子命令（如 `npm run cloudshell`），默认执行 `status` 并提示可用命令帮助。

---

## 3. 架构设计与核心组件职责

```
┌─────────────────────────────────────────────────────────────┐
│                 runCloudShell.js (CLI Dispatcher)           │
│         解析子命令: start / stop / status / restart / logs    │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────────┐     ┌───────────────────────┐
│     DaemonManager (进程管理)    │     │   StateTracker (状态) │
│ ├─ startDaemon (spawn后台脱离) │     │ ├─ logs/.../state.json│
│ ├─ stopDaemon (SIGTERM/KILL)  │     │ ├─ 原子写入与安全读取  │
│ ├─ isProcessAlive (kill -0)   │     │ └─ 格式化状态终端输出 │
│ └─ tailLogs (跟踪 daemon.log)  │     └───────────────────────┘
└───────────────┬───────────────┘                 ▲
                │ (拉起 / 前台执行)                  │ (实时上报)
                ▼                                 │
┌─────────────────────────────────────────────────┴───────────┐
│                     CloudShellManager                       │
│ ├─ Browser 单例与多 BrowserContext 会话                      │
│ ├─ 轮询调度器 (定时切换 Active Context)                      │
│ ├─ 双层防休眠守护与微操作 (performActiveMicroActions)         │
│ └─ 退出钩子: 清理 state.json 与 daemon.pid                   │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 核心组件划分

1. **`scripts/cloudshell/options.js`**：
   - 增加一级子命令（`command`: `'start' | 'stop' | 'status' | 'restart' | 'logs'`）的���析，保持对各选项的原生支持；
   - 提供子命令专属的友好帮助文档。
2. **`scripts/cloudshell/stateTracker.js`**：
   - 维护状态持久化文件 `logs/cloudshell/state.json`；
   - 提供状态写入（`saveState(data)`）与状态读取（`loadState()`）能力；
   - 提供格式化终端展示函数 `printFormattedStatus(state, isAlive)`。
3. **`scripts/cloudshell/daemonManager.js`**：
   - 维护 PID 锁文件 `logs/cloudshell/daemon.pid`；
   - `startDaemon(options)`：若后台启动，打开 `logs/cloudshell/daemon.log`，通过 `child_process.spawn` 派生独立脱离进程并 `unref()`；
   - `stopDaemon(force = false)`：读取 PID，发送 `SIGTERM`，循环等待退出；超时 10 秒则回退至 `SIGKILL`；
   - `isProcessAlive(pid)`：通过 `process.kill(pid, 0)` 验证进程是否健在；
   - `tailLogs(follow = false)`：读取或流式查看 `daemon.log`。
4. **`scripts/cloudshell/CloudShellManager.js`**：
   - 集成 `stateTracker`，在各个账号就绪、切换活跃账号、心跳更新时同步持久化；
   - 退出时标记状态为 `stopped` 并清理 PID 文件。

---

## 4. 状态持久化契约 (State Contract)

状态文件路径：`logs/cloudshell/state.json`
PID 文件路径：`logs/cloudshell/daemon.pid`
日志文件路径：`logs/cloudshell/daemon.log`

```json
{
  "pid": 12345,
  "startedAt": "2026-09-28T06:00:00.000Z",
  "status": "running",
  "currentAuthIndex": 0,
  "switchIntervalMinutes": 10,
  "heartbeatIntervalSeconds": 120,
  "lastSwitchAt": "2026-09-28T06:00:00.000Z",
  "accounts": [
    {
      "authIndex": 0,
      "accountName": "user0@gmail.com",
      "status": "active",
      "lastHeartbeatAt": "2026-09-28T06:04:00.000Z"
    },
    {
      "authIndex": 1,
      "accountName": "user1@gmail.com",
      "status": "ready",
      "lastHeartbeatAt": "2026-09-28T06:03:50.000Z"
    }
  ]
}
```

---

## 5. 测试与质量验收

1. **命令行参数与子命令解析测试** (`test/cloudshell/options.test.js`)：
   - 验证 `start`、`stop`、`status`、`restart`、`logs` 子命令及其选项解析；
   - 验证无子命令时回退为 `status`。
2. **状态管理器单元测试** (`test/cloudshell/state_tracker.test.js`)：
   - 验证状态保存、更新账号状态、异常状态文件的回退处理；
   - 验证格式化终端状态输出。
3. **守护进程管理器单元测试** (`test/cloudshell/daemon_manager.test.js`)：
   - 验证后台进程拉起逻辑（Mock `child_process.spawn`）；
   - 验证已在运行时重复启动的阻止保护；
   - 验证停止逻��（信号发送与超时处理）。
4. **端到端冒烟测试** (`test/cloudshell/run_cloudshell.test.js`)：
   - 验证无进程运行时执行 `status` 输出 `Stopped`；
   - 验证 `--help` 输出新的子命令用法。
5. **代码规范与全套测试**：
   - 执行 `npm run lint` 和 `npm run format:check`；
   - 执行 `npx jest test/cloudshell/` 确保全部测试通过。
