# 设计文档：账号管理页面账号启用/禁用功能 (Enable/Disable Account Feature)

**日期:** 2026-08-11  
**状态:** 已批准 (Approved)  

---

## 1. 背景与目标

在 AIStudioToAPI 系统中，管理账号通常包含多个 Google 账号（`configs/auth/auth-N.json`）。在多账号轮询或并发模式下，某些账号可能因临时风控、手动维护或配额调整需要临时下线，但管理员不希望直接删除对应的 `.json` 文件。

本功能旨在为 Web 管理界面提供 **账号启用/禁用 (Enable/Disable)** 功能：
1. **状态持久化**：将禁用状态直接写入对应的 `auth-N.json` 文件中（如 `"disabled": true`）。
2. **调度隔离**：被禁用的账号彻底排除在单/多账号轮换（`rotationIndices`）、并发调度池及账号切换逻辑之外。
3. **UI 交互**：在账号管理列表中展示“已禁用”标签，禁用其“切换账号”按钮，并提供“启用/禁用”操作按钮。

---

## 2. 详细设计

### 2.1 后端设计

#### 2.1.1 `AuthSource.js` 改动
- **新属性**:
  - `this.disabledIndices = []`: 维护所有被标注为 `"disabled": true` 的账号索引数组。
- **预校验与过滤 (`_preValidateAndFilter`)**:
  - 在扫描解析 `configs/auth/auth-N.json` 时，读取文件中的 `disabled` 属性：
    ```javascript
    if (authData && authData.disabled === true) {
        this.disabledIndices.push(index);
        if (email) this.accountNameMap.set(index, email);
        // 不加入 this.rotationIndices 或 this.availableIndices
        continue;
    }
    ```
  - 确保被禁用的账号不进入 `rotationIndices`，从而无法参与任何请求路由或账号切换。
- **动态切换方法 (`toggleDisabled(index, disabled)`)**:
  - 接受 `index`（整数）和 `disabled`（布尔值）。
  - 校验文件 `configs/auth/auth-${index}.json` 是否存在。
  - 读取 JSON，更新 `jsonObj.disabled = !!disabled`；若 `disabled` 为 `false`，则可直接 `delete jsonObj.disabled`。
  - 格式化并原子写入文件。
  - 调用 `this.reloadAuthSources()` 重新扫描并更新全局索引 map。

#### 2.1.2 `StatusRoutes.js` 接口适配
- **状态 API 返回格式 (`formatAccountsForStatus`)**:
  - 在返回对象中新增 `disabledIndices: authSource.disabledIndices || []`。
  - 将 `disabledIndices` 映射为账号列表中的条目：
    ```javascript
    const disabledDetails = disabledIndices.map(index => ({
        email: authSource.accountNameMap.get(index) || null,
        id: index,
        isDisabled: true,
        isCurrent: false,
        status: "disabled",
    }));
    ```
  - 在返回给前端的 `accounts` 数组中包含 `disabledDetails`。

#### 2.1.3 `AuthRoutes.js` 路由接口
- **新增 API Endpoint**: `POST /api/auth/toggle-disabled`
- **权限**: 需登录校验 (`isAuthenticated`)
- **请求体**: `{ "index": number, "disabled": boolean }`
- **逻辑**:
  1. 校验 `index` 与 `disabled` 参数。
  2. 调用 `authSource.toggleDisabled(index, disabled)`。
  3. 若并发模式已启用（`ENABLE_CONCURRENT=true`），异步触发并发池再平衡 `scheduler.rebalanceConcurrentPool()`。
  4. 返回 `{ success: true, isDisabled: disabled, remainingActive: authSource.rotationIndices.length }`。

---

### 2.2 前端设计 (`ui/app/pages/StatusPage.vue` & `ui/app/utils/i18n.js`)

#### 2.2.1 UI 交互
- **账号卡片/列表项**:
  - **标签展示**: 当 `account.status === 'disabled'` 或 `account.isDisabled` 时，展示 `<el-tag type="info">已禁用 / Disabled</el-tag>`。
  - **按钮控制**:
    - “切换至此账号”按钮设置 `:disabled="account.isDisabled || account.isCurrent"`，防止对已禁用账号发起手动切换。
    - “启用/禁用”按钮：
      - 未禁用时展示为 `<el-button type="warning" plain>禁用</el-button>`。
      - 已禁用时展示为 `<el-button type="success" plain>启用</el-button>`。
- **二次确认弹窗**:
  - 点击“禁用”或“启用”时，弹出 `ElMessageBox.confirm` 二次确认提示。
  - 确认后发送 `POST /api/auth/toggle-disabled`，成功后提示 `ElMessage.success` 并重新拉取状态数据。

#### 2.2.2 多语言字典 (`i18n.js`)
新增 key-value 定义：
- `disableAccount`: "禁用" / "Disable"
- `enableAccount`: "启用" / "Enable"
- `accountDisabledTag`: "已禁用" / "Disabled"
- `confirmDisableAccount`: "确定要禁用账号 #{id}（{email}）吗？禁用后该账号将不参与请求调度与账号切换。" / "Are you sure you want to disable account #{id} ({email})? It will be excluded from scheduling and switching."
- `confirmEnableAccount`: "确定要启用账号 #{id}（{email}）吗？" / "Are you sure you want to enable account #{id} ({email})?"
- `toggleDisabledSuccess`: "账号状态更新成功" / "Account status updated successfully"

---

## 3. 测试验证计划

1. **单元测试 (`test/auth/auth_source.test.js`)**:
   - 验证 `_preValidateAndFilter` 能正确识别 `auth-N.json` 中的 `"disabled": true` 并将其归入 `disabledIndices`，同时排除在 `rotationIndices` 之外。
   - 验证 `toggleDisabled(index, true/false)` 能正确落盘写入/删除 `disabled` 字段，并在 `reloadAuthSources` 后更新状态。
2. **路由接口测试 (`test/routes/auth_routes.test.js`)**:
   - 验证 `POST /api/auth/toggle-disabled` 接口鉴权与参数校验。
   - 验证正确调用 `AuthSource.toggleDisabled` 并返回最新状态。
3. **UI 与端到端逻辑验证**:
   - 在 UI 界面点击“禁用”按钮，确认页面状态变为“已禁用”，切换按钮变灰不可用。
   - 发起 API 请求，确认被禁用的账号不接收任何请求。
