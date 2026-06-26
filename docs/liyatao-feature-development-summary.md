# AIStudioToAPI 开发功能与需求实现盘点报告

本文档总结了开发者 `liyatao` 自 2026 年 5 月底以来针对 **AIStudioToAPI** 代理服务所进行的一系列核心稳定性、深度调试、账户管控和协议转换的重大功能研发成果。
claude --resume fdeebd9e-9f2d-4faf-8e60-c7d9c022f011

---

## 一、 调试与故障诊断平台（Diagnosis & Observer Platform）

这是近期研发中投入最大、最显著提升项目生产环境可用性的底层模块：

### 1. 账号初始化/重连失败截图与源码快照（Debug Snapshots）

- **需求背景**：当账号因网络波动、Google 登录态失效或 `rocket_launch`（Continue to the app）按钮未成功点中导致重连/初始化失败时，后台难以排查根本原因。
- **实现细节**：
  - **自动捕获**：在 `BrowserManager.js` 的 `_saveDebugArtifacts` 核心方法中，当触发 `init_failed`、`reconnect_expired`、`reconnect_failed` 等致命重连或初始化失败事件时，自动在后台截取当前浏览器全页面的 PNG，并导出完整的页面源码 DOM HTML 文本，集中统一存入 `data/debug/` 下。
  - **快照 REST API**：在 `StatusRoutes.js` 中开发了 Snapshots GET/DELETE API（`/api/snapshots`）。
  - **前端可视化 Debug 面板**：在 UI 侧新增了 **Debug (故障快照)** Tab 栏，用表格展示所有失败事件，支持在弹窗（Dialog）中直观预览截图（`el-dialog` img）和嵌入式 iframe 安全查看页面源码 HTML。

### 2. API 翻译对照调试器（API Translation Inspector）

- **需求背景**：当第三方客户端请求协议转换出错时，需要精准、一目了然地定位“客户端发包格式”、“格式转 Gemini Payload”、“Gemini 原生 SSE 返回”和“翻译转最终回包”在哪个环节产生了数据断裂。
- **实现细节**：
  - **全链路 Payload 抓取**：在 `RequestHandler.js` 中，分别在流式（Real-stream SSE, Fake-stream）和非流式生命周期里，对客户端原始请求 (`open_req`/`claude_req`)、翻译后 Gemini 参数体 (`gem_req`)、Gemini 原始响应 (`gem_res`) 和吐回客户端响应 (`open_res`/`claude_res`) 进行抓取落盘。
  - **动态格式适配与对齐**：支持检测并提取 **Gemini Native、OpenAI Chat Completions、Claude API、OpenAI Response API** 等不同协议格式的专属后缀（如 `claude_req`、`open_res`），并在前端通用化映射显示。
  - **4 栏可视化 Inspector**：在“使用统计 (Stats) -> 请求记录”表格的每一行最右侧，新增放大镜按钮。点击可加载带骨架屏（`v-loading`）的对比弹窗，用 VS Code 风格渲染四重对照，并带有“一键复制到剪贴板”功能。
  - **一键全清（Purge All）**：修改了快照一键清理接口，在点击清空快照时，同步自动净化磁盘中的 transaction JSON 日志文件，防止磁盘满溢。

### 3. 调试日志开关控制（ENABLE_TRANSLATION_LOGGING）

- **需求背景**：生产高并发环境下，无节制的磁盘 I/O 写入会 wear down 硬盘、占满 inode 或拉低并发速度。
- **实现细节**：
  - 引入 `ENABLE_TRANSLATION_LOGGING` 环境变量（默认：`false`），加载于 `ConfigLoader.js`，并在启动时打印其状态。
  - 一键 Gate 所有的落盘写操作。只有在开发调试环境显式开启时，才进行 Payload 录制，达到极致的生产环境高性能。

---

## 二、 账户管理与统计优化（Account Control & Stats Extensions）

针对多账号轮询切换和日常运营统计，开发了高实用性的小组件：

### 4. 账号“今日成功请求数”统计药丸 Badge（Today Usage Badge）

- **需求背景**：管理员需要一目了然地看出各个登录账号在今日的活跃调用频率，以此确定负载是否均衡或有无无效账号。
- **实现细节**：
  - **15:00 跨时区起算**：在前端利用 Vue Computed 计算属性，对所有 records 历史进行 timezone-aware 动态过滤，起算时间统一对齐 Statistics 的 **今日 15:00:00 边界**。
  - **前端零 overhead 聚合 (1-C 口径)**：直接从前端 `statsState.records` 响应式数据中累加，无需修改任何后端数据库或增加 API。统计包含了 `generation`、`count_tokens` 等所有 outcome 为 `success` 的调用。
  - **悬停模型分布 (2-A 样式)**：在账号管理列表中展示 `Today: X` 或 `今日: X` 的浅蓝色药丸 Badge。鼠标悬浮其上时，展示 Element Tooltip，列出该账号今天消耗的各模型分布明细。

### 5. 账号启用与禁用支持 (Enable/Disable Accounts)

- **需求背景**：某些账号被风控或需要临时维护，但不想直接删除其 auth JSON 配置文件。
- **实现细节**：
  - 在主页账号控制面板为每个账号卡片新增 **启用/禁用** 独立切换按钮。
  - 被禁用的账号打上 `tagDisabled` 灰色标签并进入 `disabledIndicesRaw` 阵营，自动从后端的轮询、重试与可用路由队列中过滤剔除，无需重启服务。

---

## 三、 接口协议与路由修复（Protocol Bridge & Robust Routing）

对系统中最复杂的协议转换和重试容错层进行了大刀阔斧的优化：

### 6. OpenAI Responses API 工具/工具选择转换优化

- **需求背景**：Codex 或其他高级客户端在调用 `/v1/responses` 时，常使用 Chat-Completions 的嵌套结构，或直接省去 `"type": "function"` 外壳，导致原有转换器完全失联。
- **实现细节**：
  - 重构了 `FormatConverter.js`，实现工具解析自动“刺穿”（Pierce）多层嵌套（例如支持 `t.function.name` 代替 `t.name`）。
  - 支持了强制工具约束（`tool_choice` 为强制 function），并能自动升级强制调用配置模式为 `ANY` 约束。

### 7. 稳健的流式 SSE 状态自愈（Self-Healing Real Streams）

- **需求背景**：真实 SSE 场景中，当 Google 浏览器端异常切断连接时，后端流无法正常收到 `finishReason`，导致流一直处于挂起或非正常截断状态。
- **实现细节**：
  - 在 `_streamOpenAIResponseAPIResponse` 中，加入了**“流自愈”**机制。若流已初始化但未正常 `completed` 却收到了 `STREAM_END`，系统会自动追加生成一个 `finishReason: "STOP"` 的闭合 Candidate chunk，强制客户端优雅闭合，解决了 SSE 客户端长连接假死问题。

### 8. 平文本输出 JSON 解析防报错（safeParseJSON Optimization）

- **需求背景**：如果工具返回的是 `"Chunk ID: 123"` 这样的平文本而非标准 JSON，系统以往在尝试 `JSON.parse` 时会把堆栈 Warning 日志刷满控制台。
- **实现细节**：
  - 优化 `safeParseJSON`，在解析前先利用快速正则/字符判断其是否以 `{` 或 `[` 开头。若非 JSON 直接优雅退回平文本，并将真正发生的 JSON 失败日志降级为 `logger.debug` 打印，使服务器运行日志极度清爽。

---

## 四、 其他系统级稳定性调优（Minor Stability & UX Patches）

- **路由错配修复**：将前端请求的后台接口从错配的 `/api/debug/snapshots` 统一定格为 `/api/snapshots`，消除了前端静态资源找不到路由的 404 报错。
- **性能提升 (屏蔽 GitHub 更新)**：屏蔽了前端每次刷新加载都会向 GitHub 请求新版本的行为（已设置 remote checks 屏蔽），转而使用纯本地 3 秒一次的定格状态刷新。
- **防死锁保护 (WebSocket 强校验)**：在请求路由前，强行校验 WebSocket 连接是否处于 `readyState === 1 (OPEN)` 状态，而不是只检测连接对象是否存在，彻底解决了旧连接处于 CLOSE_WAIT 时发包假死的问题。
- **404 账号轮空容错**：当轮询队列中所有账号均不可用时，优雅退回返回 404，而不是让客户端请求无限期 Hanging 挂起。
- **前端死循环定时器修复**：修复了 StatusPage.vue 在加载时，由于多重副作用重叠导致的创建多个平行并发 status 定时刷新的死循环，将刷新严格锁定在单个计时器内。
- **安全工作流规范锁定**：在 `CLAUDE.md` 中以铁律写入“严禁 AI 自动合并或提交代码至 `main` 主分支”，并且成功配置了会话级别的 [[MEMORY]]，捍卫主分支的高安全、高稳定性发布状态。
