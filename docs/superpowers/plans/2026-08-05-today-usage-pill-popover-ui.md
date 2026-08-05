# Today Usage Capsule Pill and Popover Card UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Today Usage badge and hover popover in `StatusPage.vue` into a modern capsule pill and progress card popover.

**Architecture:** Update the `.account-info` template in `StatusPage.vue` to render a custom capsule pill with an SVG icon, label, and highlighted request count. Add a `getProgressColor` helper for progress bars. Add Less styling for `.usage-capsule-pill` and `.usage-popover-inner`. Rebuild Vite assets and verify linting/testing.

**Tech Stack:** Vue 3, Element Plus, Less, Vite

## Global Constraints

- Run `npm run build:ui` to compile production assets.
- ESLint (`npm run lint:js`) must pass with 0 errors.
- All 55 concurrent tests in `test/concurrent/` must pass 100%.

---

### Task 1: Update Template, Helper, and Styling in `StatusPage.vue` & Rebuild Assets

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

**Interfaces:**
- Consumes: `item.usage.total`, `item.usage.byModel`
- Produces: Visual Capsule Pill and Popover Card in Account Management list item.

- [ ] **Step 1: Add `getProgressColor` helper function to `StatusPage.vue`**

Add in `<script setup>` of `ui/app/pages/StatusPage.vue`:

```javascript
const getProgressColor = ratio => {
    if (ratio >= 0.9) return "#f56c6c";
    if (ratio >= 0.7) return "#e6a23c";
    return "#409eff";
};
```

- [ ] **Step 2: Update Today Usage Popover Template in `StatusPage.vue`**

Replace the existing `item.usage` template block in `ui/app/pages/StatusPage.vue`:

```html
<template v-if="state.isConcurrentMode && item.usage">
    <el-popover
        placement="top-start"
        :width="300"
        trigger="hover"
        effect="dark"
        popper-class="usage-popover-card"
    >
        <template #reference>
            <div class="usage-capsule-pill" @click.stop>
                <svg class="pill-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 20V10M18 20V4M6 20v-4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <span class="pill-label">{{ t("todayUsage") }}</span>
                <span class="pill-count">{{ item.usage.total }}</span>
            </div>
        </template>

        <div class="usage-popover-inner">
            <div class="popover-header">
                <span class="popover-title">{{ t("modelUsageBreakdown") }}</span>
                <span class="popover-total-badge">{{ item.usage.total }} reqs</span>
            </div>
            <div class="popover-models-list">
                <div
                    v-for="(val, model) in item.usage.byModel"
                    :key="model"
                    class="popover-model-item"
                >
                    <div class="model-meta">
                        <span class="model-name">{{ model }}</span>
                        <span class="model-usage-text">{{ val.usage }} / {{ val.limit }}</span>
                    </div>
                    <el-progress
                        :percentage="Math.min(100, Math.round((val.usage / val.limit) * 100))"
                        :stroke-width="6"
                        :show-text="false"
                        :color="getProgressColor(val.usage / val.limit)"
                        class="model-progress-bar"
                    />
                </div>
            </div>
        </div>
    </el-popover>
</template>
```

- [ ] **Step 3: Add Capsule Pill and Popover Card Less Styles**

In `<style lang="less" scoped>` of `ui/app/pages/StatusPage.vue`, add:

```less
.usage-capsule-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px 0 6px;
    border-radius: 11px;
    background: rgba(64, 158, 255, 0.08);
    border: 1px solid rgba(64, 158, 255, 0.2);
    cursor: pointer;
    margin-left: 6px;
    transition: all 0.2s ease;
    user-select: none;

    &:hover {
        background: rgba(64, 158, 255, 0.15);
        border-color: rgba(64, 158, 255, 0.4);
        box-shadow: 0 2px 8px rgba(64, 158, 255, 0.15);
        transform: translateY(-1px);
    }

    .pill-icon {
        width: 12px;
        height: 12px;
        color: #409eff;
    }

    .pill-label {
        font-size: 11px;
        color: var(--el-text-color-regular, #606266);
        font-weight: 500;
    }

    .pill-count {
        font-size: 11px;
        font-weight: 700;
        font-family: var(--font-family-mono, monospace);
        color: #409eff;
        background: rgba(64, 158, 255, 0.12);
        padding: 0 5px;
        border-radius: 8px;
        line-height: 16px;
    }
}

.usage-popover-inner {
    padding: 2px 4px;

    .popover-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);

        .popover-title {
            font-size: 12px;
            font-weight: 600;
            color: #ffffff;
        }

        .popover-total-badge {
            font-size: 11px;
            color: #409eff;
            font-weight: 700;
            font-family: var(--font-family-mono, monospace);
        }
    }

    .popover-models-list {
        display: flex;
        flex-direction: column;
        gap: 8px;

        .popover-model-item {
            .model-meta {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 3px;
                font-size: 11px;

                .model-name {
                    color: #e6a23c;
                    font-weight: 500;
                }

                .model-usage-text {
                    color: #a8abb2;
                    font-family: var(--font-family-mono, monospace);
                }
            }

            .model-progress-bar {
                margin: 0;
            }
        }
    }
}
```

- [ ] **Step 4: Rebuild UI assets and run verification**

Run: `npm run build:ui && npm run lint:js && rm -rf tmp_test_data/ && npx jest test/concurrent/`
Expected: ALL PASS with 0 errors.

- [ ] **Step 5: Commit changes**

```bash
git add ui/app/pages/StatusPage.vue
git commit -m "feat(ui): redesign today usage badge as capsule pill with hover progress card popover"
```
