# Google Cloud Shell 多账号启动退避与阻断弹窗拟人点击设计规范

- **日期**：2026-09-28
- **模块**：`scripts/cloudshell/`
- **状态**：已批准 (Approved)

---

## 1. 概述与目标

为进一步提高 Google Cloud Shell 自动化工具的反指纹识别与风控防检测能力，对齐原项目 `src/core/BrowserManager.js` 的行为模式：
1. **多账号启动随机退避（1~3 秒）**：在多个账号初始化拉起之间增加 1~3 秒的随机等待，避免多账号并发同时建立连接与加载页面产生机械并发特征。
2. **阻断弹窗拟人化物理点击与优雅回退**：对所有阻断弹窗（包括 `Authorize` 授权、`Reconnect` 重新连接、服务条款等），从原来的直接 JS click 改为完整的真实人类交互轨迹：平滑轨迹逼近 -> 悬停微延迟 -> 物理按下松开 -> 验证并在必要时优雅回退至 DOM JS 强制点击。

---

## 2. 架构设计与详细流程

### 2.1 多账号启动时序退避机制 (Staggered Startup)

- **位置**：`scripts/cloudshell/CloudShellManager.js` 中的 `init()`
- **时序流程**：
  1. 遍历 `this.authIndices`；
  2. 对于列表中的首个账号（`index === 0`），立即执行 `createContextForAuth()`、`newPage()` 并导航；
  3. 对于第 2 个及后续账号（`index > 0`）：
     - 计算随机退避时长：`delayMs = Math.floor(minDelay + Math.random() * (maxDelay - minDelay))`（默认 `[1000, 3000]` ms）；
     - 输出日志：`⏳ [CloudShellManager] Waiting ${(delayMs / 1000).toFixed(1)}s before initializing account #${authIndex} to avoid concurrent detection...`；
     - `await new Promise(r => setTimeout(r, delayMs))`；
     - 随后创建该账号的 Context 并启动终端。
- **配置与可测试性**：
  - 构造函数支持注入 `startupDelayRange: [1000, 3000]`，单元测试中可配置为 `[0, 0]` 或自定义测试值。

---

### 2.2 阻断弹窗拟人物理点击与回退 (Simulated Physical Click & Fallback)

- **位置**：`scripts/cloudshell/CloudShellController.js` 中的 `clickElementSimulated(targetLocator, label)` 与 `bypassModalsOnce()`
- **拟人交互时序**：
  ```
  [ 发现阻断按钮 ]
         │
         ▼
  [ 获取绝对视口坐标 (boundingBox) ] ──── 无法获取 ────┐
         │                                         │
         ▼                                         │
  [ 计算中心扰动坐标 (30%~70% 区域) ]                 │
         │                                         │
         ▼                                         │
  [ simulateHumanMovement 平滑逼近 ]                │
         │                                         │
         ▼                                         │
  [ 手部悬停反应延迟 (150~300ms) ]                    │
         │                                         │
         ▼                                         │
  [ page.mouse.down() (按下) ]                      │
         │                                         │
         ▼                                         │
  [ 物理按压停留时长 (150~350ms) ]                    │
         │                                         │
         ▼                                         │
  [ page.mouse.up() (释放) ]                        │
         │                                         │
         ▼                                         │
  [ 等待 800ms 验证按钮是否消失 ]                     │
         │                                         │
    已消失？                                       │
     ├── 是 ──> [ ✅ 物理点击成功返回 ]             │
     └── 否 ──> [ ⚠️ 物理点击未生效，触发回退 ] <─────┘
                       │
                       ▼
            [ targetLocator.click({ force: true }) ]
  ```

- **覆盖按钮范围**：
  - `button:has-text("Authorize")` / `button:has-text("授权")` / `button[aria-label*="Authorize"]`
  - `button:has-text("Reconnect")` / `button:has-text("重新连接")` / `button:has-text("Restart")`
  - `button:has-text("Agree and continue")` / `button:has-text("同意并继续")` / `button:has-text("Confirm")` / `button:has-text("确认")`

---

## 3. 测试与验证策略

1. **多账号启动延迟测试 (`test/cloudshell/cloudshell_manager.test.js`)**：
   - 验证单账号启动时不产生延迟；
   - 验证多账号启动时在账号间调用了延迟等待。
2. **拟人点击与回退测试 (`test/cloudshell/cloudshell_controller_lifecycle.test.js` & `cloudshell_controller_mouse.test.js`)**：
   - 验证成功获取 boundingBox 时依次调用了平滑移动、mouse.down、mouse.up；
   - 验证按钮消失时成功旁路且不触发回退；
   - 验证按钮未消失时正确回退至 DOM JS click。
3. **代码规范与全套测试**：
   - 执行 `npm run lint` 和 `npm run format:check`；
   - 执行 `npx jest test/cloudshell/` 确保所有测试 100% 通过。
