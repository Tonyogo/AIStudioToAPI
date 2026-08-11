# Enable/Disable Account Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement account enable/disable functionality that persists `disabled: true` inside `configs/auth/auth-N.json`, excludes disabled accounts from scheduling and account switching, and provides a UI toggle button with confirm dialogs.

**Architecture:** Extend `AuthSource` to recognize `"disabled": true` in `auth-N.json` and keep those accounts in `disabledIndices` (excluding them from `rotationIndices`). Add `toggleDisabled(index, disabled)` method in `AuthSource` and expose `POST /api/auth/toggle-disabled` endpoint. Update `StatusRoutes` to format disabled accounts with `status: "disabled"` and `isDisabled: true`. Update Vue UI (`StatusPage.vue`) and i18n locales to render Enable/Disable buttons and disable the Switch button for disabled accounts.

**Tech Stack:** Node.js CommonJS, Express.js, Vue 3, Element Plus, Jest.

## Global Constraints

- Disabled state file: `configs/auth/auth-N.json` (property `"disabled": true`)
- Excluded from: `rotationIndices`, `availableIndices`
- API endpoint: `POST /api/auth/toggle-disabled` (Body: `{ index: number, disabled: boolean }`)

---

### Task 1: Extend AuthSource to Filter and Toggle Disabled Accounts

**Files:**
- Modify: `src/auth/AuthSource.js`
- Create/Test: `test/auth/auth_source.test.js`

**Interfaces:**
- Consumes: `fs`, `auth-N.json`
- Produces: `this.disabledIndices`, `toggleDisabled(index, disabled)`

- [ ] **Step 1: Write failing tests for AuthSource disabled functionality**

Create `test/auth/auth_source.test.js`:

```javascript
/* eslint-env jest */
const fs = require("fs");
const path = require("path");
const AuthSource = require("../../src/auth/AuthSource");

describe("AuthSource disabled functionality", () => {
    const mockLogger = {
        debug: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
    };
    const testConfigDir = path.join(process.cwd(), "configs", "auth");

    beforeEach(() => {
        if (!fs.existsSync(testConfigDir)) {
            fs.mkdirSync(testConfigDir, { recursive: true });
        }
    });

    test("_preValidateAndFilter categorizes disabled accounts into disabledIndices and excludes from rotationIndices", () => {
        const auth0Path = path.join(testConfigDir, "auth-990.json");
        const auth1Path = path.join(testConfigDir, "auth-991.json");

        fs.writeFileSync(auth0Path, JSON.stringify({ cookies: [], disabled: true, email: "disabled@example.com" }));
        fs.writeFileSync(auth1Path, JSON.stringify({ cookies: [], email: "active@example.com" }));

        try {
            const authSource = new AuthSource(mockLogger);
            expect(authSource.disabledIndices).toContain(990);
            expect(authSource.rotationIndices).not.toContain(990);
            expect(authSource.rotationIndices).toContain(991);
        } finally {
            if (fs.existsSync(auth0Path)) fs.unlinkSync(auth0Path);
            if (fs.existsSync(auth1Path)) fs.unlinkSync(auth1Path);
        }
    });

    test("toggleDisabled updates auth file and reloads sources", () => {
        const authPath = path.join(testConfigDir, "auth-992.json");
        fs.writeFileSync(authPath, JSON.stringify({ cookies: [], email: "test@example.com" }));

        try {
            const authSource = new AuthSource(mockLogger);
            expect(authSource.rotationIndices).toContain(992);

            authSource.toggleDisabled(992, true);
            expect(authSource.disabledIndices).toContain(992);
            expect(authSource.rotationIndices).not.toContain(992);

            const fileContent = JSON.parse(fs.readFileSync(authPath, "utf8"));
            expect(fileContent.disabled).toBe(true);

            authSource.toggleDisabled(992, false);
            expect(authSource.disabledIndices).not.toContain(992);
            expect(authSource.rotationIndices).toContain(992);

            const fileContent2 = JSON.parse(fs.readFileSync(authPath, "utf8"));
            expect(fileContent2.disabled).toBeUndefined();
        } finally {
            if (fs.existsSync(authPath)) fs.unlinkSync(authPath);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/auth/auth_source.test.js`
Expected: FAIL (`this.disabledIndices is undefined` or `authSource.toggleDisabled is not a function`)

- [ ] **Step 3: Implement disabled logic in AuthSource.js**

In `src/auth/AuthSource.js`:

Add `this.disabledIndices = [];` to constructor.
In `_preValidateAndFilter()`, reset `this.disabledIndices = [];`.
Inside file parsing loop in `_preValidateAndFilter()`:
```javascript
if (data && data.disabled === true) {
    this.disabledIndices.push(index);
    if (email) {
        this.accountNameMap.set(index, email);
    }
    continue; // Skip adding to availableIndices / rotationIndices
}
```

Add `toggleDisabled(index, disabled)` method:
```javascript
toggleDisabled(index, disabled) {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error("Invalid account index.");
    }
    const authFilePath = path.join(process.cwd(), "configs", "auth", `auth-${index}.json`);
    if (!fs.existsSync(authFilePath)) {
        throw new Error(`Auth file for account #${index} does not exist.`);
    }

    try {
        const content = fs.readFileSync(authFilePath, "utf8");
        const jsonObj = JSON.parse(content);
        if (disabled) {
            jsonObj.disabled = true;
        } else {
            delete jsonObj.disabled;
        }
        fs.writeFileSync(authFilePath, JSON.stringify(jsonObj, null, 4), "utf8");
        this.reloadAuthSources(true);
        return { disabled: !!disabled, index };
    } catch (error) {
        throw new Error(`Failed to update auth status for account #${index}: ${error.message}`);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/auth/auth_source.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/AuthSource.js test/auth/auth_source.test.js
git commit -m "feat(auth): add disabled accounts support to AuthSource

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Expose Toggle Endpoint and Update Status Routes

**Files:**
- Modify: `src/routes/StatusRoutes.js`
- Modify: `src/routes/AuthRoutes.js`
- Create/Test: `test/routes/auth_routes.test.js`

**Interfaces:**
- Consumes: `authSource.toggleDisabled(index, disabled)`, `authSource.disabledIndices`
- Produces: `POST /api/auth/toggle-disabled`, `formatAccountsForStatus` with disabled items

- [ ] **Step 1: Write failing tests for toggle-disabled route and status route**

Create `test/routes/auth_routes.test.js`:

```javascript
/* eslint-env jest */
const express = require("express");
const StatusRoutes = require("../../src/routes/StatusRoutes");

describe("Auth and Status Routes disabled functionality", () => {
    test("formatAccountsForStatus maps disabledIndices into accounts array with status='disabled'", () => {
        const mockAuthSource = {
            accountNameMap: new Map([[1, "disabled@example.com"], [0, "active@example.com"]]),
            canonicalIndexMap: new Map(),
            disabledIndices: [1],
            duplicateGroups: [],
            duplicateIndices: [],
            expiredIndices: [],
            rotationIndices: [0],
        };

        const statusRoutes = new StatusRoutes({});
        const result = statusRoutes.formatAccountsForStatus(mockAuthSource, 0);

        expect(result.disabledIndices).toEqual([1]);
        const disabledAccount = result.accounts.find(a => a.id === 1);
        expect(disabledAccount).toBeDefined();
        expect(disabledAccount.status).toBe("disabled");
        expect(disabledAccount.isDisabled).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/routes/auth_routes.test.js`
Expected: FAIL (`disabledAccount.status` is undefined)

- [ ] **Step 3: Implement updates in StatusRoutes.js and AuthRoutes.js**

In `src/routes/StatusRoutes.js` `formatAccountsForStatus`:

```javascript
const disabledIndices = authSource.disabledIndices || [];

const disabledDetails = disabledIndices.map(index => ({
    email: authSource.accountNameMap.get(index) || null,
    id: index,
    isDisabled: true,
    isCurrent: false,
    status: "disabled",
}));

return {
    accounts: [...accounts, ...disabledDetails, ...duplicateDetails, ...expiredDetails],
    // ...
    disabledIndices,
};
```

In `src/routes/AuthRoutes.js` `setupRoutes`:

```javascript
app.post("/api/auth/toggle-disabled", this.isAuthenticated, (req, res) => {
    const { disabled, index } = req.body;
    if (!Number.isInteger(index) || index < 0 || typeof disabled !== "boolean") {
        return res.status(400).json({ error: "Invalid parameters. Required: index (number), disabled (boolean)." });
    }

    try {
        const result = this.serverSystem.authSource.toggleDisabled(index, disabled);
        if (process.env.ENABLE_CONCURRENT === "true" && this.serverSystem.concurrentSystem?.scheduler) {
            this.serverSystem.concurrentSystem.scheduler.rebalanceConcurrentPool().catch(err => {
                this.logger.error(`[Auth] Background rebalance error on disable toggle: ${err.message}`);
            });
        }
        res.json({ isDisabled: result.disabled, success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/routes/auth_routes.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/StatusRoutes.js src/routes/AuthRoutes.js test/routes/auth_routes.test.js
git commit -m "feat(routes): add toggle-disabled endpoint and include disabledIndices in status

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update Frontend UI and i18n Locales

**Files:**
- Modify: `ui/locales/zh.json`
- Modify: `ui/locales/en.json`
- Modify: `ui/app/pages/StatusPage.vue`

**Interfaces:**
- Consumes: `POST /api/auth/toggle-disabled`, `account.isDisabled`, `account.status === 'disabled'`
- Produces: Enable/Disable button, Confirmation dialog, Disabled badge, Disabled Switch button in UI

- [ ] **Step 1: Add translation keys in ui/locales/zh.json and ui/locales/en.json**

In `ui/locales/zh.json`:
```json
"accountDisabledTag": "已禁用",
"confirmDisableAccount": "确定要禁用账号 #{id}（{email}）吗？禁用后该账号将不参与请求调度与账号切换。",
"confirmEnableAccount": "确定要启用账号 #{id}（{email}）吗？",
"disableAccount": "禁用",
"enableAccount": "启用",
"toggleDisabledSuccess": "账号状态更新成功。"
```

In `ui/locales/en.json`:
```json
"accountDisabledTag": "Disabled",
"confirmDisableAccount": "Are you sure you want to disable account #{id} ({email})? It will be excluded from scheduling and switching.",
"confirmEnableAccount": "Are you sure you want to enable account #{id} ({email})?",
"disableAccount": "Disable",
"enableAccount": "Enable",
"toggleDisabledSuccess": "Account status updated successfully."
```

- [ ] **Step 2: Add Enable/Disable button and Disabled status handling in StatusPage.vue**

In `ui/app/pages/StatusPage.vue`:

1. Update account status tag mapping:
```html
<el-tag v-if="account.status === 'disabled' || account.isDisabled" type="info" size="small">
    {{ t('accountDisabledTag') }}
</el-tag>
```

2. Disable "Switch Account" button when `account.isDisabled || account.status === 'disabled'`:
```html
<el-button
    :disabled="account.isCurrent || account.isDisabled || account.status === 'disabled' || switching"
    @click="switchAccount(account.id)"
>
```

3. Add Enable/Disable button next to Delete button in account list / cards:
```html
<el-button
    v-if="!account.isCurrent"
    :type="account.isDisabled || account.status === 'disabled' ? 'success' : 'warning'"
    plain
    size="small"
    @click="toggleAccountDisabled(account)"
>
    {{ account.isDisabled || account.status === 'disabled' ? t('enableAccount') : t('disableAccount') }}
</el-button>
```

4. Add `toggleAccountDisabled` method in `<script setup>`:
```javascript
const toggleAccountDisabled = async (account) => {
    const isTargetDisabled = !(account.isDisabled || account.status === 'disabled');
    const confirmMsg = isTargetDisabled
        ? t('confirmDisableAccount', { id: account.id, email: account.email || 'N/A' })
        : t('confirmEnableAccount', { id: account.id, email: account.email || 'N/A' });

    try {
        await ElMessageBox.confirm(confirmMsg, t('confirmTitle'), {
            confirmButtonText: t('confirmButton'),
            cancelButtonText: t('cancelButton'),
            type: 'warning',
        });

        const res = await fetch('/api/auth/toggle-disabled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: account.id, disabled: isTargetDisabled }),
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to toggle account disabled state');
        }

        ElMessage.success(t('toggleDisabledSuccess'));
        fetchStatus();
    } catch (err) {
        if (err !== 'cancel') {
            ElMessage.error(err.message || 'Action failed');
        }
    }
};
```

- [ ] **Step 3: Test UI build**

Run: `npm run build:ui`
Expected: Build succeeds with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add ui/locales/zh.json ui/locales/en.json ui/app/pages/StatusPage.vue
git commit -m "feat(ui): add enable/disable account toggle button and i18n support

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Run Full Test Suite and Verification

- [ ] **Step 1: Run lint and full test suite**

Run: `npm run lint:js && npx jest`
Expected: All tests pass, 0 ESLint errors.

- [ ] **Step 2: Commit any final formatting cleanups if needed**
