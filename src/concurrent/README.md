# 交接文档：轻量级多账号并发转发子系统 (src/concurrent)

**更新日期:** 2026-08-02  
**状态:** 已升级完成并已通过测试 (32/32 单元与集成测试全部通过，ESLint 0 Error)

---

## 1. 概述与核心功能

本子系统专为 **AIStudioToAPI** 在启用并发模式时设计。当环境变量 `ENABLE_CONCURRENT=true` 启用时，系统会绕过原先的全局互斥锁 (`isSystemBusy`) 和复杂的账号切换机制，自动将传入的原生 Gemini API 请求分发并并发转发到所有健康的在线账号连接中。

### 核心功能

- **多账号并发透传：** 允许多个客户端的流式 (Streaming) 或非流式 (Non-Streaming) 请求并行在不同的 Google 账号下执行，不存在全局阻塞。
- **智能配额与激活调度：** 结合模型每日上限 (`dailyLimit`)、按模型使用量优先 (Least-Used First)、页面激活状态机 (State Machine) 与懒加载 (Lazy Loading) 策略，实现智能均衡调度。
- **极致解耦与零修改原路由：** 所有并发转发逻辑全部内聚在 `src/concurrent/` 目录下。原系统路由和配置保持 100% 不变。当并发模式关闭时，系统无缝回退到原本的单账号多格式路由。
- **仅支持原生 Gemini 格式：** 仅拦截并转发 `/v1beta/models/*` 以及 `/v1/models/*` 请求，其他非 API 格式 (UI/VNC/Uploads/OpenAI/Anthropic) 保持自然流转或由 fallback 机制处理。

---

## 2. 目录结构与文件职责

所有的并发现关代码均保存在 `src/concurrent/` 目录中：

```
src/
└── concurrent/
    ├── index.js                    # 并发模块入口门面 (Facade)
    ├── AccountScheduler.js         # 智能账号调度器 (Scheduler & State Machine)
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

- **职责：** 管理账号激活状态机、执行单模型配额过滤，并根据“当前模型用量最少”优先分发请求。
- **状态机设计：**
  - 账号状态分为：`INACTIVE`（初始/离线/未解卡）、`ACTIVATING`（正在激活）、`ACTIVATED`（已解卡且可用）。
- **激活与懒加载策略：**
  - **账号激活 (`activateAccount`)：** 调用 `browserManager.launchOrSwitchContext(i)` 切换 Playwright 焦点，并向页面发送 `ActiveTrigger` 探测请求，触发 AI Studio 自动清理 `Launch / Rocket` 遮罩按钮。
  - **懒加载与空闲降级 (Lazy Loading)：** 记录系统最后请求时间 `lastSystemActivityAt`。若 5 分钟内有 API 请求，属于活跃期；若超过 5 分钟无请求，自动暂停后台批量激活轮询，仅保留前台单账号维持，避免无谓的 context 切换消耗。
- **完整调度流程 (`getNextAuthIndex(modelName)`)：**
  详见本文档 [第 3 节：完整调度流程](#3-完整调度流程详解)。

### 2.4 `ConcurrentRequestHandler.js` (高性能请求分发)

- **职责：** 拦截请求，解析标准化模型名，透传真实状态码/Header，并在客户端断开时发送取消命令。
- **关键设计细节：**
  - **模型名标准化 (`_extractCleanModelName`)：**
    利用 `FormatConverter` 工具函数剥离模型路径中的工具/思维/流模式后缀（如从 `/v1beta/models/gemini-2.5-flash-think-high:generateContent` 还原出标准名 `gemini-2.5-flash`），确保限额匹配与统计准确。
  - **状态码与 Header 透传：**
    解析 WebSocket 返回的 `response_headers`，透传真实的 HTTP 状态码和响应 Header（过滤掉 `transfer-encoding` 等 Hop-by-Hop 标头）。
  - **错误结构映射：**
    将 429 报错映射为 Gemini 标准 error 对象 `{ error: { code: 429, message: "...", status: "RESOURCE_EXHAUSTED" } }`。
  - **客户端断开取消机制：**
    监听 Express `res.on("close")` 事件。若客户端中途断开且响应未结束，主动向 WebSocket 发送 `cancel_request` 消息，通知 AI Studio 终止后台生成，节省账号配额。

---

## 3. 完整调度流程详解

当客户端发起一个原生 Gemini 请求（如 POST `/v1beta/models/gemini-2.5-pro:generateContent`）时，调度器 `AccountScheduler.getNextAuthIndex(modelName)` 按照以下 5 个步骤执行调度：

```
[客户端请求到达]
       │
       ▼
1. 刷新系统活跃时间 (lastSystemActivityAt = Date.now())
   & 解析模型名 (cleanModelName = "gemini-2.5-pro")
       │
       ▼
2. 提取该模型配置的单账号每日上限 (dailyLimit, 来自 configs/models.json)
       │
       ▼
3. 扫描当前所有在线 WebSocket 连接 (hasConnection === true)
   ┌─────────────────────────────────────────────────────────────┐
   │ 过滤条件 A: 账号在当天的统计用量 < dailyLimit              │
   │ 过滤条件 B: 账号页面状态 == "ACTIVATED" (已点击 Launch 按钮) │
   └─────────────────────────────────────────────────────────────┘
       │
       ├───► [找到 1 个或多个符合条件的 ACTIVATED 账号]
       │            │
       │            ▼
       │     按当前模型用量 (usageCount) 升序排序
       │     (用量最少的账号优先；用量相同时按 Round-Robin 顺时针顺序)
       │            │
       │            ▼
       │     返回最优账号 authIndex，更新 Round-Robin 游标 ───► [分发请求]
       │
       └───► [未找到已 ACTIVATED 的可用账号]
                    │
                    ▼
       4. 降级检查：寻找在线、未超限但状态为 "INACTIVE" 的账号
                    │
                    ├───► [存在符合条件的 INACTIVE 账号]
                    │            │
                    │            ▼
                    │     选取顺位第一个账号，同步执行 activateAccount(authIndex)
                    │     (切换 Context -> 发送 ActiveTrigger 探测 -> 清除 Launch 遮罩)
                    │            │
                    │            ├───► [激活成功] ──► 标记为 ACTIVATED ──► [分发请求]
                    │            └───► [激活失败] ──► 尝试下一个账号
                    │
                    └───► [无可激活账号 / 所有在线账号均已超限]
                                 │
                                 ▼
                      5. 异常判断与响应
                         ├── 若在线账号全因 usage >= dailyLimit 被排除:
                         │   └─► 抛出 HTTP 429 Error (RESOURCE_EXHAUSTED)
                         └── 若无任何在线 WebSocket 连接:
                             └─► 抛出 HTTP 503 Error (UNAVAILABLE)
```

---

## 4. 配额限制配置指南 (`configs/models.json`)

在 `configs/models.json` 对应的模型定义中添加 `dailyLimit` 可选整数字段（每个账号在该模型上的每日最大请求次数）：

```json
{
  "name": "models/gemini-2.5-pro",
  "displayName": "Gemini 2.5 Pro",
  "dailyLimit": 50,
  "inputTokenLimit": 1048576,
  "outputTokenLimit": 65536
}
```

* **说明：**
  * 若不设置 `dailyLimit`，或设置为 `null` / `0` / `< 0`，代表该模型无使用上限限制。
  * 重置时间固定为北京时间每天下午 15:00:00。

---

## 5. 测试与验证

本子系统配备了完整的自动化单元与集成测试（共 32 个测试用例全部通过，ESLint 检查 0 错误）：

- **测试文件列表：**
  - `test/concurrent/model_usage_tracker.test.js`：验证北京時間 15:00 周期计算、计数累加与磁盘持久化。
  - `test/concurrent/account_scheduler.test.js`：验证状态机、激活流程、最小用量优先调度、`dailyLimit` 过滤与 429 报错。
  - `test/concurrent/concurrent_request_handler.test.js`：验证路由拦截、状态码/Header 透传、模型名提取与断开连接取消机制。
  - `test/concurrent/index.test.js`：验证统一入口初始化。
  - `test/concurrent/integration.test.js`：验证完整的端到端请求分发与响应流透传。

### 运行测试命令

```bash
npx jest test/concurrent/
```

### 运行代码检查命令

```bash
npm run lint:js
```
