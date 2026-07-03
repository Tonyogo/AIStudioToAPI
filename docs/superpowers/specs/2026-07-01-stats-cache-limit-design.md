# 系统设计规格说明书（System Design Spec）：使用统计历史记录内存修剪优化

本文档详细规划了 **AIStudioToAPI** 服务中，针对使用统计历史记录（`usage-stats.jsonl`）的内存修剪（Max Records Clamping）方案。该功能通过在后端引入可配置的 `STATS_MAX_RECORDS` 阈值，强行在服务启动载入、运行时请求追加及文件导入时对内存数组执行 `slice` 截断，将内存占用和 API 回包体积牢牢锁在安全且轻量的分界线（默认 5000 条）内，实现服务的终身不崩溃高可用。

## 一、 系统架构与流程（Clamping Logic Flow）

系统的 `UsageStatsService` 将会严格根据全局配置的 `statsMaxRecords`，在启动、运行及导入三个数据切片阶段进行物理硬限拦截，仅保留最新的 $N$ 条数据：

```
+------------------------------------------------------------------------+
|                                 ConfigLoader.js                        |
|                                                                        |
|                  Loads STATS_MAX_RECORDS from environment              |
|                             (defaults to 5000)                         |
+------------------------------------------------------------------------+
                                  |
                                  v Exposes config.statsMaxRecords
+------------------------------------------------------------------------+
|                               UsageStatsService.js                     |
|                                                                        |
|  - Step A: During startup read (_loadFromFile):                        |
|    Only load and recalculate the latest N records from JSONL file      |
|                                                                        |
|  - Step B: During request finalize (finishRequest):                    |
|    Append to memory, then clamp this.records to the last N records     |
|                                                                        |
|  - Step C: During JSONL backup imports (_importJsonlContent):          |
|    Deduplicate and clamp the final memory array to the last N records  |
+------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

### 1. 后端：系统配置读取与环境变量注入 (`ConfigLoader.js`)

*   **配置项拓展 (`src/utils/ConfigLoader.js`)**：
    *   在默认配置字典中声明：`statsMaxRecords: 5000`（5000 条是一个极其充沛、能覆盖数日历史且包体积仅 ~1.5MB 的黄金分界线）。
    *   在 `loadConfiguration()` 方法内读取并解析环境变量 `STATS_MAX_RECORDS`：
        ```javascript
        if (process.env.STATS_MAX_RECORDS) {
            const parsed = parseInt(process.env.STATS_MAX_RECORDS, 10);
            config.statsMaxRecords = Number.isFinite(parsed) ? Math.max(1, parsed) : config.statsMaxRecords;
        }
        ```
    *   在 `_printConfiguration` 中打印：`Max Stats Records Limit: 5000`。

---

### 2. 后端：核心统计历史数组自动修剪机制 (`UsageStatsService.js`)

我们在 `UsageStatsService` 的 3 个核心入口点，执行无感知的 `.slice(-limit)` 强行截断：

*   **运行追加阶段 (`finishRequest`)**：
    每当有新的客户端请求结束时，向内存数组追加数据后，立即判断并修剪：
    ```javascript
    this.records.push(record);
    
    // 强行修剪最新 N 条，保护内存和 getSnapshot API 回包大小
    const limit = this.serverSystem?.config?.statsMaxRecords || 5000;
    if (this.records.length > limit) {
        this.records = this.records.slice(-limit);
    }
    
    this._updateSummary(record);
    ```
*   **启动加载阶段 (`_loadFromFile`)**：
    启动加载 `usage-stats.jsonl` 重建内存储备时：
    ```javascript
    _loadFromFile() {
        try {
            const { records } = this._readRecordsFromFile();
            if (records.length === 0 && !fs.existsSync(this.statsFilePath)) return;
    
            // 启动时仅加载并重排最新的 N 条记录
            const limit = this.serverSystem?.config?.statsMaxRecords || 5000;
            const trimmedRecords = records.slice(-limit);
    
            this._replaceRecords(trimmedRecords);
            this._recalculateFromRecords();
        }
    ```
*   **备份导入阶段 (`_importJsonlContent`)**：
    管理员手动导入大体积 JSONL 文件恢复状态后，同样执行修剪：
    ```javascript
    this._replaceRecords(mergedRecords);
    
    // 强制修剪导入结果
    const limit = this.serverSystem?.config?.statsMaxRecords || 5000;
    if (this.records.length > limit) {
        this.records = this.records.slice(-limit);
    }
    
    this._recalculateFromRecords({ resetStartedAt: false });
    ```

---

## 三、 验证与测试（Verification & Test）

1.  **冷启动内存硬限制测试**：
    在 `data/usage-stats.jsonl` 中伪造 10,000 条历史请求记录。
    *   启动服务，验证后台成功输出：`Max Stats Records Limit: 5000`。
    *   验证 `UsageStats` 的日志信息输出：`[UsageStats] Loaded 5000 records`（证明冷启动未将全部 1 万条塞进内存，硬限成功过滤）。
2.  **API 宽带负载测试**：
    在请求记录跑满后，请求 `GET /api/status` 或 `/api/usage-stats`，验证返回的 JSON 结构中 `records` 数组的长度严格等同于 `5000`（或配置的其它上限值），无任何内存膨胀，接口秒级响应。
3.  **代码合规性检验**：
    运行 `npx eslint` 确保修改后文件的格式及 Props 参数字母序排列完美通过。
