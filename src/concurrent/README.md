# 交接文档：轻量级多账号并发转发子系统 (src/concurrent)

**更新日期:** 2026-08-05  
**状态:** 已升级完成并已通过测试 (54/54 单元与集成测试全部通过，ESLint 0 Error)

---

## 1. 概述与核心功能

本子系统专为 **AIStudioToAPI** 在启用并发模式时设计。当环境变量 `ENABLE_CONCURRENT=true` 启用时，系统会绕过原先的全局互斥锁 (`isSystemBusy`) 和复杂的账号切换机制，自动将传入的原生 Gemini API 请求分发并并发转发到所有健康的在线账号连接中。

### 核心功能

- **多账号并发透传：** 允许多个客户端的流式 (Streaming) 或非流式 (Non-Streaming) 请求并行在不同的 Google 账号下执行，不存在全局阻塞。
- **项目首发账号自动感知与 Baseline=MAX_CONTEXTS 保障：** 自动同步项目默认启动的账号（`currentAuthIndex`）为 `ACTIVATED`，并自动维护 `MAX_CONTEXTS`（默认 1）个激活账号做并发底座。
- **并发请求打散（Scatter Load Balancing）：** 优先挑选在途请求数 `inFlight == 0` 的空闲账号分发请求，把并发均匀平摊到不同账号上。
- **最少用量优先（Least-Used Load Balancing）：** 根据每日按模型统计的用量，优先将请求调度给当前模型使用量最少的账号，实现均衡消耗。
- **30s 全局激活冷却与单次激活互斥锁 (Activation Lock & 30s Cooldown)：** 引入全局 `isActivatingAny` 互斥锁，严格防止并发请求同时触发多个账号并行激活；两次账号激活之间严格保持 >= 30s 冷却，防止频繁触发浏览器上下文切换。冷却校验同样适用于 Baseline 激活。
- **20秒隔离挂起时长（可配置）：** 遇到 HTTP 429 限流或连续 2 次 5xx 错误时，账号自动进入隔离期 (`suspendedUntilMap`)，默认 20 秒，可以通过环境变量 `CONCURRENT_SUSPENSION_DURATION_MS` 自定义。
- **2 分钟激活寿命自动到期 (Activation Auto-Expiration)：** 账号激活后默认具备 2 分钟寿命上限。每次在调度请求 (`getNextAuthIndex`) 入口处触发状态刷新，若已激活账号空闲 (`inFlight === 0`) 且激活时长超过 2 分钟，自动复位过期为 `INACTIVE`。
- **动态池平滑退载与状态自动复位 (Dynamic Rebalance & State Restoration)：** 
  - 单模型默认每日上限 **1000 次** (`dailyLimit`)，仅用作判定下线降级与替换依据，**不阻断线上调度**；
  - 当账号在 `exhaustedModelsThreshold` 个模型（默认 1 个）上达到限额，或连续失败达到 `failureThreshold`（默认 3 次，或单次 429）时，触发标记为降级退休 (`RETIRED`)；
  - 自动触发并发池动态再平衡 (`rebalanceConcurrentPool`)，按【健康账号 (Usage 升序) > 退休账号 (Usage 升序)】构建优先级队列；
  - 若降级选入 `MAX_CONTEXTS` 保底目标集，被选中的 `RETIRED` 账号在拉起前自动恢复为 `INACTIVE` 并清空失败计数；落在保底集外的 Context 由 BrowserManager 在空闲时优雅关闭释放约 **700MB 内存**。
- **北京时间 15:00 自动重置与跨周期复苏：** 每日北京时间 15:00:00 (UTC+8) 自动归零模型用量，并同步将 `RETIRED` 状态账号复位为 `INACTIVE` 重启可用。
- **全链路可观测性 (UsageStatsService) & 图像 Part 转 Markdown：** 完整上报请求与尝试节点数据给 UI 监控面板，并支持将 Gemini 生成的 Base64 图片自动转换为 Markdown Inline Data URL 展现。

---

## 2. 目录结构与文件职责

所有的并发现关代码均保存在 `src/concurrent/` 目录中：

```
src/
└── concurrent/
    ├── index.js                    # 并发模块入口门面 (Facade)
    ├── AccountScheduler.js         # 智能账号调度器 (Scheduler, State Machine & Load Balancer)
    ├── ConcurrentRequestHandler.js # 高性能原生 Gemini API 请求拦截器、隔离重试与流转发核心
    ├── ModelUsageTracker.js        # 模型配额计数、北京 15:00 周期重置与磁盘持久化
    └── README.md                   # 模块交接与说明文档 (即本文档)
```

### 2.1 `index.js` (统一入口)

- **职责：** 子系统的统一对外接口和门面方法 `initConcurrentMode(app, system)`。
- **内部设计：**
  - 自动读取环境变量 `ENABLE_CONCURRENT`。若未启用，直接返回 `null`。
  - 实例化 `ModelUsageTracker(logger)`。
  - 传入 `system.config` 实例化 `AccountScheduler(authSource, connectionRegistry, logger, browserManager, modelUsageTracker, modelList, config)`。
  - 注入 `system.usageStatsService` 供 `ConcurrentRequestHandler` 进行数据统计监控上报。
  - 挂载并发接口路由至 Express 实例最前端。

### 2.2 `ModelUsageTracker.js` (配额计数与周期持久化)

- **职责：** 追踪各账号对不同模型的请求次数，管理北京时间 15:00 重置周期，并将统计持久化落盘。
- **关键设计：**
  - **北京时间 15:00 重置周期 (`getBeijingCycleKey`)：**
    以每日北京时间 15:00:00 (UTC+8，相当于 UTC 07:00:00) 为重置界限。计算逻辑独立于服务器本地时区设置。跨越 15:00 时内存计数器自动清零并同步磁盘文件。
  - **防抖落盘 (Debounced Save)：**
    持久化文件为 `data/concurrent-model-usage.json`。每次计数自增 (`recordUsage`) 会触发 500ms 防抖异步落盘，避免高并发下频繁写磁盘。

### 2.3 `AccountScheduler.js` (智能账号调度器)

- **职责：** 管理账号激活状态机、执行单模型配额过滤、30s 激活冷却、并发打散调度以及账号退休与无缝替换。
- **核心逻辑与状态机：**
  - **状态定义：** `INACTIVE`（初始/未解卡）、`ACTIVATING`（正在激活）、`ACTIVATED`（已解卡且可用）、`RETIRED`（下线退休，释放 Context）。
  - **首发账号同步：** 自动同步 `browserManager.currentAuthIndex` 为 `ACTIVATED`，绝不对默认启动账号重复执行激活。
  - **30s 激活冷却：** 维护 `lastGlobalActivationAt`，任意账号两次激活之间严格间隔 >= 30 秒。
  - **隔离挂起 (20秒)：** 遇到 HTTP 429 限流或连续 2 次 5xx 错误时，账号自动进入 20秒 隔离期 (`suspendedUntilMap`)。
  - **退休与动态池再平衡 (`checkAndRetireAccount` & `retireAndReplaceAccount` & `rebalanceConcurrentPool`)：**
    - 检查在 N 个模型上达到每日配额（默认 1000 次），或连续失败达到 `failureThreshold`（默认 3 次）。
    - 触发下线后标记为 `RETIRED`，并触发动态池再平衡 `rebalanceConcurrentPool()`；
    - 动态构建优先级队列，将 `RETIRED` 账号排在队尾。被保底选中的 `RETIRED` 账号自动恢复状态为 `INACTIVE` 并清空失败计数，超出容量的退休 Context 由 BrowserManager 在空闲时优雅关闭释放 700MB 内存。
  - **周期复苏 (`_checkAndResetCycle`)：** 在每日北京 15:00 周期跨越时，自动将所有 `RETIRED` 状态账号复位为 `INACTIVE` 并清空失败计数与挂起映射。
- **完整调度流程 (`getNextAuthIndex(modelName)`)：**
  详见本文档 [第 3 节：完整调度流程](#3-完整调度流程详解)。

### 2.4 `ConcurrentRequestHandler.js` (高性能请求分发)

- **职责：** 拦截请求，解析标准化模型名，透传真实状态码/Header，集成 UI 统计追踪，实现失败 cross-account 重试与图片 Base64 转换。
- **关键设计细节：**
  - **多账号无感重试：**
    在响应头尚未发送 (`res.headersSent === false`) 且非 429 报错时，允许最多 2 次无感跨账号重试。
  - **监控集成 (`usageStatsService`)：**
    精准上报 `startRequest`、`updateRequest`、`recordAttempt` 与 `finishRequest` 节点信息，包含账号名称与流模式（`real`），使 UI 监控界面正确展示账号分布与请求状态。
  - **请求完成退休检查：**
    在 `finally` 块中释放在途数后，异步调用 `scheduler.checkAndRetireAccount(authIndex)` 检查是否触发退休下线。
  - **客户端断开取消机制：**
    监听 Express `res.on("close")` 事件。若客户端中途断开，主动发送 WebSocket `cancel_request` 消息。

---

## 3. 完整调度流程详解

当客户端发起一个原生 Gemini 请求（如 POST `/v1beta/models/gemini-2.5-pro:generateContent`）时，调度器 `AccountScheduler.getNextAuthIndex(modelName)` 按照以下步骤执行调度：

```
[客户端请求到达]
       │
       ▼
1. 北京 15:00 周期检查 (_checkAndResetCycle)
   & 激活 2 分钟寿命到期自动检测 (_refreshAccountStatuses)
   & 刷新系统活跃时间 (lastSystemActivityAt = Date.now())
   & 自动同步 browserManager.currentAuthIndex 状态为 ACTIVATED
       │
       ▼
2. 提取模型单账号每日上限 (dailyLimit, 默认 1000 次)
       │
       ▼
3. 扫描在线 WebSocket 账号
   - 过滤已 RETIRED / 处于 20秒挂起期 (isAccountSuspended) / inFlight >= 2 的账号（额度用尽不跳过，仍作为候选参与用量升序分发，请求完成后由 checkAndRetireAccount 触发下线与替换）
   - 分类收集候选集:
     * activatedFree:     已激活且绝对空闲 (inFlight === 0)
     * activatedBusy:     已激活但正在处理 1 个请求 (inFlight === 1)
     * inactiveCandidates: 在线未激活账号 (INACTIVE)
       │
       ▼
4. 双账号底座维护 (Baseline = MAX_CONTEXTS Check)
   - 若 activated 账号总数 < maxContexts 且冷却满 30s 且有 inactiveCandidates:
   - 触发激活最少用量的在线账号，加入 activatedFree 队列
       │
       ▼
5. 两阶段精简调度分发 (Phase 1 & Phase 2)
   ├───► 阶段 1: 若 activatedFree 非空:
   │            按模型用量 (usage) 升序选出空闲账号 ──────────────────► [分发请求]
   │
   ├───► 阶段 2: 复用轻度繁忙账号:
   │            分发给 activatedBusy (inFlight === 1) 中 usage 最小的账号 ───────► [分发请求]
   │
   └───► 极值判断与报错:
                ├── 若在线账号均满载 (inFlight >= 2):
                │   └─► 抛出 HTTP 503 Error ("All available accounts are busy")
                └── 无在线 WebSocket:
                    └─► 抛出 HTTP 503 Error ("No active context connection available")
```

---

## 4. 退休配置与模型上限指南 (`configs/models.json` & `.env`)

### 4.1 模型限额配置 (`configs/models.json`)

在 `configs/models.json` 对应的模型定义中添加 `dailyLimit` 可选整数字段：

```json
{
  "name": "models/gemini-2.5-pro",
  "displayName": "Gemini 2.5 Pro",
  "dailyLimit": 50,
  "inputTokenLimit": 1048576,
  "outputTokenLimit": 65536
}
```

- **说明：**
  - 若不设置 `dailyLimit`，系统默认每个账号每日该模型上限为 **1000** 次。
  - 重置时间固定为北京时间每天下午 15:00:00。

### 4.2 退休下线环境变量 (`.env`)

可通过环境变量或配置修改退休触发条件：
- `EXHAUSTED_MODELS_THRESHOLD`：账号用尽配额的模型数量上限，默认值为 `1`（当在 1 个模型上达到上限即退休该账号并更换新账号）。
- `FAILURE_THRESHOLD`：账号连续请求失败/429 上限，默认值为 `3`。

---

## 5. 测试与验证

本子系统配备了完整的自动化单元与集成测试（共 63 个测试用例全部通过，ESLint 检查 0 错误）：

- **测试文件列表：**
  - `test/concurrent/model_usage_tracker.test.js`：验证北京时间 15:00 周期计算、计数累加与磁盘持久化。
  - `test/concurrent/account_scheduler.test.js`：验证状态机、首发账号同步、双账号底座自动拉起、30s 激活冷却、在途并发打散、Least-Used 最少用量调度、账号退休下线与新账号上线替换、北京 15:00 周期跨越复苏等。
  - `test/concurrent/concurrent_request_handler.test.js`：验证路由拦截、状态码/Header 透传、模型名提取、inFlight acquire/release 配对、UI 监控数据上报、图片 Base64 转换与断开连接取消机制。
  - `test/concurrent/index.test.js`：验证统一入口初始化。
  - `test/concurrent/integration.test.js`：验证端到端请求分发与响应流透传。

### 运行测试命令

```bash
npx jest test/concurrent/
```

### 运行代码检查命令

```bash
npm run lint:js
```
