# 系统设计规格说明书（System Design Spec）：WebUI 历史保留条数动态配置优化

本文档详细规划了 **AIStudioToAPI** 服务中，在 WebUI 页面中动态调节“统计历史最大保留数（`statsMaxRecords`）”的设计。该功能允许管理员在主控面板直接输入或微调该阈值，并由后端在接收到修改指令时，**实时对内存中的记录执行自适应修剪**，提供无缝热配置支持。

## 一、 系统架构与流程（Interactive Hot-Swap Flow）

系统建立了一条从 WebUI 前端到后端运行期状态机的指令传递链：

```
+------------------------------------------------------------------------+
|                                  Frontend (Vue 3 UI)                   |
|                                                                        |
|                 Admin adjusts state.statsMaxRecords                    |
|                Sends PUT /api/settings/stats-max-records               |
+------------------------------------------------------------------------+
                                  |
                                  v
+------------------------------------------------------------------------+
|                                  StatusRoutes.js                       |
|                                                                        |
|  - Updates config.statsMaxRecords dynamically.                         |
|  - Triggers immediate runtime memory arrays pruning:                   |
|    IF usageStatsService.records.length > newCount:                     |
|       usageStatsService.records = records.slice(-newCount)             |
+------------------------------------------------------------------------+
                                  |
                                  v
+------------------------------------------------------------------------+
|                                  UsageStatsService.js                  |
|                                                                        |
|  - Runs the rest of the uptime with the newly updated memory ceiling   |
+------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

### 1. 后端：动态控制接口路由与内存实时净化 (`src/routes/StatusRoutes.js`)

*   **新增 API 路由 `PUT /api/settings/stats-max-records`**：
    该路由接收前端传入的新阈值，不仅完成系统全局变量 `config.statsMaxRecords` 的覆写，还会立即通知 `usageStatsService` 释放超出部分的陈旧内存（实现瞬间释放网络宽带与服务器开销）：
    ```javascript
    app.put("/api/settings/stats-max-records", isAuthenticated, (req, res) => {
        const { count } = req.body;
        const newCount = parseInt(count, 10);

        if (Number.isFinite(newCount) && newCount > 0) {
            this.config.statsMaxRecords = newCount;
            this.logger.info(`[WebUI] Stats max records limit hot-switched to: ${newCount}`);
            
            // 立即净化内存常驻数组
            const usageStatsService = this.serverSystem.usageStatsService;
            if (usageStatsService && Array.isArray(usageStatsService.records)) {
                if (usageStatsService.records.length > newCount) {
                    usageStatsService.records = usageStatsService.records.slice(-newCount);
                    this.logger.info(`[UsageStats] Instantly pruned memory records down to ${newCount} due to config change.`);
                }
            }
            
            res.status(200).json({ message: "settingUpdateSuccess", setting: "statsMaxRecords", value: newCount });
        } else {
            res.status(400).json({ error: "Invalid count", message: "settingFailed" });
        }
    });
    ```
*   在 `_getStatusData()` 返回体 `status` 块中加入字段：`statsMaxRecords: config.statsMaxRecords`，让轮询能够第一时间刷新。

---

### 2. 前端：UI 数字调节器与设置逻辑开发 (`StatusPage.vue`)

*   **HTML 结构设计**：
    在 `ui/app/pages/StatusPage.vue` 的系统设置区（大约在 `logMaxCount` 附近）追加一行极简、精美的 Element-Plus `<el-input-number>` 数字调节器：
    ```html
    <div class="switch-container">
        <span class="label">
            <!-- Renders standard file list icon -->
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 6px; vertical-align: middle;">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
            {{ t("statsMaxRecords") }}
        </span>
        <el-input-number
            v-model="state.statsMaxRecords"
            :min="100"
            :max="100000"
            :step="500"
            size="small"
            style="width: 120px"
            @change="handleStatsMaxRecordsChange"
        />
    </div>
    ```
*   **JS 交互状态逻辑**：
    *   在 `state` 初始化定义中注入默认属性：`statsMaxRecords: 5000`。
    *   在 `updateStatus()` 函数中同步值：`state.statsMaxRecords = data.status.statsMaxRecords ?? 5000;`。
    *   在动作方法中编写专属的异步请求函数 `handleStatsMaxRecordsChange`，接收成功并调用 `ElMessage.success`。

---

### 3. 多语言词条 (`ui/locales/en.json` & `ui/locales/zh.json`)

*   `en.json`：
    `"statsMaxRecords": "Max Stats Records Limit"`
*   `zh.json`：
    `"statsMaxRecords": "统计历史最大保留数"`

---

## 三、 验证与测试（Verification & Test）

1.  **UI 参数热应用测试**：
    在运行状态下，在 Web 界面上将“统计历史最大保留数”从 `5000` 调节为 `100` 并确定。
    *   验证控制台立即输出内存裁剪日志：`Pruned memory records down to 100`。
    *   验证随后前端定时轮询获取的 snap records 数组长度立即收紧至最多 `100` 条。
2.  **代码合规性检验**：
    运行 `npx eslint` 确保修改后文件的格式及 Props 参数分类重排完美通过。
