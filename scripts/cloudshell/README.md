# Google Cloud Shell 自动化运行工具使用文档

本项目提供了独立的 Google Cloud Shell 自动化运行脚本，基于 Playwright（Camoufox / Firefox 内核），复用项目的认证系统自动注入 Google 登录态，直达 Cloud Shell 网页终端并自动化执行指令与维持心跳保活。

---

## 目录
- [功能特性](#功能特性)
- [前置准备](#前置准备)
- [快速开始](#快速开始)
- [命令行参数详解](#命令行参数详解)
- [常见使用场景](#常见使用场景)
  - [1. 纯执行命令并退出](#1-纯执行命令并退出)
  - [2. 执行多条/复杂指令](#2-执行多条复杂指令)
  - [3. 批量执行本地脚本文件](#3-批量执行本地脚本文件)
  - [4. 打开终端并持续保活（防止 20 分钟休眠）](#4-打开终端并持续保活防止-20-分钟休眠)
  - [5. 可视化界面排查调试 (Headed 模式)](#5-可视化界面排查调试-headed-模式)
  - [6. 多账号切换](#6-多账号切换)
- [工作原理与关键机制](#工作原理与关键机制)
- [常见问题与排查 (FAQ)](#常见问题与排查-faq)

---

## 功能特性

1. **零交互认证注入**：直接加载 `configs/auth/auth-N.json` 中的 Playwright `storageState`（Cookie & LocalStorage），无需手动登录 Google 账号。
2. **反指纹与隐身伪装**：自动注入防指纹脚本，屏蔽 `navigator.webdriver` 并伪装 WebGL 与插件信息，防止自动化风控拦截。
3. **弹窗智能自动旁路**：自动侦测并点击 Cloud Shell 常见的置备弹窗、`Authorize`（授权凭据调用）、`Reconnect`（会话恢复）、服务条款等阻断弹窗。
4. **多层 Iframe 穿透定位**：自动递归穿透嵌套的 Webview/Frame 容器，精准定位 `xterm.js` 辅助输入框与终端渲染画布。
5. **拟人化按键输入**：模拟真实人类键入延迟，避免长文本一次性直接 Paste 导致的终端缓冲区丢失或换行错乱。
6. **防休眠心跳维持 (Anti-Idle)**：定时向终端下发无害键位（`Space` + `Backspace`），在不污染命令行输入的前提下刷新 Google 的空闲倒计时，防止虚拟机因 20 分钟无操作被冻结。
7. **完整的诊断支持**：支持 `--debug` 参数，在发生超时或关键节点自动将整页截图和 DOM 树保存至 `logs/cloudshell/`。

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

## 快速开始

可以通过 npm script 快捷调用：

```bash
# 查看完整帮助说明
npm run cloudshell -- --help

# 使用 0 号账号执行简单的 uname 命令
npm run cloudshell -- --cmd "uname -a"

# 打开终端并无限期保活（按 Ctrl+C 退出）
npm run cloudshell -- --keep-alive -1
```

> **提示**：通过 `npm run cloudshell -- [选项]` 传参时，`--` 是必需的，用于将后续参数原样转发给底层的 node 脚本。

---

## 命令行参数详解

| 参数项 | 默认值 | 类型 | 说明 |
| :--- | :--- | :--- | :--- |
| `-h`, `--help` | - | Flag | 显示帮助信息并退出 |
| `--auth <index>` | `0` | 整数 | 指定使用的凭据序号（对应 `configs/auth/auth-<index>.json`） |
| `--cmd <command>` | `null` | 字符串 | 终端就绪后要执行的命令字符串（支持换行符分行执行） |
| `--file <path>` | `null` | 字符串 | 读取本地 shell 脚本文件，按行依次向终端键入执行 |
| `--keep-alive <min>` | `0` | 整数 | 命令执行后的终端保活时长（分钟）。<br>• `0`：命令执行完毕后立即关闭退出；<br>• `>0`���例如 `30`，保活 30 分钟后自动退出；<br>• `-1`：无限期长驻保活，直至手动按 `Ctrl+C` 终止 |
| `--heartbeat-interval <s>` | `120` | 整数 | 保活期间发送防休眠心跳按键的间隔（秒） |
| `--headless` | 默认启用 | Flag | 无头静默模式运行（无浏览器窗口弹出） |
| `--headed` | - | Flag | 有头模式运行（弹出浏览器窗口，直观查看页面加载过程） |
| `--proxy <url>` | 读取 `.env` | 字符串 | 显式指定代理地址，例如 `http://127.0.0.1:7890`（若不指定则自动读取 `.env` 中的 `HTTPS_PROXY`） |
| `--debug` | `false` | Flag | 启用诊断导出：在完成或异常时导出截图与 HTML 到 `logs/cloudshell/` |

---

## 常见使用场景

### 1. 纯执行命令并退出
执行指定的 Bash 命令，命令发送完成后自动回收资源并退出：
```bash
npm run cloudshell -- --cmd "docker ps"
```

### 2. 执行多条/复杂指令
支持使用分号 `;`、`&&` 串联，或者直接传入换行符：
```bash
npm run cloudshell -- --cmd "cd ~ && git clone https://github.com/example/repo.git && ls -la"
```

### 3. 批量执行本地脚本文件
如果在本地准备了部署脚本（例如 `deploy.sh`）：
```bash
npm run cloudshell -- --file ./deploy.sh
```
> 脚本会逐行读取该文件，跳过空行和 `#` 开头的注释行，按顺序发送到 Cloud Shell 中执行。

### 4. 打开终端并持续保活（防止 20 分钟休眠）
Google Cloud Shell 默认在无输入约 20 分钟后会自动断开会话。如果您在远端跑了一个服务需要它一直运行：

```bash
# 场景 A：无限期长驻保活（随时可按 Ctrl+C 安全退出）
npm run cloudshell -- --keep-alive -1

# 场景 B：启动一个后台服务，并维持保活 2 小时（120 分钟）
npm run cloudshell -- --cmd "docker run -d -p 8080:80 nginx" --keep-alive 120

# 场景 C：自定义心跳间隔为 60 秒
npm run cloudshell -- --keep-alive -1 --heartbeat-interval 60
```

### 5. 可视化界面排查调试 (Headed 模式)
在初次使用或遇到页面卡住时，建议开启 `--headed` 查看真实页面渲染：
```bash
npm run cloudshell -- --headed --cmd "echo 'Hello from local'" --keep-alive 5
```

### 6. 多账号切换
如果 `configs/auth/` 目录下有多个账号凭据（如 `auth-0.json`, `auth-1.json`, `auth-2.json`）：
```bash
# 使用账号 1 启动
npm run cloudshell -- --auth 1 --cmd "whoami"

# 使用账号 2 启动
npm run cloudshell -- --auth 2 --keep-alive -1
```

---

## 工作原理与关键机制

```
┌───────���────────────────────────────────────────────────┐
│               runCloudShell.js CLI                     │
├────────────────────────────────────────────────────────┤
│ 1. 参数校验与代理配置解析 (options.js)                  │
│ 2. 读取 configs/auth/auth-N.json 凭据                 │
├────────────────────────────────────────────────────────┤
│ Playwright 浏览器引擎 (browserSetup.js)                │
│ ├─ Camoufox / Firefox 启动 (禁用 DoH 以防代理泄漏)      │
│ ├─ 注入 storageState (Cookies & Origins)               │
│ └─ addInitScript 注入隐身反指纹脚本                     │
├────────────────────────────────────────────────────────┤
│ 页面与终端控制 (CloudShellController.js)               │
│ ├─ 登录态与可用地区检测 (防止在登录页死等)              │
│ ├─ 弹窗巡检���路 (自动点击 Authorize / Reconnect)       │
│ ├─ Iframe 深度穿透检索 xterm.js 元素                   │
│ ├─ 模拟按键调度执行 (带有延迟的模拟打字)                 │
│ └─ 防休眠心跳维持 (定期发送 Space+Backspace)           │
└────────────────────────────────────────────────────────┘
```

1. **弹窗旁路逻辑**：在等待虚拟机置备期间，控制器每 1.5 秒自动扫描全页面及所有 child frames，命中常见按钮（"Authorize"、"授权"、"Reconnect"、"重新连接" 等）自动触发安全点击。
2. **防休眠原理**：Google Cloud Shell 的前端闲置计时器通过监听 DOM 键盘事件重置。脚本定时发送 `Space` 紧接 `Backspace`，既生成了有效的键盘输入事件刷新心跳，又不会导致终端光标处残留多余字符。
3. **优雅关闭**：监听系统 `SIGINT` (Ctrl+C) 和 `SIGTERM` 信号。接收到终止信号时，会先关闭心跳定时器，再逐一安全释放 BrowserContext 与 Browser 进程，防止残留僵尸进程占用内存。

---

## 常见问题与排查 (FAQ)

### Q1: 执行 `npm run cloudshell` 后立刻显示 `All operations completed successfully` 退出了？
- **原因**：这是正常现象。因为执行时没有提供 `--cmd` 或 `--file`，且 `--keep-alive` 默认为 `0`（执行完毕立即退出）。
- **解决方法**：
  - 如果需要执行指令：传入 `--cmd "你的命令"`；
  - 如果需要保持终端长久开启：传入 `--keep-alive -1`。

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
