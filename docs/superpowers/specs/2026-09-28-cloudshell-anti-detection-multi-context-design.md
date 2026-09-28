# Google Cloud Shell 拟人防检测与多 Context 轮询保活设计规范

- **日期**：2026-09-28
- **模块**：`scripts/cloudshell/`
- **状态**：已批准 (Approved)

---

## 1. 概述与背景

AIStudioToAPI 项目的 Cloud Shell 脚本主要用于利用 Google Cloud Shell 虚拟机提供稳定的长驻运行与反检测环境。原项目 `src/core/BrowserManager.js` 具备成熟的：
1. 拟人鼠标移动防检测（3段微抖动平滑移动、微滚动、左上角防挂起移动）；
2. 多 Context 管理与活跃 Context 激活/切换机制。

当前 `scripts/cloudshell/` 仅支持单账号启动，且保留了 `--cmd` 与 `--file` 指令执行逻辑。本设计将：
- 移除 `--cmd` 与 `--file`，将定位聚焦于多账号 Cloud Shell 终端长驻保活与防检测服务；
- 支持多账号同时拉起（支持 `--auth 0,1,2`、`--auth 0-3`、`--all`），并在单个 Browser 进程中维护独立的 BrowserContext；
- 实现对标原项目的防检测微操作与防休眠体系，维护当前选中的 `currentAuthIndex`（Active Context）；
- 支持定期自动轮询切换 Active Context（`--switch-interval`，默认 10 分钟），轮换激活各个账号的终端。

---

## 2. 命令行参数体系 (CLI Options)

### 2.1 彻底移除的参数
- `--cmd <command>`：已废弃并移除，不再支持命令行下发执行代码。
- `--file <path>`：已废弃并移除，不再支持读取文件执行代码。

### 2.2 参数定义与规则

| 参数项 | 默认值 | 类型 | 说明 |
| :--- | :--- | :--- | :--- |
| `-h`, `--help` | - | Flag | 显示帮助信息并退出 |
| `--auth <indices>` | `[0]` | 字符串/数组 | 账号索引。支持：`0`、`0,1,2`、`0-3`。若未传且未指定 `--all`，默认启动 `[0]` |
| `--all` | `false` | Flag | 自动扫描 `configs/auth/auth-N.json` 目录下的所有有效凭据并全部拉起 |
| `--switch-interval <min>` | `10` | 正整数 | 轮询切换 Active Context 的周期（分钟）。多账号时生效 |
| `--keep-alive <min>` | `-1` | 整数 | 保活总时长（分钟）。`-1` 表示无限期长驻（Ctrl+C 安全退出），`>0` 为指定分钟 |
| `--heartbeat-interval <s>` | `120` | 正整数 | 键盘心跳（`Space` + `Backspace`）间隔（秒） |
| `--headless [true\|false]` | `true` | 布尔/Flag | 是否无头模式运行。支持 `--headless false` |
| `--headed` | - | Flag | 有头模式运行（等价于 `--headless false`） |
| `--proxy <url>` | 读 `.env` | 字符串 | 代理地址，若未传则读取 `.env` 中 `HTTPS_PROXY` |
| `--debug` | `false` | Flag | 异常或关键节点保存截图与 HTML DOM 快照至 `logs/cloudshell/` |

---

## 3. 架构设计与核心组件职责

```
┌─────────────────────────────────────────────────────────────┐
│                   runCloudShell.js (CLI)                    │
│   解析参数 (--auth / --all / --switch-interval / --keep-alive) │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 CloudShellManager (新增管理器)               │
│ ├─ browser: 单例 Playwright Firefox 实例 (带隐私防指纹设置)    │
│ ├─ contexts: Map<authIndex, ContextSession>                 │
│ │   └─ ContextSession: { context, page, controller }        │
│ ├─ currentAuthIndex: 当前选中的 Active Context 索引         │
│ ├─ authIndices: 当前维护的所有账号列表                        │
│ ├─ 轮询调度器 (Switching Scheduler): 每 N 分钟轮换上下文       │
│ └─ 保活与微操作守护服务 (Health & Keep-Alive Loop)          │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│            CloudShellController (页面与防休眠控制器)         │
│ ├─ 登录态与可用地区检测 (checkPageStatus)                    │
│ ├─ 弹窗智能旁路 (bypassModalsOnce: Authorize/Reconnect)     │
│ ├─ 拟人鼠标移动算法 (simulateHumanMovement: 3段微抖动平滑移动) │
│ ├─ 终���就绪等待 + 防检测微动作                                │
│ └─ 键盘心跳 (sendHeartbeat: Space + Backspace)              │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 `CloudShellManager` 职责
1. **多账号会话编排**：
   - 启动单个共享的 `browser` 实例；
   - 依次或并发为每一个 `authIndex` 加载对应 `configs/auth/auth-N.json` 创建独立 `BrowserContext`，并初始化对应 `Page` 和 `CloudShellController`；
   - 驱动每个账号完成 `navigate()` 与 `waitForTerminalReady()`。
2. **活跃上下文管理 (Active Context)**：
   - 初始将 `currentAuthIndex` 指向 `authIndices[0]`；
   - 激活时调用 `page.bringToFront()`，并模拟前台用户聚焦操作。
3. **轮询切换调度 (Rotation Switcher)**：
   - 当 `authIndices.length > 1` 时，定时器每隔 `switchIntervalMinutes` 触发一次：
     - `nextIndex = authIndices[(currentIndex + 1) % authIndices.length]`；
     - 输出友好切换日志：`🔄 [CloudShell] Switching active context from #${currentAuthIndex} to #${nextIndex}...`；
     - 调用目标页面的 `page.bringToFront()`；
     - 立即触发一次鼠标微操作���键盘心跳；
     - 更新 `currentAuthIndex = nextIndex`。
4. **统一生命周期与退出清理**：
   - 监听 `SIGINT` 与 `SIGTERM`，停止所有定时器，优雅关闭所有 `BrowserContext` 并关闭 `browser` 进程。

### 3.2 `CloudShellController` 防检测与防休眠能力
1. **拟人化鼠标移动算法 (`simulateHumanMovement(page, targetX, targetY)`)**：
   - 将轨迹分成 3 个 segments；
   - 前两段添加随机偏移偏差：`intermediate = target + (Math.random() - 0.5) * (100 / i)`；
   - 第三段精准落在 `(targetX, targetY)`；
   - 调用 `page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 5) })`。
2. **等待终端就绪期间的防检测**：
   - 在 `waitForTerminalReady` 循环中，每轮有 30% 概率执行一次视口随机范围内的拟人移动，防止长时间静止被 Google 检测。
3. **微操作防检测 (Micro-Actions in Keep-Alive)**：
   - 针对当前 `Active Context`：
     - 每 4 秒一次微操作 tick（30% 概率触发微滚动 + 视口内平滑随机移动）；
     - 每 15 个 tick（约 60 秒）执行平滑移动至 `(1, 1)`（防止终端前端挂起）。
   - 针对所有 Context（包括 Background）：
     - 周期性执行弹窗旁路检查；
     - 按照 `heartbeatIntervalSeconds` 发送键盘心跳 `Space` + `Backspace`。

---

## 4. 容错与异常处理

1. **凭据异常**：
   - 若用户传入的某个账号凭据不存在或损坏，启动阶段捕获明确报错（如 `Auth file configs/auth/auth-N.json does not exist`）并中断或提示。
2. **单账号异常隔离**：
   - 某账号页面意外崩溃或关闭时，打印告警，将其从轮换列表 `authIndices` 中标记摘除，保证其他健康账号不受影响。
3. **优雅退出**：
   - 确保 `SIGINT` (Ctrl+C) 触发时，清理定时器并无泄漏关闭 Playwright 进程。

---

## 5. 测试与验证策略

1. **选项与解析测试 (`test/cloudshell/options.test.js`)**：
   - 验证 `--auth 0`、`--auth 0,1,2`、`--auth 0-2`、`--all` 的解析逻辑；
   - 验证 `--switch-interval` 默认值与自定义参数解析；
   - 验证 `--cmd` 和 `--file` 的移除与兼容表现。
2. **多 Context 调度与管理器单元测试 (`test/cloudshell/cloudshell_manager.test.js`)**：
   - Mock Playwright Page/Context，验证 `CloudShellManager` 多 context 初始化流程；
   - 验证定时器触发时 `currentAuthIndex` 的正确轮转，以及 `bringToFront()` 的调用；
   - 验证防检测鼠标移动的调用及异常容错。
3. **命令行端到端冒烟测试 (`test/cloudshell/run_cloudshell.test.js`)**：
   - 验证 `--help` 输出更新���的参数说明，不再包含 `--cmd` 和 `--file`；
   - 验证多账号启动失败或成功的 CLI 退出码。
4. **代码质量验证**：
   - `npm run lint` 和 `npm run format:check` 全绿通过。
