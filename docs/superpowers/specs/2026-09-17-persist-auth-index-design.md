# 账号启动序号持久化与记忆续跑设计方案 (Persist Auth Index on Restart)

## 1. 概述与目标

在 AIStudioToAPI 服务重启后，默认总是从 0 号账号（或第一个可用账号）开始初始化启动。当用户配置了较多账号且发生服务升级、容器重启或系统意外中断时，会导致前端账号频繁被重置回第一个，无法均衡利用后续账号的额度。

**目标**：
在系统每次激活或切换账号时，实时持久化记录当前正在使用的账号序号。在服务重启时优先接续上次记录的账号序号继续启动；若记录的账号已失效或不存在，自动顺延至下一个可用账号。

---

## 2. 核心架构与职责分工

### 2.1 新增模块 `src/core/AuthStateTracker.js`
参考项目中 `ModelUsageTracker` 的设计规范，新增轻量级状态追踪模块 `AuthStateTracker`：
- **持久化文件路径**：`data/auth-state.json`
- **数据结构**：
  ```json
  {
    "lastActiveAuthIndex": 2,
    "updatedAt": "2026-09-17T08:30:00.000Z"
  }
  ```
- **核心方法**：
  - `getLastAuthIndex()`: 安全读取并校验已保存的序号，文件损坏或缺失时安全返回 `null`。
  - `saveLastAuthIndex(authIndex)`: 安全持久化当前序号（自动创建 `data/` 目录，异常静默捕获记录 Warn 日志）。
  - `resolveStartupIndex({ availableIndices, rotationIndices, canonicalIndexGetter, envInitialIndex })`:
    统一裁决启动序号与顺延逻辑。

### 2.2 启动优先级与顺延算法

启动序号决策优先级：
1. **优先级 1：上次持久化序号（记忆续跑）**
   - 若持久化文件中记录的 `lastActiveAuthIndex` 在可用轮换池 `rotationIndices` 中：直接选用。
   - 若是重复账号（已被合并到 canonical 账号）：转换为对应的规范序号选用。
   - **顺延逻辑**：若 `lastActiveAuthIndex` 不在可用轮换池中（例如文件被删除或标记 expired）：
     - 将可用轮换池按数字升序排序 `sorted = [...rotationIndices].sort((a, b) => a - b)`；
     - 寻找首个大于 `lastActiveAuthIndex` 的账号 `candidate = sorted.find(idx => idx > lastActiveAuthIndex)`；
     - 若找不到（说明已是末尾或超出当前最大序号），则回绕取 `sorted[0]`；
     - 输出日志记录顺延过程。
2. **优先级 2：环境变量 `INITIAL_AUTH_INDEX`**
   - 当无持久化记录时（首次运行），检查环境变量 `INITIAL_AUTH_INDEX`。
   - 若有效且存在于可用池，则以此为起始。
3. **优先级 3：默认保底**
   - 可用轮换池中的首个账号。

### 2.3 实时落盘与 Hook 点
- **位置**：`BrowserManager._activateContext(ctx, pg, authIndex)`
- **原因**：这是账号上下文被真正激活的唯一核心收口点。不管是首次启动、故障重试、使用量达到阈值自动轮换（`AuthSwitcher`），还是并发模式下的智能调度（`AccountScheduler`），最终都调用 `_activateContext`。
- **效果**：每次账号激活立即写入，即使机器断电或 Docker 容器被 `SIGKILL`，重启后也能精准接回。

---

## 3. 详细设计与改动点

### 3.1 `src/core/AuthStateTracker.js`
- 封装 `data/auth-state.json` 的安全读写。
- 引入原子写入逻辑（写入临时文件后 `fs.renameSync` 或直接覆盖），防止断电产生半截 JSON 损坏。
- 提供完整容错能力，绝不因文件读写异常阻断主服务。

### 3.2 `src/core/BrowserManager.js`
- 增加方法 `setAuthStateTracker(tracker)` 接收注入。
- 在 `_activateContext(ctx, pg, authIndex)` 中调用 `this.authStateTracker?.saveLastAuthIndex(authIndex)`。

### 3.3 `src/core/ProxyServerSystem.js`
- 在构造函数中初始化 `this.authStateTracker = new AuthStateTracker(this.logger);`。
- 注入至 `this.browserManager.setAuthStateTracker(this.authStateTracker);`。
- 在 `start(initialAuthIndex)` 中，通过 `authStateTracker.resolveStartupIndex(...)` 计算最终启动序号并据此调整 `startupOrder`。

---

## 4. 容错与边界场景分析

1. **首次部署运行（无 `data/auth-state.json`）**：
   - 安全返回 `null`，无缝回退到环境变量 `INITIAL_AUTH_INDEX` 或第 0 个账号。
2. **文件损坏（JSON 格式非法或空文件）**：
   - `JSON.parse` 报错被 `try-catch` 捕获，记录警告日志后视为无历史记录，不影响启动。
3. **持久化账号在停机期间被用户删除**：
   - 触发顺延算法，自动平滑切换到序号紧随其后的下一个可用账号，若没有则回绕到首位。
4. **单账号环境**：
   - 算法自然收敛到该唯一账号。
5. **并发模式（Concurrent Mode）**：
   - 在并发调度拉起账号时，同样触发 `_activateContext` 记录最新激活的账号；重启时基于最新活跃序号顺畅起步。

---

## 5. 验证方案

1. **单元测试 (`test/auth-state-tracker.test.js`)**：
   - 验证文件的读、写、创建目录；
   - 验证无记录时的 fallback；
   - 验证正常命中上次记录；
   - 验证账号被删除时的顺延逻辑（中间顺延、末尾环绕）；
   - 验证 JSON 损坏时的容错降级。
2. **系统集成测试**：
   - 启动服务验证生成 `data/auth-state.json`；
   - 模拟切换账号，重启服务，验证日志输出接续上次序号启动；
   - 运行项目全量代码检查 (`npm run lint:js` 与 `npm run format:check`)。
