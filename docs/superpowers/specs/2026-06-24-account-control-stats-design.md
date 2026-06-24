# 系统设计规格说明书（System Design Spec）：账户管理与统计优化

本文档详细规划了 **AIStudioToAPI** 服务中，针对账号启用/禁用（Enable/Disable Accounts）和账号今日成功请求数统计药丸（Today Usage Badge）的详细系统设计。该功能在无需重启服务的前提下，通过纯前端零 overhead 统计和后端热加载机制，极大增强了系统的灵活性与可观测性。

## 一、 系统架构与流程（Architecture & Control Flow）

本项目采用的架构整合了文件状态管理、即时后台 Context 回收、以及完全响应式的前端统计：

```
+------------------------------------------------------------------------+
|                                  Frontend (Vue 3 UI)                   |
|                                                                        |
|  +--------------------+   +-----------------------+                    |
|  |   Account Card     |   |   accountTodayStats   |                    |
|  |  [Enable/Disable]  |   |  (CST 15:00 computed) |                    |
|  +---------+----------+   +-----------+-----------+                    |
+------------|--------------------------|--------------------------------+
             | HTTP PUT                 | Read (Reactive)
             v (Toggle)                 v
+------------|--------------------------|--------------------------------+
|            |                          | statsState.records             |
|            v                          |                                |
|  +---------+----------+               |                                |
|  | /api/accounts/...  |               |                                |
|  | /toggle-disabled   |               |                                |
|  +---------+----------+               |                                |
|            |                          |                                |
|            v                          |                                |
|  +---------+----------+               |                                |
|  |    AuthSource      |---------------+                                |
|  |  (disabledIndices) |                                                |
|  +---------+----------+                                                |
|            |                                                           |
|            v Rebuild rotationIndices                                   |
|  +---------+----------+                                                |
|  |  BrowserManager    |                                                |
|  | (Rebalance & Close)|                                                |
|  +--------------------+                                                |
|                                                                        |
|                               Backend (Node.js)                        |
+------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

### 1. 后端：数据持久化与 rotationIndices 拦截 (`src/auth/AuthSource.js`)

在每个账号的 Playwright 状态配置文件 `configs/auth/auth-N.json` 中，引入自定义可选键 `"disabled": true`（该属性会被 Playwright 自动忽略，符合高稳定性原则）。

*   **内部状态拓展**：
    *   `this.disabledIndices` (数组): 用于缓存在启动和文件扫描时解析出 `disabled === true` 的有效 auth 文件索引。
*   **方法改造与设计**：
    *   **文件预校验和过滤 (`_preValidateAndFilter`)**：
        当从硬盘中加载账号并成功解析出 JSON 数据后，若 `authData.disabled === true`，则将此 `index` 添加入 `this.disabledIndices`。
    *   **热生成轮询队列 (`_buildRotationIndices`)**：
        原本的轮询和重试队列是用 `availableIndices`（全部有效账号）减去 `expiredIndices`（已失效账号）。我们将进一步拦截：
        ```javascript
        // 仅将既未过期也未被禁用的账号加入活跃轮询队列
        const activeIndices = this.availableIndices.filter(
            idx => !this.expiredIndices.includes(idx) && !this.disabledIndices.includes(idx)
        );
        ```
    *   **添加判断函数 (`isDisabled(index)`)**：
        ```javascript
        isDisabled(index) {
            return this.disabledIndices.includes(index);
        }
        ```
    *   **启用/禁用一键落盘 API 方法 (`markAsDisabled` & `unmarkAsDisabled`)**：
        *   `markAsDisabled(index)`：
            1. 校验 `index` 是否在 `availableIndices` 内。
            2. 读取 `configs/auth/auth-N.json`，在 JSON 体中填入 `"disabled": true`，并覆写写回磁盘。
            3. 将该索引加入 `this.disabledIndices` 缓存。
            4. 触发 `_buildRotationIndices()` 重建路由可用队列，确保后续请求重试或负载均衡立即将其隔离。
        *   `unmarkAsDisabled(index)`：
            1. 读取 `configs/auth/auth-N.json`，在 JSON 体中删除 `disabled` 属性（或覆写为 `false`）。
            2. 将该索引从 `this.disabledIndices` 移除，并调用 `_buildRotationIndices()` 释放路由隔离。

---

### 2. 后端：安全控制与会话资源回收 (`src/core/BrowserManager.js` & `src/routes/StatusRoutes.js`)

为了实现被禁用账号“即时销毁、杜绝挂载、拦截手动路由”的目标：

*   **多开资源平衡回收 (`BrowserManager.js`)**：
    *   在 `rebalanceContextPool()` 方法中，多开模式下检测候选者时过滤掉 `isDisabled`：
        ```javascript
        // 过滤出未过期且未禁用的可用列表
        const activeAvailable = this.authSource.availableIndices.filter(
            idx => !this.authSource.isExpired(idx) && !this.authSource.isDisabled(idx)
        );
        targets = new Set(activeAvailable);
        ```
    *   在 `preCleanupForSwitch()` 中，若当前内存接近或达到上限，将 `disabledIndices` 列入 **Priority 2**（高优先级清除队列，同 `expired` 逻辑一致），使其在切换时优先被移出内存。
*   **状态接口与操作接口路由 (`StatusRoutes.js`)**：
    *   **新增 API 路由 `PUT /api/accounts/:index/toggle-disabled`**：
        1. 验证目标账号。
        2. 判断其当前是否已禁用，并调用 `authSource.markAsDisabled` / `unmarkAsDisabled` 热落盘。
        3. **资源即时销毁**：若操作为“禁用”，立刻强制执行：
           ```javascript
           await this.serverSystem.browserManager.closeContext(index);
           this.serverSystem.connectionRegistry.closeConnectionByAuth(index);
           ```
           销毁其对应的 Playwright 账号标签与 WebSocket 连接，避免该账号在内存中存留。
        4. 并发非阻塞地调用 `rebalanceContextPool()`。
        5. 返回对应的国际化信息：`accountDisabledSuccess` 或 `accountEnabledSuccess`。
    *   **拦截手动强制切换 (`PUT /api/accounts/current`)**：
        在接收手动 `targetIndex` 切换参数时，若 `authSource.isDisabled(targetIndex)` 为真，直接返回 400 校验错误：
        ```javascript
        if (this.serverSystem.authSource.isDisabled(targetIndex)) {
            return res.status(400).json({ message: "accountSwitchFailed", reason: "Account is disabled." });
        }
        ```
    *   **系统状态同步 (`_getStatusData`)**：
        在状态响应 json 中，返回 `disabledIndicesRaw`。在 `accountDetails` 的列表项映射中追加 `isDisabled: authSource.isDisabled(index)`，方便前端一目了然渲染。

---

### 3. 前端： timezone-aware 请求统计与控制药丸 (`ui/app/pages/StatusPage.vue`)

不修改任何后端统计数据库，纯前端零 overhead 计算：

*   **起算时间统一对齐美西太平洋零点（15:00:00 边界计算属性）**：
    在 `StatusPage.vue` 中新增 computed `accountTodayStats`：
    ```javascript
    const accountTodayStats = computed(() => {
        const stats = {}; // authIndex -> { totalSuccess: 0, models: { [modelName]: count } }
        
        // 时区自适应计算 15:00 边界 (UTC 07:00:00)
        const now = new Date();
        const today15CST = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0));
        const boundaryTs = now.getTime() >= today15CST.getTime() 
            ? today15CST.getTime() 
            : today15CST.getTime() - 24 * 60 * 60 * 1000;
            
        statsState.records.forEach(record => {
            if (record.outcome !== "success") return;
            
            const recordTime = record.startedAt ? new Date(record.startedAt).getTime() : 0;
            if (recordTime < boundaryTs) return;
            
            const authIndex = record.finalAuthIndex;
            if (authIndex === null || authIndex === undefined) return;
            
            if (!stats[authIndex]) {
                stats[authIndex] = { totalSuccess: 0, models: {} };
            }
            stats[authIndex].totalSuccess++;
            
            const modelName = record.model || "unknown";
            stats[authIndex].models[modelName] = (stats[authIndex].models[modelName] || 0) + 1;
        });
        
        return stats;
    });
    ```
*   **账号管理卡片 Badge 渲染**：
    *   在账号名称后方渲染浅蓝色药丸 Badge (文案为 `Today: X` 或 `今日: X`)。
    *   鼠标悬浮在其上时使用 `el-tooltip` 浮层，直观列出今日所有模型的成功请求分布明细。
    *   如账号今日成功请求数为 0，则 Badge 显示为 `0`；悬浮显示“今日暂无成功请求”。
*   **启用/禁用 UI 控制**：
    *   为列表每一项在 `.account-actions` 栏添加一键“启用/禁用”动作按钮。
    *   对于已禁用的账号：
        *   列表追加显示 `tagDisabled` 灰色标签。
        *   “手动切换至该账号”按钮设为 `disabled` 状态。
        *   利用 Lucide `Eye` (未禁用时显示，点击禁用) 与 `EyeOff` (禁用时显示，点击启用) 图标或类似图标渲染。

---

## 三、 多语言与测试（Locales & Test Strategy）

### 1. 多语言资源 (`ui/locales/en.json` & `ui/locales/zh.json`)

#### 英文 (`en.json`)
```json
{
    "tagDisabled": "Disabled",
    "todayUsage": "Today: {count}",
    "modelDistribution": "Model Distribution",
    "noModelData": "No successful request today",
    "accountDisabledSuccess": "Account #{index} disabled successfully.",
    "accountEnabledSuccess": "Account #{index} enabled successfully.",
    "btnDisableUser": "Disable Account",
    "btnEnableUser": "Enable Account"
}
```

#### 中文 (`zh.json`)
```json
{
    "tagDisabled": "已禁用",
    "todayUsage": "今日: {count}",
    "modelDistribution": "模型分布明细",
    "noModelData": "今日暂无成功请求",
    "accountDisabledSuccess": "账号 {index} 禁用成功。",
    "accountEnabledSuccess": "账号 {index} 启用成功。",
    "btnDisableUser": "禁用账号",
    "btnEnableUser": "启用账号"
}
```

### 2. 测试验证策略（Verification）
- **功能点 1：禁用隔离性测试**
  - 标记一号账号为禁用，向代理服务器发起并发请求，验证其轮询与错误切换重试完全将该账号排除，同时后台无该账号的任何 Context 被创建。
- **功能点 2：内存即时回收测试**
  - 在账号活跃状态下，点击禁用。验证控制台立刻打印 context 关闭日志，且通过 `ps` 查看到后台无多余的浏览器标签进程，连接彻底阻断。
- **功能点 3：今日统计边界测试**
  - 在北京时间 15:00 之前与之后分别生成请求，观测前端药丸 Badge 的数值在 15:00 是否能 timezone-aware 地完成统计边界清零/跨越。
