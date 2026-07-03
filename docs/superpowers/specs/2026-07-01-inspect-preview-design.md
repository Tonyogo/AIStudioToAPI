# 系统设计规格说明书（System Design Spec）：API 翻译对照调试器 JSON 折叠树（Preview）支持

本文档详细规划了 **AIStudioToAPI** 服务中，针对 API 翻译对照调试器弹窗进行可视化折叠树（Preview 模式）升级的设计。该功能解耦了传统平铺美化 JSON，引入了自递归折叠树组件并支持在每个 Panel 卡片顶部进行“折叠树 (Preview)”与“原始报文 (Raw)”双向无缝页签切换，大幅度提升了大报文调试分析效率。

## 一、 系统架构与组件解耦（Decomposition & Folder Structure）

为了防止 `StatusPage.vue` 核心业务页面产生过度膨胀，我们遵循单一职责原则（Single Responsibility），将折叠树渲染算法与高亮排版解耦到一个专门的子组件中：

```
+-------------------------------------------------------------------------+
|                              StatusPage.vue (Dialog)                    |
|                                                                         |
|   +------------------+   +------------------+   +------------------+    |
|   |    OpenAI Req    |   |    Gemini Req    |   |    Gemini Res    |    |
|   |  [Preview / Raw] |   |  [Preview / Raw] |   |  [Preview / Raw] |    |
|   +--------+---------+   +--------+---------+   +--------+---------+    |
|            |                      |                      |              |
|            | If Preview           | If Preview           | If Preview   |
|            v                      v                      v              |
|   +-----------------------------------------------------------------+   |
|   |                     JsonTreeNode.vue (Self-Recursion)           |   |
|   |  Renders JSON as expandable tree + hover tooltips for long texts|   |
|   +-----------------------------------------------------------------+   |
+-------------------------------------------------------------------------+
```

---

## 二、 模块设计细节（Module Design Details）

### 1. 自递归折叠树节点组件设计 (`ui/app/components/JsonTreeNode.vue`)

该组件是一个纯前端无状态（Stateless，唯独内部展开状态由节点本身维护）的递归节点树，支持全类型映射：

*   **Props 声明定义**：
    ```javascript
    defineProps({
        name: { type: [String, Number], default: "" }, // Key 键名，或是数组 Index
        val: { type: null, required: true },          // 节点数据
        depth: { type: Number, default: 0 },          // 深度层级（控制缩进）
        isLast: { type: Boolean, default: true }       // 是否为当前级的末尾元素（控制尾部逗号渲染）
    });
    ```
*   **状态与默认展开树逻辑**：
    *   `expanded`：由组件本身使用 `ref(depth <= 1)` 来初始化。即：在初始渲染时，**根节点和第一层级子属性默认展开**，其余更深属性默认收起。这能保证页面首屏极佳的紧凑骨架。
*   **类型分流排版与高亮**：
    *   **对象/数组复合型**：
        *   首行渲染：展示带有旋转三角箭头的 Toggle 按钮，显示 Key 名称或数组索引，并附加显示大括号或中括号摘要、长度提示（如 `{...} 12 keys` 或 `[...] 4 items`）。
        *   子级节点：通过 `v-if="expanded"` 延迟渲染子节点，循环调用 `<json-tree-node v-for="(v, k) in val" :key="k" :name="k" :val="v" :depth="depth + 1" ... />`，大幅压低内存常驻。
    *   **基础值类型**：
        *   不显示三角箭头，直接渲染 `Key: Value`，并根据以下色值进行高亮区分：
            *   `String` 字符串：`#ce9178`（温暖橙黄，若长度大于 80 个字符，渲染为 `\"前 80 字符...\"` 并附加 `<el-tooltip placement="top" effect="dark" raw-content>` 提供全局气泡 hover 预览全貌）。
            *   `Number` 数值：`#b5cea8`（柔和草绿）。
            *   `Boolean` 布尔：`#569cd6`（天蓝色）。
            *   `Null / Undefined`：`#808080`（灰色）。

---

### 2. 多卡片双模页签切换设计 (`ui/app/pages/StatusPage.vue`)

我们在对比弹窗内，对 4 重面板分别引入微型的 “Preview / Raw” 单独切换器：

*   **页签响应式状态**：
    在 `StatusPage.vue` 中定义 4 个 Panel 的默认页签：
    ```javascript
    const panelTabs = reactive({
        client_req: "preview",
        gem_req: "preview",
        gem_res: "preview",
        client_res: "preview"
    });
    ```
    当弹窗打开或切换时，自动重置这 4 个值到 `"preview"` 默认展示树状态。
*   **卡片头部（Header）结构改造**：
    卡片左侧展示页签组，右侧展示复制/操作。
    ```html
    <div class="code-card-header">
        <div class="card-tab-group">
            <span class="card-title-text">{{ t("clientRequest") }}</span>
            <button class="card-tab-btn" :class="{ 'is-active': panelTabs.client_req === 'preview' }" @click="panelTabs.client_req = 'preview'">{{ t("previewMode") }}</button>
            <button class="card-tab-btn" :class="{ 'is-active': panelTabs.client_req === 'raw' }" @click="panelTabs.client_req = 'raw'">{{ t("rawMode") }}</button>
        </div>
        <el-button size="small" type="primary" link @click="copyPayloadText(inspectorState.data.client_req)">
            {{ t("copyPayload") }}
        </el-button>
    </div>
    ```
*   **面板多槽动态分流挂载**：
    ```html
    <div class="code-card-body">
        <!-- Preview mode: JSON TREE -->
        <div v-if="panelTabs.client_req === 'preview'" class="tree-wrapper">
            <json-tree-node :val="inspectorState.data.client_req" />
        </div>
        <!-- Raw mode: PRE TEXT -->
        <pre v-else class="code-editor">{{ formatJson(inspectorState.data.client_req) }}</pre>
    </div>
    ```

---

## 三、 多语言国际化（Locales）

#### 英文 (`en.json`)
```json
{
    "previewMode": "Preview",
    "rawMode": "Raw"
}
```

#### 中文 (`zh.json`)
```json
{
    "previewMode": "折叠树",
    "rawMode": "原始报文"
}
```

---

## 四、 测试与验证（Verification & Test）

1.  **编译与打包验证**：
    运行 `npm run build:ui` 确保 Vite 正常抓取、解析自递归的 `JsonTreeNode.vue` 组件并顺利产出打包文件。
2.  **树折叠与气泡悬浮自适应测试**：
    打开一条超过 2000 字符的长文本 OpenAI 响应日志。
    *   验证折叠树首层能正常展开，二层及更深层成功收起。
    *   验证生成的大段 Assistant 回答被安全截断显示，当鼠标悬浮在其上时，Element Plus 的 Tooltip 浮层能准确、即时地流式浮现显示完整的几千字回答。
3.  **零污染性测试**：
    在切换 “Raw” 与 “Preview” 页签时，验证一键“复制报文（Copy Payload）”的功能工作正常且获取到的依然是完整、未截断的纯文本美化 JSON 字符。
