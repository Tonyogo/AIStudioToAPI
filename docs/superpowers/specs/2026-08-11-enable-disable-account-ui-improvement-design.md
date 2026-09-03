# 设计文档：优化账号管理页面启用/禁用按钮及已禁用标签展示 (UI Improvement for Account Enable/Disable)

**日期:** 2026-08-11  
**状态:** 已批准 (Approved)  

---

## 1. 问题陈述与目标

在实现账号启用/禁用功能后，目前的 UI 存在两个设计层面的缺陷：
1. **标签冗余 (Duplicate Tags)**：在并发调度模式开启时，同一个被禁用的账号会并排出现两个“已禁用 / Disabled”标签（一个是并发状态标签，另一个是独立的禁用状态标签）。
2. **按钮不协调 (Ugly Button Style)**：目前的“启用/禁用”操作是一个矩形的、素雅的 `el-button` 文本按钮。而账号卡片中的其他操作（如切换、删除、下载）全部是圆形的、极简主义的 SVG 图标按钮，这导致新的按钮格格不入，影响页面整体的美观度。

本功能优化旨在：
- **去冗余**：使并发模式状态标签与禁用标签互斥，保证页面任何时候只有一个状态标签。
- **视觉统一**：将启用/禁用按钮升级为圆形的、带有高对比 hover 态的 **SVG 能量/开关 (Power)** 图标按钮，与现有操作按钮风格 100% 保持一致。

---

## 2. 详细设计

### 2.1 标签互斥优化 (`ui/app/pages/StatusPage.vue`)
- **逻辑改动**：在独立渲染“已禁用”标签的 `<el-tag>` 组件上，增加 `!state.isConcurrentMode` 条件。
  - **原因**：并发模式下，并发状态标签本身就会读取 `item.concurrentStatus` 并将其格式化并渲染为 `"已禁用"` 标签。因此独立标签只需在非并发模式下展示即可。
  ```html
  <el-tag
      v-if="!state.isConcurrentMode && (item.status === 'disabled' || item.isDisabled)"
      type="info"
      size="small"
      class="status-tag"
  >
      {{ t("accountDisabledTag") }}
  </el-tag>
  ```

### 2.2 圆形 SVG 图标按钮升级

#### 2.2.1 HTML 模板替换
将原有 `el-button` 替换为自定义 HTML `<button>`，采用 `btn-toggle-disabled` 样式类与 SVG 电源图标。

```html
<button
    v-if="!item.isCurrent"
    class="btn-toggle-disabled"
    :class="{ 'is-disabled': item.isDisabled || item.status === 'disabled' }"
    :title="item.isDisabled || item.status === 'disabled' ? t('enableAccount') : t('disableAccount')"
    @click.stop="toggleAccountDisabled(item)"
>
    <svg
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
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
        <line x1="12" y1="2" x2="12" y2="12"></line>
    </svg>
</button>
```

#### 2.2.2 CSS 样式设计
在 `<style>` 部分添加对应按钮样式，设计两个 Hover 状态：
1. **正常启用态下 Hover**（预警禁用）：图标变为**橙黄色**（Warning），提示点击后执行“禁用”动作。
2. **已禁用态下 Hover**（激活启用）：图标变为**成功绿**（Success），提示点击后执行“启用”动作。

```css
.btn-toggle-disabled {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border-color, #e4e7ed);
    background: transparent;
    color: var(--el-text-color-regular);
    cursor: pointer;
    transition: all 0.2s ease;
    padding: 0;
}

/* 正常启用态下的 Hover：点击会触发‘禁用’(warning 橙黄色) */
.btn-toggle-disabled:hover {
    color: #e6a23c;
    border-color: #f5dab1;
    background: #fdf6ec;
}

/* 已禁用态下的基础样式与 Hover：点击会触发‘启用’(success 绿色) */
.btn-toggle-disabled.is-disabled {
    color: #909399; /* 默认灰色，指示当前为禁用状态 */
    background: rgba(144, 147, 153, 0.1);
    border-color: rgba(144, 147, 153, 0.2);
}

.btn-toggle-disabled.is-disabled:hover {
    color: #67c23a;
    border-color: #c2e7b0;
    background: #f0f9eb;
}
```

---

## 3. 测试与验证计划

1. **界面审查 (UI Review)**：
   - 验证并发模式下，同一个被禁用账号只展示一个“已禁用”标签。
   - 验证“启用/禁用”按钮与其他圆型按钮（切换、删除、下载）完全对齐。
2. **交互审查 (Interaction Review)**：
   - 验证启用状态下 hover 图标显示为温馨的橙色（`#e6a23c`），提示可以禁用。
   - 验证禁用状态下 hover 图标显示为生机的绿色（`#67c23a`），提示可以启用。
   - 验证点击按钮能正常唤起相应的二次确认 MessageBox 并更新状态。
