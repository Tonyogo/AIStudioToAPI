# API 翻译对照调试器 JSON 折叠树（API Translation Inspector Foldable JSON Tree） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 API 翻译对照调试器弹窗升级折叠树（Preview 模式）支持，解耦大报文平铺阅读瓶颈。支持自递归节点渲染与双向页签（Preview / Raw）灵活无缝切换，并支持长文本自动截断及气泡悬浮。

**Architecture:** 
- **折叠树组件 (`JsonTreeNode.vue`)**：新增一个自递归、高度定制化的 Vue 3 树节点渲染组件。对键、字符串、数值、布尔、Null 等各类型应用 VS Code 暗色风格渲染。长字符串超过 80 字符自动截断，并使用 Element Plus 气泡 tooltip 提供悬浮预览。
- **页签切换与分流 (`StatusPage.vue`)**：卡片头部结构重构，添加 Segment 页签切换 Preview/Raw 状态，默认展示树节点，并做动态分流渲染。

**Tech Stack:** Vue.js 3, Less, Element Plus.

## Global Constraints

- **无需修改后端**：折叠树完全基于前端数据结构处理，不需要对后端接口做任何变更。
- **极速首屏加载**：树节点通过 `depth <= 1` 智能识别首屏，仅展开前两层，深度层级按需动态展开。

---

### Task 1: 编写自递归 JsonTreeNode.vue 组件

**Files:**
- Create: `ui/app/components/JsonTreeNode.vue`

**Interfaces:**
- Produces:
  - `<json-tree-node :val="data" :name="key" :depth="0" :is-last="true" />`

- [ ] **Step 1: 新增 JsonTreeNode.vue 文件并编写模板和样式**

  在 `ui/app/components/` 下创建 `JsonTreeNode.vue` 文件，写入完整的递归逻辑、三角箭头动画和色彩高亮 Less：
  ```vue
  <template>
      <div class="json-tree-node" :style="{ paddingLeft: depth > 0 ? '16px' : '0' }">
          <!-- Object/Array Node -->
          <div v-if="isObject" class="json-tree-row">
              <span class="tree-toggle-arrow" :class="{ 'is-expanded': expanded }" @click.stop="toggleExpand">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
              </span>
              <span v-if="name !== ''" class="tree-key" @click.stop="toggleExpand">{{ name }}:</span>
              <span class="tree-bracket-summary" @click.stop="toggleExpand">
                  {{ bracketSummary }}
                  <span class="tree-item-count" v-if="!expanded && count > 0">{{ count }} {{ countText }}</span>
              </span>
          </div>

          <!-- Children of Object/Array (only rendered if expanded) -->
          <div v-if="isObject && expanded" class="tree-children">
              <json-tree-node
                  v-for="(childVal, childKey, idx) in val"
                  :key="childKey"
                  :name="isArray ? idx : childKey"
                  :val="childVal"
                  :depth="depth + 1"
                  :is-last="idx === count - 1"
              />
          </div>

          <!-- Primitive Value Node -->
          <div v-if="!isObject" class="json-tree-row is-primitive">
              <span v-if="name !== ''" class="tree-key">{{ name }}:</span>
              
              <!-- Color-coded highlighters -->
              <span v-if="type === 'string'" class="tree-value is-string">
                  <el-tooltip v-if="isLongString" placement="top" effect="dark" :show-after="200" raw-content>
                      <template #content>
                          <div class="tree-tooltip-full-text">{{ val }}</div>
                      </template>
                      <span class="long-string-text">"{{ truncatedString }}"</span>
                  </el-tooltip>
                  <span v-else>"{{ val }}"</span>
              </span>
              <span v-else-if="type === 'number'" class="tree-value is-number">{{ val }}</span>
              <span v-else-if="type === 'boolean'" class="tree-value is-boolean">{{ val }}</span>
              <span v-else-if="type === 'null'" class="tree-value is-null">null</span>
              
              <span v-if="!isLast" class="tree-comma">,</span>
          </div>

          <!-- Closing brackets for objects/arrays -->
          <div v-if="isObject && expanded" class="tree-bracket-closing">
              {{ isArray ? "]" : "}" }}{{ !isLast ? "," : "" }}
          </div>
      </div>
  </template>

  <script setup>
  import { computed, ref } from "vue";

  const props = defineProps({
      name: { type: [String, Number], default: "" },
      val: { type: null, required: true },
      depth: { type: Number, default: 0 },
      isLast: { type: Boolean, default: true }
  });

  const expanded = ref(props.depth <= 1);

  const toggleExpand = () => {
      expanded.value = !expanded.value;
  };

  const isObject = computed(() => typeof props.val === "object" && props.val !== null);
  const isArray = computed(() => Array.isArray(props.val));

  const type = computed(() => {
      if (props.val === null) return "null";
      return typeof props.val;
  });

  const count = computed(() => {
      if (!isObject.value) return 0;
      if (isArray.value) return props.val.length;
      return Object.keys(props.val).length;
  });

  const countText = computed(() => (isArray.value ? "items" : "keys"));

  const bracketSummary = computed(() => {
      if (isArray.value) {
          return expanded.value ? "[" : "[ ... ]";
      }
      return expanded.value ? "{" : "{ ... }";
  });

  const isLongString = computed(() => type.value === "string" && props.val.length > 80);
  const truncatedString = computed(() => {
      if (!isLongString.value) return props.val;
      return props.val.substring(0, 80) + "...";
  });
  </script>

  <style lang="less" scoped>
  .json-tree-node {
      font-family: Consolas, Monaco, monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #ffd700;
  }
  .json-tree-row {
      display: flex;
      align-items: flex-start;
      padding: 1px 0;
      cursor: default;
      user-select: text;

      &.is-primitive {
          padding-left: 16px; /* align with arrows */
      }
  }
  .tree-toggle-arrow {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      cursor: pointer;
      color: #808080;
      transition: transform 0.15s ease;

      svg {
          width: 10px;
          height: 10px;
      }

      &.is-expanded {
          transform: rotate(90deg);
      }
  }
  .tree-key {
      color: #9cdcfe; /* light blue */
      margin-right: 6px;
      font-weight: 500;
      cursor: pointer;
  }
  .tree-bracket-summary {
      color: #ffd700; /* gold */
      cursor: pointer;
  }
  .tree-item-count {
      font-size: 11px;
      color: #808080;
      background: #2d2d2d;
      padding: 1px 6px;
      border-radius: 4px;
      margin-left: 6px;
  }
  .tree-children {
      display: flex;
      flex-direction: column;
  }
  .tree-bracket-closing {
      color: #ffd700;
      padding-left: 16px;
  }
  .tree-value {
      &.is-string {
          color: #ce9178; /* orange string */
          word-break: break-all;
          white-space: pre-wrap;
      }
      &.is-number {
          color: #b5cea8; /* green number */
      }
      &.is-boolean {
          color: #569cd6; /* blue bool */
      }
      &.is-null {
          color: #808080; /* grey null */
      }
  }
  .tree-comma {
      color: #ffd700;
  }
  </style>

  <style lang="less">
  .tree-tooltip-full-text {
      max-width: 400px;
      max-height: 250px;
      overflow-y: auto;
      font-family: Consolas, Monaco, monospace;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-all;
  }
  </style>
  ```

- [ ] **Step 2: 验证并提交**

  ```bash
  git add ui/app/components/JsonTreeNode.vue
  git commit -m "feat(ui): add self-recursive JsonTreeNode component for VS Code dark-style JSON tree renders"
  ```

---

### Task 2: 扩展中英文页签切换 Localization 词条

**Files:**
- Modify: `ui/locales/en.json`
- Modify: `ui/locales/zh.json`

- [ ] **Step 1: 新增 English locales**

  在 `ui/locales/en.json` 字母排序中分别添加页签词条：
  ```json
  "previewMode": "Preview",
  "rawMode": "Raw",
  ```

- [ ] **Step 2: 新增 Chinese locales**

  在 `ui/locales/zh.json` 字母排序中对应添加：
  ```json
  "previewMode": "折叠树",
  "rawMode": "原始报文",
  ```

- [ ] **Step 3: 提交代码**

  ```bash
  git add ui/locales/en.json ui/locales/zh.json
  git commit -m "chore(locales): add preview and raw mode translation keys"
  ```

---

### Task 3: 改造 StatusPage.vue 双页签与折叠树渲染分流

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: 引入 JsonTreeNode 子组件**

  在 `StatusPage.vue` 脚本顶部的 import 声明中（约 line 2988）引入刚才创建的组件：
  ```javascript
  import EnvVarTooltip from "../components/EnvVarTooltip.vue";
  import JsonTreeNode from "../components/JsonTreeNode.vue"; // 新增
  ```

- [ ] **Step 2: 定义 panelTabs 响应式状态与重置逻辑**

  在 `inspectorState` 的下方（约 line 3105 附近）添加 `panelTabs` 页签定义：
  ```javascript
  // Modals segment tab states
  const panelTabs = reactive({
      client_req: "preview",
      gem_req: "preview",
      gem_res: "preview",
      client_res: "preview",
  });
  ```
  并在 `openTransactionInspector(requestId, apiFormat)` 动作起始处（约 line 3215 附近），一键重置 4 个页签状态到 `"preview"` 默认模式：
  ```javascript
  // Retrieve single transaction comparison and open Inspector Dialog
  const openTransactionInspector = async (requestId, apiFormat) => {
      // 一键重置页签状态
      panelTabs.client_req = "preview";
      panelTabs.gem_req = "preview";
      panelTabs.gem_res = "preview";
      panelTabs.client_res = "preview";

      inspectorState.requestId = requestId;
  ```

- [ ] **Step 3: 重构对比 Dialog 的卡片 HTML 模板**

  定位到 `API Translation Inspector Dialog` 的 HTML 模板结构中（约 line 2985-3040），将所有 4 重卡片 `code-card` 的头部和内容区进行重构升级。

  以 `client_req`（客户端原始请求，左上）卡片为例，头部加入微型按钮也签组，内容区进行 `v-if/v-else` 渲染分流：
  ```html
  <div class="code-card">
      <div class="code-card-header">
          <div class="card-tab-group">
              <span class="card-title-text">{{ t("clientRequest") }}{{ inspectorState.apiFormat ? " (" + getApiFormatLabel(inspectorState.apiFormat) + ")" : "" }}</span>
              <button type="button" class="card-tab-btn" :class="{ 'is-active': panelTabs.client_req === 'preview' }" @click="panelTabs.client_req = 'preview'">{{ t("previewMode") }}</button>
              <button type="button" class="card-tab-btn" :class="{ 'is-active': panelTabs.client_req === 'raw' }" @click="panelTabs.client_req = 'raw'">{{ t("rawMode") }}</button>
          </div>
          <el-button size="small" type="primary" link @click="copyPayloadText(inspectorState.data.client_req)">
              {{ t("copyPayload") }}
          </el-button>
      </div>
      <div class="code-card-body">
          <div v-if="panelTabs.client_req === 'preview'" class="tree-wrapper">
              <json-tree-node :val="inspectorState.data.client_req" />
          </div>
          <pre v-else class="code-editor">{{ formatJson(inspectorState.data.client_req) }}</pre>
      </div>
  </div>
  ```

  对其余三栏（`gem_req`、`gem_res`、`client_res`）做**完全相同的结构改造**（注意替换对应的 `panelTabs.*` 键名和 `inspectorState.data.*` 属性名）。

- [ ] **Step 4: 添加卡片微型页签和滚动条 Less 样式**

  在 `StatusPage.vue` 底部的样式块中插入我们页签切换按钮及树滚动条的精美 CSS/Less 样式：
  ```less
  .card-tab-group {
      display: flex;
      align-items: center;
      gap: 8px;
  }
  .card-title-text {
      margin-right: 8px;
  }
  .card-tab-btn {
      background: transparent;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      color: #858585;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-weight: 500;

      &:hover {
          color: #d4d4d4;
          border-color: #5a5a5a;
      }

      &.is-active {
          color: #ffffff;
          background: #3c3c3c;
          border-color: #5a5a5a;
      }
  }
  .code-card-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
  }
  .tree-wrapper {
      flex: 1;
      padding: 12px 16px;
      overflow-y: auto;
      background: #1e1e1e; /* VS Code dark background */
      display: flex;
      flex-direction: column;

      &::-webkit-scrollbar {
          width: 6px;
          height: 6px;
      }
      &::-webkit-scrollbar-track {
          background: transparent;
      }
      &::-webkit-scrollbar-thumb {
          background: #3c3c3c;
          border-radius: 3px;
          &:hover {
              background: #5a5a5a;
          }
      }
  }
  ```

- [ ] **Step 5: 前端编译与提交**

  Run: `npm run build:ui`
  Expected: 成功打出生产包，且打包出的 assets/index-[hash].js 逻辑完全正确。

  ```bash
  git add ui/app/pages/StatusPage.vue
  git commit -m "feat(ui): implement dual tab-pane mode in API Translation Inspector, support recursive JsonTreeNode and custom LESS styling"
  ```

---

### Task 4: 最终端到端测试、Lint 代码清理

- [ ] **Step 1: 运行 ESLint 与 Prettier 格式净化**

  Run: `npx eslint ui/app/pages/StatusPage.vue ui/app/components/JsonTreeNode.vue --fix`
  Expected: 无任何 ESLint/Prettier 格式和语法报错。

- [ ] **Step 2: 验证树递归展开与一键一页清空逻辑**

  重启后端实例并打开网页：
  1. 验证“API 翻译对照调试器”弹出时，所有 4 面板均默认呈现高亮折叠树（Preview）。
  2. 验证点击树箭头可顺利逐级剥离。长文本提示 hover 时可以顺利气泡展现。
  3. 验证点击 Raw 可顺畅无缝切换到平铺 JSON 格式且一键复制正常。

- [ ] **Step 3: 提交代码完成开发工作分支**

  ```bash
  git status
  ```
  Expected: 清爽无残留的暂存状态。
