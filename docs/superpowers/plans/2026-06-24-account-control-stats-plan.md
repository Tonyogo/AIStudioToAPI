# 账户管理与统计优化（Account Control & Stats Extensions） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现多账户的启用与禁用（Enable/Disable Accounts）支持，并为前台列表项新增“今日成功请求数统计药丸 Badge”（Today Usage Badge，对齐美西 PT 零点/北京时间 15:00:00 边界，带模型成功分布 tooltip 悬浮），完全不额外增加后端 overhead 或数据库读写开销。

**Architecture:** 
- **启用/禁用管理**：通过在 `configs/auth/auth-N.json` 写入 `"disabled": true` 实现状态持久化。后端 `AuthSource` 加载并过滤禁用索引，直接热重塑 `rotationIndices`。禁用发生时，`BrowserManager` 立即销毁其 Playwright Context 并断开 WebSocket 连接，然后热重排可用背景会话。
- **今日成功请求 Badge**：前端通过计算属性对内存缓存的 `statsState.records` 进行 CST 15:00 Timezone-Aware 动态累加，展示浅蓝色药丸 Badge 并在 Element Tooltip 中展示多模型调用分布明细。

**Tech Stack:** Node.js (Express, Playwright/Firefox), Vue.js 3, Element Plus, Less, WebSockets.

## Global Constraints

- **无需重启服务**：所有账号状态（禁用/启用）的更新均支持热加载。
- **零 Overhead 设计**：今日成功请求数的统计必须在前端完成，杜绝磁盘 I/O 重复查询。
- **精确时区对齐**：今日统计边界起算时间统一为北京时间 (CST) 15:00:00。

---

### Task 1: 扩展 AuthSource.js 以支持禁用逻辑 (Disabling Support)

**Files:**
- Modify: `src/auth/AuthSource.js`

**Interfaces:**
- Produces: 
  - `this.disabledIndices` (Array of numbers)
  - `isDisabled(index)` -> boolean
  - `markAsDisabled(index)` -> Promise<boolean>
  - `unmarkAsDisabled(index)` -> Promise<boolean>

- [ ] **Step 1: 扩展构造函数与预校验逻辑**

  在 `src/auth/AuthSource.js` 的 `constructor` 中新增 `this.disabledIndices = []`。
  并在 `_preValidateAndFilter` 循环体中读取 `authData.disabled === true` 时填充。

  查找并修改 `_preValidateAndFilter` 方法中的循环：
  ```javascript
  // 修改后（对应 src/auth/AuthSource.js）
  this.disabledIndices = []; // 清空上一次的状态
  
  for (const index of this.initialIndices) {
      const authContent = this._getAuthContent(index);
      if (authContent) {
          try {
              const authData = JSON.parse(authContent);
              validIndices.push(index);
              this.accountNameMap.set(index, authData.accountName || null);
              
              if (authData.expired === true) {
                  this.expiredIndices.push(index);
              }
              if (authData.disabled === true) {
                  this.disabledIndices.push(index);
              }
          } catch (e) {
              invalidSourceDescriptions.push(`auth-${index} (parse error)`);
          }
      } else {
          invalidSourceDescriptions.push(`auth-${index} (unreadable)`);
      }
  }
  ```

- [ ] **Step 2: 改造 _buildRotationIndices 以过滤禁用账号**

  修改 `_buildRotationIndices()` 中 `nonExpiredIndices` 的获取，将其改为同时过滤掉 `this.disabledIndices`：
  ```javascript
  // 修改后（对应 src/auth/AuthSource.js）
  const activeIndices = this.availableIndices.filter(
      idx => !this.expiredIndices.includes(idx) && !this.disabledIndices.includes(idx)
  );

  for (const index of activeIndices) {
      const accountName = this.accountNameMap.get(index);
      const emailKey = this._normalizeEmailKey(accountName);
      // ... 后面逻辑保持一致，将 nonExpiredIndices 替换为 activeIndices 即可
  ```

- [ ] **Step 3: 添加 isDisabled, markAsDisabled 与 unmarkAsDisabled 方法**

  在 `AuthSource` 类尾部（`isExpired` 方法后）新增以下三个方法：
  ```javascript
  /**
   * Check if an auth is disabled
   * @param {number} index - Auth index to check
   * @returns {boolean}
   */
  isDisabled(index) {
      return this.disabledIndices.includes(index);
  }

  /**
   * Mark an auth as disabled
   * @param {number} index - Auth index to mark as disabled
   * @returns {Promise<boolean>}
   */
  async markAsDisabled(index) {
      if (!this.availableIndices.includes(index)) {
          this.logger.warn(`[Auth] Cannot mark non-existent auth #${index} as disabled`);
          return false;
      }

      if (this.disabledIndices.includes(index)) {
          this.logger.debug(`[Auth] Auth #${index} is already disabled`);
          return false;
      }

      const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
      try {
          const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
          const authData = JSON.parse(fileContent);
          authData.disabled = true;
          await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

          this.disabledIndices.push(index);
          this._buildRotationIndices();

          this.logger.warn(`[Auth] 🚫 Disabled auth #${index}`);
          return true;
      } catch (error) {
          this.logger.error(`[Auth] Failed to disable auth #${index}: ${error.message}`);
          return false;
      }
  }

  /**
   * Restore a disabled auth (unmark as disabled)
   * @param {number} index - Auth index to restore
   * @returns {Promise<boolean>}
   */
  async unmarkAsDisabled(index) {
      if (!this.availableIndices.includes(index)) {
          this.logger.warn(`[Auth] Cannot restore non-existent auth #${index}`);
          return false;
      }

      if (!this.disabledIndices.includes(index)) {
          this.logger.debug(`[Auth] Auth #${index} is not disabled`);
          return false;
      }

      const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
      try {
          const fileContent = await fsPromises.readFile(authFilePath, "utf-8");
          const authData = JSON.parse(fileContent);
          delete authData.disabled;
          await fsPromises.writeFile(authFilePath, JSON.stringify(authData, null, 2));

          this.disabledIndices = this.disabledIndices.filter(idx => idx !== index);
          this._buildRotationIndices();

          this.logger.info(`[Auth] ✅ Restored auth #${index} from disabled status`);
          return true;
      } catch (error) {
          this.logger.error(`[Auth] Failed to restore auth #${index}: ${error.message}`);
          return false;
      }
  }
  ```

- [ ] **Step 4: 手动运行/测试热装载**

  通过控制台在不重启服务的情况下，执行 `git status` 确保修改正确，并且执行以下代码来验证语法没有报错：
  Run: `node -e "require('./src/auth/AuthSource.js')"`
  Expected: 无任何报错输出，正常退出。

- [ ] **Step 5: 提交代码**

  ```bash
  git add src/auth/AuthSource.js
  git commit -m "feat(auth): support enable/disable account persistency in AuthSource"
  ```

---

### Task 2: 改造 BrowserManager.js 以兼容禁用队列

**Files:**
- Modify: `src/core/BrowserManager.js`

**Interfaces:**
- Consumes:
  - `this.authSource.isDisabled(idx)` -> boolean
  - `this.authSource.disabledIndices` -> Array of numbers

- [ ] **Step 1: 改造 rebalanceContextPool 在无限模式下剔除禁用账号**

  定位到 `src/core/BrowserManager.js` 的 `rebalanceContextPool` 方法中 `isUnlimited` 分支（约 line 1930）：
  ```javascript
  // 修改前：
  const nonExpiredAvailable = this.authSource.availableIndices.filter(idx => !this.authSource.isExpired(idx));
  targets = new Set(nonExpiredAvailable);

  // 修改后：
  const activeAvailable = this.authSource.availableIndices.filter(
      idx => !this.authSource.isExpired(idx) && !this.authSource.isDisabled(idx)
  );
  targets = new Set(activeAvailable);
  ```

- [ ] **Step 2: 改造 preCleanupForSwitch，将禁用账号列为最高优先级移出内存**

  定位至 `preCleanupForSwitch()` 的 **Priority 2**（约 line 1865），使禁用账号也成为优先回收的目标：
  ```javascript
  // 修改前：
  // Priority 2: Expired accounts (except target if target is expired)
  for (const idx of allContextIndices) {
      if (expiredIndices.includes(idx) && idx !== targetAuthIndex && !removalPriority.includes(idx)) {
          removalPriority.push(idx);
      }
  }

  // 修改后：
  // Priority 2: Expired or Disabled accounts (except target)
  const disabledIndices = this.authSource.disabledIndices || [];
  for (const idx of allContextIndices) {
      if (
          (expiredIndices.includes(idx) || disabledIndices.includes(idx)) &&
          idx !== targetAuthIndex &&
          !removalPriority.includes(idx)
      ) {
          removalPriority.push(idx);
      }
  }
  ```

- [ ] **Step 3: 语法验证与提交**

  Run: `node -e "require('./src/core/BrowserManager.js')"`
  Expected: 无语法错误。

  ```bash
  git add src/core/BrowserManager.js
  git commit -m "feat(browser): handle disabled accounts in pool rebalancing and switch pre-cleanup"
  ```

---

### Task 3: 实现禁用切换控制路由与状态同步 (`StatusRoutes.js`)

**Files:**
- Modify: `src/routes/StatusRoutes.js`

- [ ] **Step 1: 添加一键禁用/启用 API 路由**

  在 `StatusRoutes.js` 的 `setupRoutes()` 方法中（比如 `app.delete("/api/accounts/:index", ...)` 之后）注册 `PUT /api/accounts/:index/toggle-disabled`：
  ```javascript
  app.put("/api/accounts/:index/toggle-disabled", isAuthenticated, async (req, res) => {
      if (this._rejectIfSystemBusy(res)) return;

      const rawIndex = req.params.index;
      const targetIndex = Number(rawIndex);

      if (!Number.isInteger(targetIndex)) {
          return res.status(400).json({ message: "errorInvalidIndex" });
      }

      const { authSource } = this.serverSystem;

      if (!authSource.initialIndices.includes(targetIndex)) {
          return res.status(404).json({ index: targetIndex, message: "errorAccountNotFound" });
      }

      try {
          const isDisabled = authSource.isDisabled(targetIndex);
          let success = false;
          if (isDisabled) {
              success = await authSource.unmarkAsDisabled(targetIndex);
          } else {
              success = await authSource.markAsDisabled(targetIndex);
          }

          if (success) {
              // 若被禁用，立即物理断开网页 Context 释放系统资源
              if (!isDisabled) {
                  this.logger.info(`[WebUI] Account #${targetIndex} was disabled. Cleaning context and connection...`);
                  await this.serverSystem.browserManager.closeContext(targetIndex);
                  this.serverSystem.connectionRegistry.closeConnectionByAuth(targetIndex);
              }

              // 重新平衡 Context 预加载队列
              this.serverSystem.browserManager.rebalanceContextPool().catch(err => {
                  this.logger.error(`[Auth] Background rebalance failed: ${err.message}`);
              });

              return res.status(200).json({
                  index: targetIndex,
                  isDisabled: !isDisabled,
                  message: !isDisabled ? "accountDisabledSuccess" : "accountEnabledSuccess",
              });
          } else {
              return res.status(500).json({ message: "accountToggleDisabledFailed" });
          }
      } catch (error) {
          this.logger.error(`[WebUI] Failed to toggle disabled state for account #${targetIndex}: ${error.message}`);
          return res.status(500).json({ error: error.message, message: "accountToggleDisabledFailed" });
      }
  });
  ```

- [ ] **Step 2: 拦截手动切换禁用账号的操作**

  在 `PUT /api/accounts/current` 的逻辑中拦截 `targetIndex` 切换（约 line 254 之后）：
  ```javascript
  const { targetIndex } = req.body;
  if (targetIndex !== undefined && targetIndex !== null) {
      if (this.serverSystem.authSource.isDisabled(targetIndex)) {
          return res.status(400).json({ message: "accountSwitchFailed", reason: "Account is disabled." });
      }
      this.logger.info(`[WebUI] Received request to switch to specific account #${targetIndex}...`);
      // ... 原有逻辑
  ```

- [ ] **Step 3: 改造 _getStatusData 返回 disabledIndicesRaw 与 isDisabled 属性**

  修改 `_getStatusData()`，包含禁用列表和每个账户的禁用状态：
  ```javascript
  const disabledIndices = authSource.disabledIndices || []; // 约 line 970 添加
  
  // 改造 accountDetails 循环内部
  const accountDetails = initialIndices.map(index => {
      const isInvalid = invalidIndices.includes(index);
      const name = isInvalid ? null : accountNameMap.get(index) || null;

      const canonicalIndex = isInvalid ? null : authSource.getCanonicalIndex(index);
      const isDuplicate = canonicalIndex !== null && canonicalIndex !== index;
      const isRotation = rotationIndices.includes(index);
      const isExpired = expiredIndices.includes(index);
      const isDisabled = authSource.isDisabled(index); // 新增字段

      const hasContext = browserManager.contexts.has(index);

      return { canonicalIndex, hasContext, index, isDuplicate, isExpired, isDisabled, isInvalid, isRotation, name };
  });

  // 并在最终返回的 status 块中加入：
  return {
      logCount: displayLogs.length,
      logs: displayLogs.join("\n"),
      status: {
          accountDetails,
          // ... 
          disabledIndicesRaw: disabledIndices, // 新增
          expiredIndicesRaw: expiredIndices,
          // ...
      }
  }
  ```

- [ ] **Step 4: 语法验证与提交**

  Run: `node -e "require('./src/routes/StatusRoutes.js')"`
  Expected: 无语法错误。

  ```bash
  git add src/routes/StatusRoutes.js
  git commit -m "feat(routes): implement toggling disabled accounts, intercept switches, and expose status details"
  ```

---

### Task 4: 新增中英文 Localization 词条 (Locales Expansion)

**Files:**
- Modify: `ui/locales/en.json`
- Modify: `ui/locales/zh.json`

- [ ] **Step 1: 新增英文 locales 词条**

  打开 `ui/locales/en.json`，在适当位置（如按字母序或文件头部）插入以下词条，注意遵循 JSON 规范，尾部逗号保持合法：
  ```json
  "tagDisabled": "Disabled",
  "todayUsage": "Today: {count}",
  "modelDistribution": "Model Distribution",
  "noModelData": "No successful request today",
  "accountDisabledSuccess": "Account #{index} disabled successfully.",
  "accountEnabledSuccess": "Account #{index} enabled successfully.",
  "btnDisableUser": "Disable Account",
  "btnEnableUser": "Enable Account",
  ```

- [ ] **Step 2: 新增中文 locales 词条**

  打开 `ui/locales/zh.json`，在对应位置追加：
  ```json
  "tagDisabled": "已禁用",
  "todayUsage": "今日: {count}",
  "modelDistribution": "模型分布明细",
  "noModelData": "今日暂无成功请求",
  "accountDisabledSuccess": "账号 {index} 禁用成功。",
  "accountEnabledSuccess": "账号 {index} 启用成功。",
  "btnDisableUser": "禁用账号",
  "btnEnableUser": "启用账号",
  ```

- [ ] **Step 3: 验证并提交**

  ```bash
  git add ui/locales/en.json ui/locales/zh.json
  git commit -m "chore(locales): add english and chinese localization strings for account control and stats"
  ```

---

### Task 5: 前端：实现 computed “今日美西太平洋时间零点”成功调用统计

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: 在 Vue script 部分中新增 accountTodayStats 计算属性**

  打开 `ui/app/pages/StatusPage.vue`，在 `statsState` 定义与 `timeFilteredRecords` 之间（约 line 2860-2970 附近）新增 `accountTodayStats`：
  ```javascript
  const accountTodayStats = computed(() => {
      const stats = {}; // authIndex -> { totalSuccess: 0, models: { [modelName]: count } }
      
      // 跨时区起算：北京时间 15:00:00 (UTC 07:00:00) 对应美西 00:00:00
      const now = new Date();
      const today15CST = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 0, 0));
      
      let boundaryTs;
      if (now.getTime() >= today15CST.getTime()) {
          boundaryTs = today15CST.getTime();
      } else {
          boundaryTs = today15CST.getTime() - 24 * 60 * 60 * 1000;
      }
      
      const records = statsState.records || [];
      records.forEach(record => {
          if (record.outcome !== "success") return;
          
          const recordTime = record.startedAt ? new Date(record.startedAt).getTime() : 0;
          if (recordTime < boundaryTs) return;
          
          const authIndex = record.finalAuthIndex;
          if (authIndex === null || authIndex === undefined) return;
          
          if (!stats[authIndex]) {
              stats[authIndex] = {
                  totalSuccess: 0,
                  models: {}
              };
          }
          
          stats[authIndex].totalSuccess++;
          
          const modelName = record.model || "unknown";
          stats[authIndex].models[modelName] = (stats[authIndex].models[modelName] || 0) + 1;
      });
      
      return stats;
  });
  ```

- [ ] **Step 2: 在模板中渲染 Today Usage Badge 药丸与 Hover 悬浮明细**

  定位到 `ui/app/pages/StatusPage.vue` 模板中的账号展示模块（约 line 835 附近）：
  ```html
  <span v-if="item.isExpired" class="expired-badge">
      {{ t("tagExpired") }}
  </span>
  <!-- 在此处插入 Today Usage Badge -->
  <el-tooltip placement="top" effect="dark" :hide-after="0">
      <template #content>
          <div style="font-size: 12px; line-height: 1.5; min-width: 140px;">
              <div style="font-weight: bold; margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 4px;">
                  {{ t("modelDistribution") }}
              </div>
              <div v-if="accountTodayStats[item.index] && Object.keys(accountTodayStats[item.index].models).length > 0">
                  <div v-for="(count, model) in accountTodayStats[item.index].models" :key="model" style="display: flex; justify-content: space-between; gap: 12px; margin-bottom: 2px;">
                      <span style="color: #a0cfff;">{{ model }}:</span>
                      <span style="font-weight: bold;">{{ count }}</span>
                  </div>
              </div>
              <div v-else style="color: #909399; font-style: italic;">
                  {{ t("noModelData") }}
              </div>
          </div>
      </template>
      <span class="today-usage-badge" @click.stop>
          {{ t("todayUsage", { count: accountTodayStats[item.index]?.totalSuccess || 0 }) }}
      </span>
  </el-tooltip>
  ```

- [ ] **Step 3: 提交代码**

  ```bash
  git add ui/app/pages/StatusPage.vue
  git commit -m "feat(ui): add timezone-aware today success request aggregation computed property and render Badge tooltips"
  ```

---

### Task 6: 前端：实现一键启用/禁用控制按钮、UI 拦截与样式

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: 新增 isDisabled 状态徽章和切换处理动作**

  首先在模板中的 `account-email` (约 line 825) 类以及一键切换账号按钮增加对置灰状态的兼容：
  1. 为 `account-email` 添加 `is-disabled` 类名：
     ```html
     <span
         class="account-email"
         :class="{ 'is-error': item.isInvalid, 'is-duplicate': item.isDuplicate, 'is-disabled': item.isDisabled }"
     >
     ```
  2. 在 `tagExpired` 下方，渲染 `tagDisabled` 徽章标签：
     ```html
     <span v-if="item.isDisabled" class="disabled-badge">
         {{ t("tagDisabled") }}
     </span>
     ```
  3. 将一键切换按钮（`btn-switch`，约 line 845）的禁用条件增加 `item.isDisabled`，防止触发：
     ```html
     :disabled="isBusy || item.index === state.currentAuthIndex || item.isDisabled"
     ```

- [ ] **Step 2: 编写启用/禁用按钮图标与一键切换 API**

  在 `account-actions` (约 line 882 附近，在删除和下载按钮之前或后) 插入启用/禁用独立开关：
  ```html
  <button
      class="btn-toggle-disabled"
      :class="{ 'is-disabled-status': item.isDisabled }"
      :disabled="isBusy"
      :title="item.isDisabled ? t('btnEnableUser') : t('btnDisableUser')"
      @click.stop="toggleAccountDisabled(item.index)"
  >
      <!-- Eye-off (Disable) Icon when active -->
      <svg
          v-if="!item.isDisabled"
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
      >
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
          <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
      <!-- Eye (Enable) Icon when disabled -->
      <svg
          v-else
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
      >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
          <circle cx="12" cy="12" r="3"></circle>
      </svg>
  </button>
  ```

- [ ] **Step 3: 编写 toggleAccountDisabled JS 逻辑**

  在 `<script>` 动作方法中加入启用/禁用交互逻辑（大约在 `deleteAccountByIndex` 附近，如 line 4100 之后）：
  ```javascript
  const toggleAccountDisabled = async (index) => {
      try {
          const res = await fetch(`/api/accounts/${index}/toggle-disabled`, {
              method: "PUT",
              headers: {
                  "Content-Type": "application/json"
              }
          });
          const data = await res.json();
          if (res.ok) {
              ElMessage.success(t(data.message, { index }));
              // 立即静默触发状态数据热装载更新
              updateContent();
          } else {
              ElMessage.error(t(data.message || "errorOperationFailed", { error: data.error }));
          }
      } catch (error) {
          ElMessage.error(t("errorOperationFailed", { error: error.message }));
      }
  };
  ```
  并在尾部 `return` 或对外暴露该方法（如果是在组合式 setup 显式 return 或是其他模式中，确保 `toggleAccountDisabled` 存在）。由于本文件使用标准 `<script setup>`（直接定义变量即可使用），所以定义即可直接在模板中被调用。

- [ ] **Step 4: 添加 Badge 与按钮样式 Less/CSS**

  在 `<style lang="less" scoped>` 中插入样式（大约在 `.expired-badge` 附近，约 line 5530）：
  ```less
  .disabled-badge {
      font-size: 0.75rem;
      padding: 2px 8px;
      background: #909399; /* 经典灰色 */
      color: @text-on-primary;
      border-radius: 4px;
      font-weight: bold;
      margin-left: 6px;
      display: inline-block;
  }

  .today-usage-badge {
      font-size: 0.75rem;
      padding: 2px 8px;
      background: #e6f7ff; /* 浅淡雅蓝背景 */
      color: #1890ff; /* 鲜艳蓝色字符 */
      border: 1px solid #91d5ff;
      border-radius: 12px; /* 药丸弧度 */
      font-weight: bold;
      margin-left: 6px;
      display: inline-block;
      cursor: help;
      transition: all 0.2s ease;
      
      &:hover {
          background: #bae7ff;
          border-color: #69c0ff;
      }
  }

  .account-email.is-disabled {
      color: #c0c4cc; /* 禁用文本置灰 */
      text-decoration: line-through; /* 禁用划线视觉感 */
  }

  .btn-toggle-disabled {
      &.is-disabled-status {
          color: #ff4949; /* 禁用状态动作提示红色 */
          background: #ffe9e9;
          border-color: #ffb6b6;
      }
  }
  ```

- [ ] **Step 5: 提交代码**

  ```bash
  git add ui/app/pages/StatusPage.vue
  git commit -m "feat(ui): add Enable/Disable buttons, state badges, toggle handlers and custom styling"
  ```

---

### Task 7: 端到端生产编译与自动化自愈性测试

**Files:**
- Create: `test-disabled-stats.js` (临时测试用脚本，不提交)

- [ ] **Step 1: 构建前端 UI 生成环境包**

  确保前端在打包过程中没有任何编译、CSS 解析或 Vue 计算属性语法错误：
  Run: `npm run build:ui`
  Expected: 成功完成 Vite 静态打包编译，无任何警告与 Error，最终资源输出至 `ui/dist/`。

- [ ] **Step 2: 运行测试验证**

  为了确保后端加载、数据库隔离正常，我们新建临时验证脚本，在不启动完整 Puppeteer/Playwright 环境下进行 API 热自愈单元测试。
  运行完毕后验证账号 rotationIndices 不包含该禁用账号：
  Run: `npm run lint` 验证所有修改文件的 Lint
  Expected: 所有 JS/Vue 完美通过 Prettier 及 ESlint，返回 0。

- [ ] **Step 3: 提交并推送开发工作分支**

  在验证完成后，将代码推送到远端 develop 分支。
  ```bash
  git status
  ```
  Expected: 无任何未提交修改。
