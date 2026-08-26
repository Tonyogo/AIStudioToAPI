# 交接文档：轻量级多账号并发转发子系统 (src/concurrent)

**更新日期:** 2026-08-25  
**状态:** 已升级完成并已通过测试 (全套单元与集成测试通过，ESLint 0 Error)

---

## 1. 概述与核心功能

本子系统专为 **AIStudioToAPI** 在启用并发模式时设计。当环境变量 `ENABLE_CONCURRENT=true` 启用时，系统会绕过原先的全局互斥锁 (`isSystemBusy`) 和复杂的账号切换机制，自动将传入的原生 Gemini API 请求分发并并发转发到所有健康的在线账号连接中。

### 核心功能

- **多账号并发透传：** 允许多个客户端的流式 (Streaming) 或非流式 (Non-Streaming) 请求并行在不同的 Google 账号下执行，不存在全局阻塞。
- **可拔插调度策略架构 (Pluggable Strategies & 默认 Least-Used)：**
  - 内置基于策略模式（Strategy Pattern）的候选账号挑选引擎，支持 `least-used`（默认）、`round-robin`、`weighted` 三种算法。
  - **最少用量优先（Least-Used，默认）：** 根据每日按模型统计的用量，优先将请求调度给当前周期内对该模型使用量最少的账号，实现跨账号配额的绝对均衡消耗。
  - **经典轮询（Round-Robin）：** 按游标相对顺时针顺序依次分发。
  - **剩余配额加权（Weighted）：** 按账号剩余配额容量 $W_i = \max(1, \text{limit} - \text{usage}_i)$ 进行概率加权随机调度。
  - **四级策略解析层级：** 请求头 (`x-scheduling-strategy` / `x-strategy`) > 模型配置 (`models.json`) > 全局环境变量/配置 (`CONCURRENT_SCHEDULING_STRATEGY`) > 默认缺省策略 (`least-used`)。支持请求级动态策略覆盖与未知策略宽容回退。
- **LRU 活跃队列提升与保活 (\_moveToFront Queue Elevation)：**
  - 维护动态 `activeQueue` 记录账号活跃顺序。
  - 每次成功命中并分发请求后，立即将该账号提升至 `activeQueue` 队首 (`_moveToFront`)，确保频繁使用的健康活跃账号优先常驻 Context，避免被意外置换。
  - 账号退休下线时移至队尾 (`_moveToBack`)，动态池再平衡优先保留健康就绪账号。
- **项目首发账号自动感知与 Baseline=MAX_CONTEXTS 保障：**
  - 自动同步项目默认启动账号（`currentAuthIndex`）为 `ACTIVATED`，并自动维护 `MAX_CONTEXTS`（默认 1）个激活账号做并发底座。
- **并发请求打散（Scatter Load Balancing）：**
  - 优先挑选在途请求数 `inFlight == 0` 的空闲账号（Phase 1），若无绝对空闲则复用 `inFlight == 1` 的轻度繁忙账号（Phase 2），单账号最大在途上限为 2。
- **30s 全局激活冷却与单次激活互斥锁 (Activation Lock & 30s Cooldown)：**
  - 引入全局 `isActivatingAny` 互斥锁，严格防止并发请求同时触发多个账号并行激活；两次账号激活之间严格保持 >= 30s 冷却，防止频繁触发浏览器上下文切换。
- **2 分钟激活寿命自动到期 (Activation Auto-Expiration)：**
  - 账号激活后具备 2 分钟寿命上限 (`activatedLifespanMs = 120000`)。每次在调度请求 (`getNextAuthIndex`) 入口处触发状态刷新，若已激活账号空闲 (`inFlight === 0`) 且激活时长超过 2 分钟，自动复位为 `INACTIVE`。
- **连续失败累加与请求量达标降级退休 (Failure & Usage Retirement)：**
  - 每一个请求失败（403/500/503 等）都会不中断地累加连续失败次数，当连续失败达到 `failureThreshold`（默认 3 次）或者直接收到 `immediateSwitchStatusCodes`（默认 `[429, 503]`）时，平滑而即时地触发降级退休 (`RETIRED`)。
  - **基于 `SWITCH_ON_USES` 轮换：** 每个账号独立统计累计请求次数，当单账号请求量达到 `SWITCH_ON_USES`（默认 40 次）上限后，自动触发退休降级并清零计数，促使并发池拉起后备健康账号平滑接替，实现多账号平滑滚动轮换。
- **动态池平滑退载与状态自动复位 (Dynamic Rebalance & State Restoration)：**
  - 当账号因连续失败达到上限或收到立即切换状态码而 `RETIRED` 时，自动触发并发池动态再平衡 (`rebalanceConcurrentPool`)，按【健康活跃账号 (LRU 顺序) > 退休账号 (最早退休顺序)】构建优先级队列；
  - 若降级选入 `MAX_CONTEXTS` 保底目标集，被选中的 `RETIRED` 账号在拉起前自动恢复为 `INACTIVE` 并清空失败计数；落在保底集外的 Context 由 BrowserManager 在空闲时优雅关闭释放约 **700MB 内存**。
- **禁用与过期账号自动过滤 (Disabled/Expired Accounts Filtering)：**
  - 调度器在获取候选账号集与执行并发池再平衡时，严格过滤 `disabledIndices` 和 `expiredIndices`，确保被禁用的账号不会被错误拉起或分发请求。
- **北京时间 15:00 自动重置与跨周期复苏：**
  - 每日北京时间 15:00:00 (UTC+8) 自动归零模型用量，并同步将 `RETIRED` 状态账号复位为 `INACTIVE` 重启可用。
- **全链路可观测性 (UsageStatsService) & 图像 Part 转 Markdown：**
  - 完整上报请求与尝试节点数据给 UI 监控面板，并支持将 Gemini 生成的 Base64 图片自动转换为 Markdown Inline Data URL 展现。

---

## 2. 目录结构与文件职责

所有的并发相关代码均保存在 `src/concurrent/` 目录中：

```
src/
└── concurrent/
    ├── index.js                    # 并发模块入口门面 (Facade)
    ├── AccountScheduler.js         # 智能账号调度器 (Scheduler, State Machine & Load Balancer)
    ├── ConcurrentRequestHandler.js # 高性能原生 Gemini API 请求拦截器与流转发核心
    ├── ModelUsageTracker.js        # 模型配额计数、北京 15:00 周期重置与磁盘持久化
    ├── strategies/                 # 可拔插候选账号调度策略模块
    │   ├── index.js                # 策略工厂与统一调度入口 (默认 least-used)
    │   ├── least-used.js           # 最少用量优先策略 (默认算法: 按模型当日用量升序)
    │   ├── round-robin.js          # 经典顺时针轮询策略 (按 order 升序)
    │   └── weighted.js             # 剩余容量加权随机策略 (按剩余配额概率加权)
    └── README.md                   # 模块交接与说明文档 (即本文档)
```

### 2.1 `index.js` (统一入口)

- **职责：** 子系统的统一对外接口和门面方法 `initConcurrentMode(app, system)`。
- **内部设计：**
  - 自动读取环境变量 `ENABLE_CONCURRENT`。若未启用，直接返回 `null`。
  - 实例化 `ModelUsageTracker(logger)`。
  - 传入 `system.config` 实例化 `AccountScheduler(authSource, connectionRegistry, logger, browserManager, modelUsageTracker, modelList, config)`。
  - 将 `scheduler` 注入 `browserManager.setAccountScheduler(scheduler)`，用于委托处理 Context 关闭再平衡。
  - 注入 `system.usageStatsService` 供 `ConcurrentRequestHandler` 进行数据统计监控上报。
  - 挂载并发接口路由至 Express 实例最前端。

### 2.2 `AccountScheduler.js` (智能账号调度器)

- **职责：** 管理账号激活状态机、调度策略解析、30s 激活冷却、LRU 队列管理、并发打散调度、账号退休与再平衡替换。
- **核心逻辑与状态机：**
  - **状态定义：** `INACTIVE`（初始/未激活）、`ACTIVATING`（正在激活）、`ACTIVATED`（已激活且就绪）、`RETIRED`（下线退休，释放 Context）。
  - **策略解析 (`getSchedulingStrategy(modelName, requestStrategy)`)：**
    - 优先级 1：请求头传入的 `x-scheduling-strategy` 或 `x-strategy`（支持单次请求动态覆盖）；
    - 优先级 2：模型配置 `models.json` 中的 `schedulingStrategy`（如 `"round-robin"`、`"least-used"`、`"weighted"`）；
    - 优先级 3：全局环境变量 `CONCURRENT_SCHEDULING_STRATEGY` 或系统配置 `config.concurrentSchedulingStrategy`；
    - 优先级 4：默认缺省策略 `"least-used"`。
    - **宽容回退：** 若请求头传入未知策略名，自动记录 debug 日志并继续向下解析，确保请求正常执行。
  - **首发账号同步：** 自动同步 `browserManager._currentAuthIndex` 为 `ACTIVATED`，绝不对默认启动账号重复执行激活。
  - **LRU 队列管理 (`_moveToFront` & `_moveToBack`)：** 请求命中时提升到队首，退休时下沉到队尾。
  - **30s 激活冷却：** 维护 `lastGlobalActivationAt`，任意账号两次激活之间严格间隔 >= 30 秒。
  - **退休与动态池再平衡 (`checkAndRetireAccount` & `retireAndReplaceAccount` & `rebalanceConcurrentPool`)：**
    - 检查连续失败达到 `failureThreshold`（默认 3 次）、收到立即切换状态码（默认 429、503）或单账号请求计数达到 `SWITCH_ON_USES`（默认 40 次）。
    - 触发下线后标记为 `RETIRED`，并触发动态池再平衡 `rebalanceConcurrentPool()`；
    - 动态构建优先级队列，将 `RETIRED` 账号排在队尾。被保底选中的 `RETIRED` 账号自动恢复状态为 `INACTIVE` 并清空失败计数与使用计数，超出容量的退休 Context 由 BrowserManager 在空闲时优雅关闭释放约 700MB 内存。
  - **周期复苏 (`_checkAndResetCycle`)：** 在每日北京 15:00 周期跨越时，自动将所有 `RETIRED` 状态账号复位为 `INACTIVE` 并清空失败计数。
- **完整调度流程 (`acquireNextAuthIndex` & `getNextAuthIndex`)：**
  详见本文档 [第 3 节：完整调度流程](#3-完整调度流程详解)。

### 2.3 `strategies/` (可拔插候选账号调度策略)

- **职责：** 将候选账号选择算法解耦为独立模块，所有策略均遵循统一函数接口：
  `selectCandidate(candidates, context)`，其中 `candidates` 为候选账号数组 `[{ idx, inFlight, order, usage }]`，`context` 包含 `{ limit, modelName }`。
- **模块详情：**
  - **`least-used.js`（默认）：** 优先按当前周期内该模型使用量 `usage` 升序排列；当用量相同时按相对轮询游标 `order` 升序挑选第 1 位。
  - **`round-robin.js`：** 纯顺时针轮询，按 `order` 升序挑选第 1 位。
  - **`weighted.js`：** 计算各候选账号的剩余配额权重 $W_i = \max(1, \text{limit} - \text{usage}_i)$，按概率区间随机挑选。
  - **`index.js`：** 策略工厂与分发中心，当指定策略名未知时自动回退为默认的 `"least-used"`。

### 2.4 `ModelUsageTracker.js` (配额计数与周期持久化)

- **职责：** 追踪各账号对不同模型的请求次数，管理北京时间 15:00 重置周期，并将统计持久化落盘。
- **关键设计：**
  - **北京时间 15:00 重置周期 (`getBeijingCycleKey`)：**
    以每日北京时间 15:00:00 (UTC+8，相当于 UTC 07:00:00) 为重置界限。计算逻辑独立于服务器本地时区设置。跨越 15:00 时内存计数器自动清零并同步磁盘文件。
  - **防抖落盘 (Debounced Save)：**
    持久化文件为 `data/concurrent-model-usage.json`。每次计数自增 (`recordUsage`) 会触发 500ms 防抖异步落盘，避免高并发下频繁写磁盘。

### 2.5 `ConcurrentRequestHandler.js` (高性能请求分发)

- **职责：** 拦截请求，解析标准化模型名，透传真实状态码/Header，集成 UI 统计追踪，图片 Base64 转换。
- **关键设计细节：**
  - **监控集成 (`usageStatsService`)：**
    精准上报 `startRequest`、`updateRequest`、`recordAttempt` 与 `finishRequest` 节点信息，包含账号名称与流模式（`real`），使 UI 监控界面正确展示账号分布与请求状态。
  - **请求完成退休检查：**
    在 `finally` 块中释放在途数后，异步调用 `scheduler.checkAndRetireAccount(authIndex)` 检查是否触发退休下线。
  - **客户端断开取消机制：**
    监听 Express `res.on("close")` 事件。若客户端中途断开，主动发送 WebSocket `cancel_request` 消息并触发 `AbortSignal` 中断排队等待。

---

## 3. 完整调度流程详解

当客户端发出原生 Gemini 请求（如 POST `/v1beta/models/gemini-2.5-pro:generateContent`）时，系统通过 `AccountScheduler.acquireNextAuthIndex(modelName, options)` 执行全链路调度分发：

```
[客户端请求到达]
       │
       ▼
1. 北京 15:00 周期检查 (_checkAndResetCycle)
   & 激活 2 分钟寿命到期自动检测 (_refreshAccountStatuses)
   & 自动同步 browserManager._currentAuthIndex 状态为 ACTIVATED
       │
       ▼
2. 过滤不可用账号 (_getAccountIndices)
   - 排除 disabledIndices 与 expiredIndices
   - 提取模型单账号每日上限 (dailyLimit, 默认 100 次)
   - 解析调度策略 (getSchedulingStrategy, 默认 least-used)
       │
       ▼
3. 扫描在线 WebSocket 账号并分类收集候选集
   - 过滤 RETIRED 账号及满载账号 (inFlight >= 2)
   - 分类收集:
     * activatedFree:     已激活且绝对空闲 (inFlight === 0)
     * activatedBusy:     已激活但处理 1 个请求 (inFlight === 1)
     * inactiveCandidates: 在线未激活账号 (INACTIVE)
       │
       ▼
4. 双账号底座维护 (Baseline = MAX_CONTEXTS Check)
   - 若 activated 账号总数 < maxContexts 且冷却满 30s 且有 inactiveCandidates:
   - 采用当前策略选出最佳 inactiveCandidate 并异步激活，加入 activatedFree 队列
       │
       ▼
5. 两阶段策略调度分发 (Phase 1 & Phase 2)
   ├───► 阶段 1: 若 activatedFree 非空:
   │            通过策略 (默认 least-used) 选出最优空闲账号
   │            └─► 触发 _moveToFront(selectedIdx) 提升活跃队列
   │            └─► 更新轮询游标 currentIndex ───────────────────────► [分发请求]
   │
   ├───► 阶段 2: 复用轻度繁忙账号:
   │            通过策略 (默认 least-used) 选出最优 activatedBusy 账号
   │            └─► 触发 _moveToFront(selectedIdx) 提升活跃队列
   │            └─► 更新轮询游标 currentIndex ───────────────────────► [分发请求]
   │
   └───► 极值等待与超时重试 (Busy Wait & 3000ms Polling Retry):
                ├── 若在线账号均满载 (inFlight >= 2) 或无在线可用账号:
                │   └─► 不立即报错，进入异步挂起轮询等待状态
                │   └─► 每隔 3000ms 重新执行调度轮询，直至成功获取可用账号
                │   └─► 期间若客户端断开连接 (Client Close)，利用 AbortSignal 即时中断退出
                │   └─► 若超过最大等待超时 (默认 60s / CONCURRENT_WAIT_TIMEOUT_MS):
                │       └─► 抛出 HTTP 503 Error ("All available accounts are busy (waited Ns)")
```

---

## 4. 调度策略、模型配额与环境变量配置指南

### 4.1 请求头动态指定调度策略 (`x-scheduling-strategy` / `x-strategy`)

客户端可以在发起原生 Gemini 请求时，通过 HTTP 请求头按请求动态指定当前请求的调度算法（拥有最高优先级）：

- **请求头名称：** `x-scheduling-strategy`（同时兼容 `x-strategy`）
- **可选值（大小写不敏感）：**
  - `least-used`：最少用量优先（优先选择当日当前模型用量最少的账号）
  - `round-robin`：经典轮询调度
  - `weighted`：剩余配额加权随机调度

**cURL 示例：**

```bash
# 使用请求头指定当前请求采用 round-robin 策略
curl -X POST "http://localhost:3000/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Content-Type: application/json" \
  -H "x-scheduling-strategy: round-robin" \
  -d '{
    "contents": [{"parts": [{"text": "Hello Gemini!"}]}]
  }'
```

- **说明：**
  - 若传入未知策略名称（如 `x-scheduling-strategy: custom`），系统不会中断请求，而是记录调试日志并自动向下回退（模型配置 > 全局配置 > 默认 `least-used`）。

### 4.2 模型配置与自定义调度策略 (`configs/models.json`)

在 `configs/models.json` 对应的模型定义中，可以添加以下字段来自定义单模型配额与并发调度策略：

- `dailyLimit`：可选整数，设置该模型单账号每日使用上限（默认 `100`）。
- `schedulingStrategy`：可选字符串，指定该模型专用的并发调度算法（覆盖全局默认策略）：
  - `"least-used"`（推荐/默认）：最少用量优先，优先挑选当前北京 15:00 周期内该模型使用量最少的在线账号。
  - `"round-robin"`：经典轮询，按顺序依次轮流分发。
  - `"weighted"`：基于剩余配额容量进行概率加权随机调度。

```json
{
  "name": "models/gemini-2.5-pro",
  "displayName": "Gemini 2.5 Pro",
  "dailyLimit": 50,
  "schedulingStrategy": "least-used",
  "inputTokenLimit": 1048576,
  "outputTokenLimit": 65536
}
```

- **说明：**
  - 若模型未配置 `dailyLimit`，系统默认每个账号每日该模型上限为 **100** 次。
  - 若模型未配置 `schedulingStrategy`，系统自动采用全局策略（默认 `"least-used"`）。
  - 周期重置时间固定为北京时间每天下午 15:00:00。

### 4.3 环境变量配置 (`.env`)

可通过 `.env` 环境变量调整并发系统的全局策略、重试超时与退休阈值：

| 环境变量                         | 默认值       | 说明                                                            |
| :------------------------------- | :----------- | :-------------------------------------------------------------- |
| `ENABLE_CONCURRENT`              | `false`      | 是否开启并发多账号分发模式 (`true`/`false`)                     |
| `CONCURRENT_SCHEDULING_STRATEGY` | `least-used` | 全局并发调度策略 (`least-used` / `round-robin` / `weighted`)    |
| `MAX_CONTEXTS`                   | `1`          | 最大常驻浏览器 Context 数量（并发账号底座容量，`0` 表示无限制） |
| `CONCURRENT_WAIT_TIMEOUT_MS`     | `60000`      | 并发满载等待最大超时（毫秒），默认 60 秒，每隔 3000ms 轮询一次  |
| `FAILURE_THRESHOLD`              | `3`          | 账号连续请求失败上限，达到后自动标记为 `RETIRED`                |
| `IMMEDIATE_SWITCH_STATUS_CODES`  | `429,503`    | 触发账号立即退休的 HTTP 状态码列表（英文逗号分隔）              |

---

## 5. 测试与验证

本子系统配备了完整的自动化单元与集成测试：

- **测试文件列表：**
  - `test/concurrent/strategies.test.js`：验证可拔插策略工厂（`least-used`、`round-robin`、`weighted`）的挑选逻辑及默认未知回退。
  - `test/concurrent/account_scheduler.test.js`：验证状态机、首发账号同步、双账号底座维护、30s 激活冷却、LRU 队列更新、策略层级解析（模型覆盖 > 全局配置 > 默认 least-used）、Least-Used 调度、账号退休与并发池再平衡、北京 15:00 周期跨越复苏等。
  - `test/concurrent/model_usage_tracker.test.js`：验证北京时间 15:00 周期计算、计数累加与磁盘持久化。
  - `test/concurrent/concurrent_request_handler.test.js`：验证路由拦截、状态码/Header 透传、模型名提取、inFlight acquire/release 配对、UI 监控数据上报、图片 Base64 转换与断开连接取消机制。
  - `test/concurrent/index.test.js`：验证统一入口初始化。
  - `test/concurrent/integration.test.js`：验证端到端请求分发与响应流透传。

### 运行代码检查命令

```bash
npm run lint:js
```
