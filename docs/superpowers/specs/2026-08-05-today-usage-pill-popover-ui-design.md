# 今日用量胶囊 Pill 与 Hover 悬浮明细卡片 UI 优化设计规范

**日期:** 2026-08-05  
**状态:** 已批准 (Approved)  

---

## 1. 概述与目标

当前 Web UI 前端“账号管理”列表中展示的“今日用量”使用了标准的 `el-tag` 标签，悬浮展开的明细为简单文本列表，样式较为单调。

本规范旨在对其进行 UI/UX 视觉重构：
1. **今日用量胶囊 Pill**：替换为带有微型图表图标、灰色标签文案与蓝光高亮计数的 Capsule Pill 胶囊外形，配备悬停微动与发光边框。
2. **悬浮明细卡片 Popover**：重构为精美结构卡片，包含标头（标题与总请求数）以及带 Element Plus 动态色彩进度条（`<el-progress>`）的模型使用量分布列表。

---

## 2. 详细结构与设计

### 2.1 胶囊 Pill 与 Popover 模板结构 (`ui/app/pages/StatusPage.vue`)

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

### 2.2 辅助函数 (`getProgressColor`)

根据配额消耗比例动态展示进度条色彩：
- `< 70%`: `#409eff` (蓝色)
- `70% - 90%`: `#e6a23c` (橙色 warnings)
- `>= 90%`: `#f56c6c` (红色 alert)

### 2.3 样式设计 (Less)

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

---

## 3. 受影响文件

- `ui/app/pages/StatusPage.vue`：更新模板结构、新增 `getProgressColor` Helper 并增强样式。
