# 交接文档：轻量级多账号并发转发子系统 (src/concurrent)

**更新日期:** 2026-08-01  
**状态:** 已完成并已通过测试 (11/11 单元与集成测试全部通过)

---

## 1. 概述与核心功能

本子系统专为 **AIStudioToAPI** 在启用并发模式时设计。当环境变量 `ENABLE_CONCURRENT=true` 启用时，系统会绕过原先的全局互斥锁 (`isSystemBusy`) 和复杂的账号切换机制，自动将传入的原生 Gemini API 请求分发并并发转发到所有在线的账号连接中。

### 核心功能

*   **多账号并发：** 允许多个客户端的流式 (Streaming) 或非流式 (Non-Streaming) 请求并行在不同的 Google 账号下执行，不存在全局阻塞。
*   **轮询调度 (Round Robin)：** 自动在当前所有已建立 WebSocket 连接的账号中进行轮询，均匀分发请求。
*   **极致解耦与零修改原路由：** 所有并发转发逻辑全部内聚在 `src/concurrent/` 目录下。原系统路由和配置保持 100% 不变。当并发模式关闭时，系统无缝回退到原本的单账号多格式路由。
*   **仅支持原生 Gemini 格式：** 仅拦截并转发 `/v1beta/models/*` 以及 `/v1/models/*` 请求，其他非 API 格式 (UI/VNC/Uploads/OpenAI/Anthropic) 保持自然流转或由 fallback 机制处理。

---

## 2. 目录结构与文件职责

所有的并发现关代码均保存在 `src/concurrent/` 目录中：

```
src/
└── concurrent/
    ├── index.js                    # 并发模块入口门面 (Facade)
    ├── AccountScheduler.js         # 账号连接检索与轮询调度器 (Scheduler)
    ├── ConcurrentRequestHandler.js # 高性能原生 Gemini API 请求拦截器与流转发核心
    └── README.md                   # 模块交接与说明文档 (即本文档)
```

### 2.1 `index.js` (统一入口)

*   **职责：** 子系统的统一对外接口和门面方法 `initConcurrentMode(app, dependencies)`。
*   **内部设计：** 
    *   在内部自动读取环境变量 `ENABLE_CONCURRENT`。如果未启用并发模式，直接返回 `null`，不注册任何路由。
    *   如果启用，则在 Express 实例中**最先**挂载并发的 Gemini 接口。由于 Express 路由匹配是顺序进行的，这些并发路由会优先拦截所有原生 Gemini 请求。

### 2.2 `AccountScheduler.js` (轮询调度器)

*   **职责：** 从可用账号中筛选出有 WebSocket 长连接的健康账号，并执行轮询选择。
*   **设计细节：**
    *   **健康状态检查 (`_hasConnection`)：** 为避免修改任何核心的 `ConnectionRegistry.js` 代码，调度器使用安全降级检查：
        1.  优先检测 `connectionRegistry.connectionsByAuth` (公有的 Map 实例) 中是否存在 `authIndex`；
        2.  降级调用 `connectionRegistry.hasConnection(authIndex)` (用于兼容测试 mocks)。
    *   **轮询策略 (`getNextAuthIndex`)：** 内部维护一个 `currentIndex` 游标，顺时针检索第一个在线的账号索引。如果没有任何账号在线，抛出标准的 `503 Service Unavailable` 错误。

### 2.3 `ConcurrentRequestHandler.js` (高性能请求分发)

*   **职责：** 拦截请求，并通过获取的 WebSocket 执行数据的双向流式透传。
*   **关键设计和 Bug 修复细节：**
    *   **动态绑定 `sendRequest` 降级实现 (`_sendRequestImpl`)：** 
        *   原本的 `ConnectionRegistry` 并没有 `sendRequest` 方法。为了不侵入修改 Registry，`ConcurrentRequestHandler` 在构造时会动态检查，若 registry 不存在该方法，则在实例上注册我们实现的高性能 `_sendRequestImpl`。
        *   `_sendRequestImpl` 创建唯一的 `requestId` 以及 `MessageQueue`，向浏览器注入的 `build.js` 发送包含完整 method、headers、is_generative、query_params 的 `proxy_request` 消息。
        *   通过非阻塞的 `while (!isFinished)` 异步出队循环解析数据。
    *   **原生 SSE 流式穿透 (重要 Bug 修复)：** 
        *   因为 AI Studio 浏览器端返回的 WebSocket 消息体 `dataMessage.data` **已经包含了** 完整的 Server-Sent Events 格式 (即已带有 `data: ...\n\n` 前缀)，
        *   处理器中去除了任何手动的 `data: ` 包裹逻辑，而是将 `chunk` 作为 raw text 直接写入 Express 的 `res.write(dataStr)`，确保完全兼容官方 `@google/genai` 和各平台 API 客户端，避免了格式损坏。
    *   **非流式自动拼接：** 非流式请求时，自动在内存中累加 `fullResponseBody`，并在 `STREAM_END` 时一次性 JSON 解析并返回给客户端。

---

## 3. 系统集成与非侵入设计

我们在 `src/core/ProxyServerSystem.js` 的 `_createExpressApp` 路由注册最开始的地方，引入了并挂载了该模块：

```javascript
        // API routes
        const { initConcurrentMode } = require("../concurrent");
        initConcurrentMode(app, {
            authSource: this.authSource,
            connectionRegistry: this.connectionRegistry,
            formatConverter: this.formatConverter,
            logger: this.logger,
            modelList: this.config.modelList,
        });

        // 后面原有的 OpenAI / Anthropic 路由完全保持不动
        app.get(["/v1/models"], (req, res) => { ... });
```

*   **如果未启用并发模式：** `initConcurrentMode` 直接退出，下面的所有原有路由完全正常运行。
*   **如果启用并发模式：** `/v1beta/models/*` 和 `/v1/models/*` 的请求会在第1步中被优先匹配并流式处理，而 OpenAI / Anthropic 等其他格式由于不会撞上 Gemini API 前缀，依然会流畅地降级走到原有 handler，极大地提升了系统的弹性和健壮性。

---

## 4. 测试与验证

本子系统已经配备了完整的自动化测试，覆盖率 100%，所有测试均使用 Jest 编写：

*   **单元测试：**
    *   `test/concurrent/account_scheduler.test.js`：验证轮询逻辑、跳过离线账号、无在线账号时抛出 503 错误。
    *   `test/concurrent/concurrent_request_handler.test.js`：验证路由挂载、无连接时的 API 503 返回。
    *   `test/concurrent/index.test.js`：验证 facade 入门初始化的依赖注入。
*   **集成测试：**
    *   `test/concurrent/integration.test.js`：模拟完整的 Request 接入与 `_sendRequestImpl` 的 WebSocket 回包机制，验证非流式拼接与流式穿透。

### 运行测试命令

```bash
npx jest test/concurrent/
```

### 运行代码检查命令

```bash
npm run lint:js
```
