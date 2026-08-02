# 交接文档：轻量级多账号并发转发子系统 (src/concurrent)

**更新日期:** 2026-08-02  
**状态:** 已升级完成并已通过测试 (40/40 单元与集成测试全部通过，ESLint 0 Error)

---

## 1. 概述与核心功能

本子系统专为 **AIStudioToAPI** 在启用并发模式时设计。当环境变量 `ENABLE_CONCURRENT=true` 启用时，系统会绕过原先的全局互斥锁 (`isSystemBusy`) 和复杂的账号切换机制，自动将传入的原生 Gemini API 请求分发并并发转发到所有健康的在线账号连接中。

### 核心功能

- **多账号并发透传：** 允许多个客户端的流式 (Streaming) 或非流式 (Non-Streaming) 请求并行在不同的 Google 账号下执行，不存在全局阻塞。
- **项目首发账号自动感知与 Baseline=2 保障：** 自动同步项目默认启动的账号（`currentAuthIndex`）为 `ACTIVATED`，并自动维护至少 2 个激活账号做并发底座。
- **并发请求打散（Scatter Load Balancing）：** 优先挑选在途请求数 `inFlight == 0` 的空闲账号分发请求，把并发均匀平摊到不同账号上。
- **30s 全局激活冷却与主动扩容（Scale-Out）：** 两次账号激活之间严格保持 >= 30s 冷却，防止连续频繁切换；当所有已激活账号都在处理请求时，主动触发新账号激活扩容。
- **智能模型配额调度：** 结合模型每日上限 (`dailyLimit`)、按模型使用量优先 (Least-Used First) 及北京时间 15:00 自动重置，实现配额均衡消耗。
- **极致解耦与零修改原路由：** 所有并发转发逻辑全部内聚在 `src/concurrent/` 目录下。当并发模式关闭时，系统无缝回退到原本的单账号多格式路由。

---

## 2. 目录结构与文件职责

所有的并发现关代码均保存在 `src/concurrent/` 目录中：

```
src/
└── concurrent/
    ├── index.js                    # 并发模块入口门面 (Facade)
    ├── AccountScheduler.js         # 智能账号调度器 (Scheduler, State Machine & Load Balancer)
    ├── ConcurrentRequestHandler.js # 高性能原生 Gemini API 请求拦截器与流转发核心
    ├── ModelUsageTracker.js        # 模型配额计数、北京 15:00 周期重置与磁盘持久化
    └── README.md                   # 模块交接与说明文档 (即本文档)
```

### 2.1 `index.js` (统一入口)

- **职责：** 子系统的统一对外接口和门面方法 `initConcurrentMode(app, system)`。
- **内部设计：**
  - 自动读取环境变量 `ENABLE_CONCURRENT`。若未启用，直接返回 `null`。
  - 实例化 `ModelUsageTracker(logger)`。
  - 实例化 `AccountScheduler(authSource, connectionRegistry, logger, browserManager, modelUsageTracker, modelList)`。
  - 挂载并发接口路由至 Express 实例最前端。

### 2.2 `ModelUsageTracker.js` (配额计数与周期持久化)

- **职责：** 追踪各账号对不同模型的请求次数，管理北京时间 15:00 重置周期，并将统计持久化落盘。
- **关键设计：**
  - **北京时间 15:00 重置周期 (`getBeijingCycleKey`)：**
    以每日北京时间 15:00:00 (UTC+8，相当于 UTC 07:00:00) 为重置界限。计算逻辑独立于服务器本地时区设置。跨越 15:00 时内存计数器自动清零并同步磁盘文件。
  - **防抖落盘 (Debounced Save)：**
    持久化文件为 `data/concurrent-model-usage.json`。每次计数自增 (`recordUsage`) 会触发 500ms 防抖异步落盘，避免高并发下频繁写磁盘。

### 2.3 `AccountScheduler.js` (智能账号调度器)

- **职责：** 管理账号激活状态机、执行单模型配额过滤、30s 激活冷却与并发打散调度。
- **核心逻辑与状态机：**
  - **状态定义：** `INACTIVE`（初始/未解卡）、`ACTIVATING`（正在激活）、`ACTIVATED`（已解卡且可用）。
  - **首发账号同步：** 自动同步 `browserManager.currentAuthIndex` 为 `ACTIVATED`，绝不对默认启动账号重复执行激活。
  - **30s 激活冷却：** 维护 `lastGlobalActivationAt`，任意账号两次激活之间必须间隔 >= 30 秒 (`Date.now() - lastGlobalActivationAt >= 30000`)。
  - **在途并发控制 (In-Flight Limit = 2)：** 单账号最多同时处理 2 个请求 (`maxInFlightPerAccount = 2`)。配对使用 `acquireInFlight` / `releaseInFlight`。
- **完整调度流程 (`getNextAuthIndex(modelName)`)：**
  详见本文档 [第 3 节：完整调度流程](#3-完整调度流程详解)。

### 2.4 `ConcurrentRequestHandler.js` (高性能请求分发)

- **职责：** 拦截请求，解析标准化模型名，透传真实状态码/Header，并在客户端断开时发送取消命令。
- **关键设计细节：**
  - **模型名标准化 (`_extractCleanModelName`)：**
    利用 `FormatConverter` 工具函数剥离模型路径中的工具/思维/流模式后缀（如从 `/v1beta/models/gemini-2.5-flash-think-high:generateContent` 还原出标准名 `gemini-2.5-flash`）。
  - **In-Flight 生命周期配对：**
    在调度成功后调用 `acquireInFlight`，在 `try ... finally` 块中保障无论成功、失败或中断必调用 `releaseInFlight`。
  - **客户端断开取消机制：**
    监听 Express `res.on("close")` 事件。若客户端中途断开，主动发送 WebSocket `cancel_request` 消息，通知 AI Studio 终止后台生成。

---

## 3. 完整调度流程详解

当客户端发起一个原生 Gemini 请求（如 POST `/v1beta/models/gemini-2.5-pro:generateContent`）时，调度器 `AccountScheduler.getNextAuthIndex(modelName)` 按照以下步骤执行调度：

```
[客户端请求到达]
       │
       ▼
1. 刷新系统活跃时间 (lastSystemActivityAt = Date.now())
   & 自动同步 browserManager.currentAuthIndex 状态为 ACTIVATED
       │
       ▼
2. 提取模型单账号每日上限 (dailyLimit, 来自 configs/models.json)
       │
       ▼
3. 扫描在线 WebSocket 账号 (hasConnection === true 且 usage < dailyLimit 且 inFlight < 2)
   分类收集:
   - activatedFree:     已激活且绝对空闲 (inFlight === 0)
   - activatedBusy:     已激活但正在处理 1 个请求 (inFlight === 1)
   - inactiveCandidates: 在线未激活账号 (INACTIVE)
       │
       ▼
4. 默认双账号底座维护 (Baseline = 2 Check)
   - 若 activated 账号总数 < 2 且冷却满 30s 且有 inactiveCandidates:
   - 触发激活第 2 个在线账号，并加入 activatedFree 队列
       │
       ▼
5. 阶段优先级调度选择
   ├───► 阶段 1: 若 activatedFree 非空:
   │            按模型用量 (usage) 升序选出空闲账号 (实现并发平摊与最少用量优先) ──► [分发请求]
   │
   ├───► 阶段 2: 主动并发扩容 (Scale-Out):
   │            若已激活账号都在处理请求 (inFlight > 0) 且有 inactiveCandidates 且冷却满 30s:
   │            主动激活第 3 个(或更多)账号 ─────────────────────────► [分发请求]
   │
   ├───► 阶段 3: 复用轻度繁忙账号:
   │            分发给 activatedBusy (inFlight === 1) 中 usage 最小的账号 ───────► [分发请求]
   │
   └───► 阶段 4: 极值判断与报错:
                ├── 若在线账号均满载 (inFlight >= 2):
                │   └─► 抛出 HTTP 503 Error ("All available accounts are busy at maximum concurrency limit")
                ├── 若在线账号均因用量超限 (usage >= dailyLimit):
                │   └─► 抛出 HTTP 429 Error ("All accounts reached daily limit...")
                └── 无在线 WebSocket:
                    └─► 抛出 HTTP 503 Error ("No active context connection available")
```

---

## 4. 配额限制配置指南 (`configs/models.json`)

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
  - 若不设置 `dailyLimit`，或设置为 `null` / `0` / `< 0`，代表该模型无使用上限限制。
  - 重置时间固定为北京时间每天下午 15:00:00。

---

## 5. 测试与验证

本子系统配备了完整的自动化单元与集成测试（共 40 个测试用例全部通过，ESLint 检查 0 错误）：

- **测试文件列表：**
  - `test/concurrent/model_usage_tracker.test.js`：验证北京時間 15:00 周期计算、计数累加与磁盘持久化。
  - `test/concurrent/account_scheduler.test.js`：验证状态机、首发账号同步、双账号底座自动拉起、30s 激活冷却、在途并发打散、`dailyLimit` 过滤、429 与 503 报错。
  - `test/concurrent/concurrent_request_handler.test.js`：验证路由拦截、状态码/Header 透传、模型名提取、inFlight acquire/release 配对与断开连接取消机制。
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
