# Google Cloud Shell 自动化运行工具使用文档

本项目提供了独立的 Google Cloud Shell 自动化运行脚本，基于 Playwright（Camoufox / Firefox 内核），复用项目的认证系统自动注入 Google 登录态，直达 Cloud Shell 网页终端并提供拟人化防检测机制、多账号并发长驻与活跃上下文定时轮流切换。

---

## 目录

- [功能特性](#功能特性)
- [前置准备](#前置准备)
- [快速开始与管理子命令](#快速开始与管理子命令)
  - [1. 启动守护进程 (start)](#1-启动守护进程-start)
  - [2. 查询运行状态 (status)](#2-查询运行状态-status)
  - [3. 查看实时日志 (logs)](#3-查看实时日志-logs)
  - [4. 停止运行 (stop)](#4-停止运行-stop)
  - [5. 临时暂停防检测微操作 (pause)](#5-临时暂停防检测微操作-pause)
  - [6. 恢复防检测保活循环 (resume)](#6-恢复防检测保活循环-resume)
  - [7. 重启服务 (restart)](#7-重启服务-restart)
- [命令行参数详解](#命令行参数详解)
- [常见使用场景](#常见使用场景)
  - [1. 单账号长驻保活](#1-单账号长驻保活)
  - [2. 多账号并发与定时自动轮换](#2-多账号并发与定时自动轮换)
  - [3. 全量账号自动发现长驻 (--all)](#3-全量账号自动发现长驻---all)
  - [4. 可视化界面排查调试 (Headed 模式)](#4-可视化界面排查调试-headed-模式)
  - [5. 自定义心跳与轮换间隔](#5-自定义心跳与轮换间隔)
  - [6. 临时手动排查与恢复 (Manual Mode)](#6-临时手动排查与恢复-manual-mode)
- [工作原理与关键机制](#工作原理与关键机制)
- [常见问题与排查 (FAQ)](#常见问题与排查-faq)

---

## 功能特性

1. **零交互认证注入**：直接加载 `configs/auth/auth-N.json` 中的 Playwright `storageState`（Cookie & LocalStorage），无需手动登录 Google 账号。
2. **后台守护进程（Daemon）脱离运行**：`start` 默认派生独立后台进程，关闭终端或断开 SSH 会话不影响 Cloud Shell 长驻运行，PID 写入 `logs/cloudshell/daemon.pid`。
3. **运行时状态持久化与可视化查询**：通过 `status` 命令查看守护进程 PID、运行时间（Uptime）、活跃账号与各账号最后心跳时间。
4. **反指纹与隐身伪装**：自动注入防指纹脚本，屏蔽 `navigator.webdriver` 并伪装 WebGL 与插件信息，防止自动化风控拦截。
5. **拟人化鼠标移动防检测**：复刻 3 段带随机抖动的平滑步进拟人化鼠标移动算法，打破机械化自动化特征。
6. **双层防休眠长驻守护**：
   - **活跃上下文 (Active Context)**：每 4 秒运行一次微操作轮询，30% 概率触发视口微滚动与随机坐标拟人移动，每 15 个 tick 平滑回归左上角 `(1, 1)` 重置倒计时；
   - **全量上下文 (All Contexts)**：按 `--heartbeat-interval` 周期性向终端下发无害键位（`Space` + `Backspace`），并扫描穿透阻断弹窗。
7. **多账号并发与自动轮换**：单例浏览器下支持多 `BrowserContext` 并发管理，支持 `--auth 0,1,2`、`--auth 0-3` 与 `--all` 自动扫描，多账号启动自动注入 1~3 秒随机退避打散以消除并发指纹，按 `--switch-interval` 自动轮流切换活跃上下文并调用 `bringToFront()` 唤醒。
8. **阻断弹窗拟人化物理旁路与回退**：自动侦测 Cloud Shell 常见的置备弹窗、`Authorize`（授权凭据调用）、`Reconnect`（会话恢复）、服务条款等阻断弹窗，升级为视口坐标扰动、拟人平滑逼近、物理按下释放与效果校验；若物理点击未生效则优雅回退至 DOM JS 强制点击兜底。
9. **多层 Iframe 穿透定位**：自动递归穿透嵌套的 Webview/Frame 容器，精准定位 `xterm.js` 辅助输入框与终端渲染画布。
10. **完整的诊断支持**：支持 `--debug` 参数，在发生超时或关键节点自动将整页截图和 DOM 树保存至 `logs/cloudshell/`。

---

## 前置准备

在运行 Cloud Shell 脚本前，请确保至少存在一个有效的认证凭据：

- 凭据文件存放于项目根目录：`configs/auth/auth-0.json`（或 `auth-1.json`、`auth-2.json`...）。
- 若尚未配置或凭据已失效，请先运行认证录入命令：
  ```bash
  npm run save-auth
  # 或使用辅助向导
  npm run setup-auth
  ```

---

## 快速开始与管理子命令

可以通过 npm script 快捷调用完整的管理命令：`start`、`status`、`stop`、`restart`、`logs`、`pause`、`resume`。若未传子命令，默认执行 `status` 并打印帮助。

### 1. 启动守护进程 (start)

`start` 默认以守护进程（Daemon）在后台运行，输出重定向至 `logs/cloudshell/daemon.log`：

```bash
# 启动 0 号账号后台长驻
npm run cloudshell -- start --auth 0

# 启动 0, 1, 2 三个账号后台并发轮换
npm run cloudshell -- start --auth 0-2 --switch-interval 15

# 全量账号后台启动
npm run cloudshell -- start --all

# 前台阻塞运行（通过 --foreground 或 -f）
npm run cloudshell -- start --auth 0 --foreground

# 有头可视化窗口调试（自动在前台阻塞运行）
npm run cloudshell -- start --auth 0 --headed
```

### 2. 查询运行状态 (status)

查看当前后台守护进程状态、防检测模式、多账号自动切屏状态、运行时长、当前活跃账号及各账号心跳：

```bash
npm run cloudshell -- status
# 或直接不带参数（默认执行 status）
npm run cloudshell
```

输出示例（正常激活状态）：

```text
==================================================
Cloud Shell Status: Running (PID: 12345)
Anti-Detection:     ▶️ Active (Enabled)
Auto-Rotation:      ▶️ Active (Every 10 min)
Started At:         2026-09-28T06:00:00.000Z
Uptime:             2h 15m 30s
Switch Interval:    10 min
Current Active:     Auth 0
--------------------------------------------------
Accounts:
* [Auth 0] user1@gmail.com | Status: Active (Heartbeat: 2026-09-28T08:15:20.000Z)
  [Auth 1] user2@gmail.com | Status: Ready (Heartbeat: 2026-09-28T08:14:50.000Z)
==================================================
```

输出示例（暂停手动模式）：

```text
==================================================
Cloud Shell Status: Running (PID: 12345)
Anti-Detection:     ⏸️ Paused (Manual Mode)
Auto-Rotation:      ⏸️ Paused
Started At:         2026-09-28T06:00:00.000Z
Uptime:             2h 15m 30s
Switch Interval:    10 min
Current Active:     Auth 0
--------------------------------------------------
Accounts:
* [Auth 0] user1@gmail.com | Status: Active (Heartbeat: 2026-09-28T08:15:20.000Z)
  [Auth 1] user2@gmail.com | Status: Ready (Heartbeat: 2026-09-28T08:14:50.000Z)
==================================================
```

### 3. 查看实时日志 (logs)

查看或持续追踪后台守护进程的输出日志：

```bash
# 查看末尾日志
npm run cloudshell -- logs

# 实时流式追踪日志（类似 tail -f）
npm run cloudshell -- logs -f
```

### 4. 停止运行 (stop)

向后台守护进程发送 `SIGTERM` 优雅关闭信号，清理资源后退出：

```bash
# 优雅停止（等待资源释放）
npm run cloudshell -- stop

# 强制立即停止（SIGKILL）
npm run cloudshell -- stop --force
```

### 5. 临时暂停防检测微操作 (pause)

当需要在 Cloud Shell 终端或通过 Headed 窗口临时进行手动排查、键入长命令或调试时，拟人鼠标晃动和自动切屏可能会干扰正常操作。可执行 `pause` 暂停这些动作，将控制权完全留给用户，同时后台仍保留键盘心跳保活：

```bash
npm run cloudshell -- pause
```

输出示例：

```text
⏸️ [CloudShell] Anti-detection mouse movements & auto-rotation have been PAUSED.
   You can now safely perform manual operations without mouse interruption.
   Run 'npm run cloudshell -- resume' when you are finished.
```

### 6. 恢复防检测保活循环 (resume)

在手动操作或排查完成后，执行 `resume` 恢复拟人鼠标移动、微滚动与多账号定时自动切屏：

```bash
npm run cloudshell -- resume
```

输出示例：

```text
▶️ [CloudShell] Anti-detection mouse movements & auto-rotation have been RESUMED.
```

### 7. 重启服务 (restart)

停止当前运行中的后台进程，并使用新参数重新启动守护进程：

```bash
npm run cloudshell -- restart --all
```

---

## 命令行参数详解

| 参数项                     | 默认值      | 类型        | 说明                                                                                                                                                                   |
| :------------------------- | :---------- | :---------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-h`, `--help`             | -           | Flag        | 显示帮助信息并退出                                                                                                                                                     |
| `-f`, `--foreground`       | `false`     | Flag        | 在前台阻塞运行（仅用于 `start` 子命令）                                                                                                                                |
| `-f`, `--follow`           | `false`     | Flag        | 实时追踪日志输出（仅用于 `logs` 子命令）                                                                                                                               |
| `--force`                  | `false`     | Flag        | 强制立即终止进程（仅用于 `stop` 子命令）                                                                                                                               |
| `--auth <indices>`         | `0`         | 字符串/范围 | 认证序号或范围（支持单数字 `0`、逗号分隔 `0,1,2`、短横线范围 `0-3`）                                                                                                   |
| `--all`                    | `false`     | Flag        | 自动扫描并加载 `configs/auth/auth-N.json` 中的所有账号凭据                                                                                                             |
| `--switch-interval <min>`  | `10`        | 整数        | 多账号轮换活跃上下文的间隔（分钟）                                                                                                                                     |
| `--keep-alive <min>`       | `-1`        | 整数        | 终端保活时长（分钟）。<br>• `-1`：无限期长驻保活（默认），直至手动终止；<br>• `>0`：例如 `60`，保活 60 分钟后自动退出；<br>• `0`：初始化完成并就绪后退出               |
| `--heartbeat-interval <s>` | `120`       | 整数        | 所有上下文发送防休眠心跳按键与旁路弹窗的周期（秒）                                                                                                                     |
| `--headless [true\|false]` | `true`      | 布尔/Flag   | 是否以无头模式运行。<br>• 默认 `true`（静默后台运行）；<br>• 支持显式传参 `--headless false` 或 `--headless=false` 本地弹出窗口调试；<br>• 也可直接使用简写 `--headed` |
| `--headed`                 | -           | Flag        | 有头模式运行（快捷方式，等价于 `--headless false`，自动在前台运行）                                                                                                    |
| `--proxy <url>`            | 读取 `.env` | 字符串      | 显式指定代理地址，例如 `http://127.0.0.1:7890`（若不指定则自动读取 `.env` 中的 `HTTPS_PROXY`）                                                                         |
| `--debug`                  | `false`     | Flag        | 启用诊断导出：在完成或异常时导出截图与 HTML 到 `logs/cloudshell/`                                                                                                      |

---

## 常见使用场景

### 1. 单账号长驻保活

启动单个指定账号后台守护保活（默认无限期长驻）：

```bash
npm run cloudshell -- start --auth 0
```

### 2. 多账号并发与定时自动轮换

启动多个账号，后台独立运行各自会话，并在后台按 `--switch-interval` 自动轮转活跃页面：

```bash
# 逗号分隔
npm run cloudshell -- start --auth 0,2,3

# 范围语法（启动 0, 1, 2, 3 号账号，每 15 分钟轮换一次）
npm run cloudshell -- start --auth 0-3 --switch-interval 15
```

### 3. 全量账号自动发现长驻 (--all)

自动扫描 `configs/auth/` 目录下的所有 `auth-N.json` 文件并全部拉起后台并发保活：

```bash
npm run cloudshell -- start --all
```

### 4. 可视化界面排查调试 (Headed 模式)

在初次使用或排查页面状态时，建议开启有头模式观察页面实际渲染与拟人移动（在前台阻塞运行，按 Ctrl+C 退出）：

```bash
# 方式 A：使用快捷参数 --headed
npm run cloudshell -- start --auth 0 --headed

# 方式 B：使用显式传参 --headless false
npm run cloudshell -- start --all --headless false
```

### 5. 自定义心跳与轮换间隔

自定义每 60 秒发送一次心跳按键，每 5 分钟轮换一次活跃账号，保活 120 分钟后自动退出：

```bash
npm run cloudshell -- start --auth 0-2 --heartbeat-interval 60 --switch-interval 5 --keep-alive 120
```

### 6. 临时手动排查与恢复 (Manual Mode)

在多账号后台保活或前台调试期间，若需要手动在 Cloud Shell 终端键入长命令、排查报错或查看环境状态：

1. **暂停自动微操作**：
   ```bash
   npm run cloudshell -- pause
   ```
   此时页面自动切屏与鼠标晃动将立即静止，后台基础键盘心跳与弹窗旁路继续保留。
2. **执行手动排查**：在终端窗口中安心执行手动输入与调试，无鼠标夺取或窗口跳出干扰。
3. **恢复自动化保活**：
   ```bash
   npm run cloudshell -- resume
   ```
   微操作与定时切屏立即恢复调度。

---

## 工作原理与关键机制

```
┌────────────────────────────────────────────────────────┐
│               runCloudShell.js CLI                     │
├────────────────────────────────────────────────────────┤
│ 1. 参数校验与多账号解析 (options.js)                    │
│ 2. 单例 Playwright 浏览器启动 (browserSetup.js)         │
├────────────────────────────────────────────────────────┤
│ 多 Context 保活与轮换管理器 (CloudShellManager.js)       │
│ ├─ 为每个账号创建独立 BrowserContext & 注入 storageState │
│ ├─ 多账号拉起注入 1~3 秒随机退避打散消除并发指纹        │
│ ├─ 注入隐身反指纹脚本                                   │
│ ├─ 初始化各个 Context 并通过 Controller 等待终端就绪      │
│ └─ 启动主控循环：                                       │
│    • 每 4 秒活跃上下文微操作 (微滚动 + 拟人平滑鼠标抖动) │
│    • 每 15 ticks 活跃上下文归位 (1, 1) 防休眠           │
│    • 每 heartbeatInterval 发送 Space+Backspace 与弹窗旁路│
│    • 每 switchInterval 自动轮流切换 active context      │
├────────────────────────────────────────────────────────┤
│ 页面与终端控制 (CloudShellController.js)               │
│ ├─ 登录态与可用地区检测 (防止在登录页死等)              │
│ ├─ 3 段平滑拟人化鼠标移动算法 (simulateHumanMovement)   │
│ ├─ 阻断弹窗拟人物理点击与优雅回退 (clickElementSimulated)│
│ ├─ Iframe 深度穿透检索 xterm.js 元素                   │
│ └─ 防休眠心跳维持 (定期发送 Space+Backspace)           │
└────────────────────────────────────────────────────────┘
```

1. **多账号启动随机退避**：当存在多个账号并发拉起时，管理器在初始化第 2 个及后续账号前，自动注入 1~3 秒随机等待退避，避免多账号并发瞬间同时建立 WebSocket/HTTP 连接产生机械并发指纹特征。
2. **拟人化鼠标移动**：算法将位移路径划分为 3 段，各段附带递减的随机偏移扰动与 5~10 步平滑内插步进，并在最终步精准命中目标，模拟真实人类手部微晃轨迹。
3. **阻断弹窗拟人物理点击与优雅回退**：对所有阻断弹窗（`Authorize` 授权、`Reconnect` 重新连接、服务条款等），自动获取按钮视口绝对坐标并加入 30%~70% 中心区域微扰动，通过平滑轨迹逼近、手部反应悬停（150~300ms）、物理按下松开（150~350ms）后校验按钮是否消失；若因视口遮挡或未生效，自动优雅回退至 DOM JS 强制点击兜底。
4. **活跃与后台双层防护**：
   - 活跃上下文享有更高权重的交互模拟（随机滚动与随机轨迹），并在每 15 个 tick（约 1 分钟）平滑滑动至左上角 `(1, 1)` 重置 Google 的活动检测器；
   - 后台所有上下文均保持定时终端心跳按键（`Space` + `Backspace`）与阻断弹窗拟人旁路巡检。
5. **优雅关闭**：监听系统 `SIGINT` (Ctrl+C) 和 `SIGTERM` 信号。接收到终止信号时，安全释放所有 BrowserContext 与 Browser 进程，防止残留僵尸进程占用内存。

---

## 常见问题与排查 (FAQ)

### Q1: 为什么 `--cmd` 和 `--file` 参数被移除了？

- **说明**：Cloud Shell 脚本目前专注于**多账号拟人防检测并发长驻与保活**。如需执行自定义脚本或命令，建议在长驻终端就绪后直接在 Cloud Shell 环境中进行交互或设置自启动服务。

### Q2: 报错 `Auth file configs/auth/auth-0.json does not exist`？

- **解决方法**：说明本地还没有保存账号 0 的登录凭据。请先执行 `npm run save-auth` 录入并保存该账号的认证文件。

### Q3: 报错 `AuthExpiredError: Google authentication has expired`？

- **解决方法**：说明该账号在 Google 端的 Session/Cookie 已经失效（已被登出）。请重新执行 `npm run save-auth -- --auth 0` 重新登录更新凭据。

### Q4: 报错 `RegionBlockedError: Google Cloud Shell is not available in the current region/IP`？

- **解决方法**：Google Cloud Shell 对某些地区或低信誉 IP 有访问限制。请在 `.env` 中配置干净优质的海外代理服务器（设置 `HTTPS_PROXY=...`），或使用 `--proxy http://127.0.0.1:7890` 传入可用代理。

### Q5: 终端一直卡在 `Waiting for Cloud Shell machine provisioning...` 直至超时？

- **排查步骤**：
  1. 加上 `--debug` 重新执行，超时后脚本会自动将页面截图和 HTML 源码保存至 `logs/cloudshell/`，查看截图确认卡在哪一步；
  2. 加上 `--headed` 观察页面是否有全新的 Google 未识别弹窗（例如项目选择弹窗或新型用户协议），确认是否需要手动点击或更新旁路选择器。
