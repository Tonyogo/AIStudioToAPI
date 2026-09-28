# Google Cloud Shell 多账号启动退避与阻断弹窗拟人点击实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Google Cloud Shell 自动化工具增加多账号启动时 1~3 秒随机退避延迟，并将所有阻断弹窗（Authorize、Reconnect 等）的点击逻辑全面升级为拟人物理点击与优雅回退机制。

**Architecture:** 在 `CloudShellManager.js` 的 `init()` 循环中，针对第 2 个及后续账号启动前注入 `1000 + Math.random() * 2000` ms 随机延迟；在 `CloudShellController.js` 中新增 `clickElementSimulated(targetLocator, label)`，获取按钮视口绝对坐标并加入随机中心扰动，调用 `simulateHumanMovement` 平滑逼近后执行 `mouse.down` 与 `mouse.up`，并在未生效时优雅回退至 DOM JS click。

**Tech Stack:** Node.js, Playwright (Firefox / Camoufox), Jest.

## Global Constraints

- 多账号启动时，第 2 个及后续账号���初始化拉起前必须有 1~3 秒随机等待退避（支持测试配置 `startupDelayRange`）。
- 所有阻断弹窗（Authorize / 授权、Reconnect / 重新连接、Restart、Agree and continue / 同意并继续、Confirm / 确认）必须统一通过拟人物理点击触发。
- 拟人物理点击必须具备效果验证；若按钮仍未消失或无法获取坐标，优雅回退至 DOM JS 强制点击。
- 所有代码必须符合 ESLint 和 Prettier 规范。

---

### Task 1: 实现多账号启动 1~3 秒随机退避机制

**Files:**

- Modify: `scripts/cloudshell/CloudShellManager.js:20-40, 130-160`
- Modify: `test/cloudshell/cloudshell_manager.test.js`

**Interfaces:**

- Consumes: `options.startupDelayRange` (default `[1000, 3000]`), `sleepFn` for test injection
- Produces: `init()` 在多账号循环中，针对 `index > 0` 注入随机等待

- [x] **Step 1: 编写多账号启动退避的失败测试**

在 `test/cloudshell/cloudshell_manager.test.js` 中新增针对启动退避的测试用例：

```javascript
test("waits between context initializations when multiple accounts are present", async () => {
  const sleepCalls = [];
  const mockSleep = ms => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };

  const mockController = {
    navigate: jest.fn().mockResolvedValue(),
    waitForTerminalReady: jest.fn().mockResolvedValue(),
  };

  const manager = new CloudShellManager(null, {
    authIndices: [0, 1, 2],
    createContextFn: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue({ isClosed: () => false }),
    }),
    sleepFn: mockSleep,
    startupDelayRange: [1000, 3000],
  });

  // Mock controller factory or bypass navigation
  manager.createControllerFn = () => mockController;

  await manager.init();

  // 3 accounts: first account 0 delay, second account 1 delay, third account 1 delay => total 2 sleep calls
  expect(sleepCalls.length).toBe(2);
  expect(sleepCalls[0]).toBeGreaterThanOrEqual(1000);
  expect(sleepCalls[0]).toBeLessThanOrEqual(3000);
  expect(sleepCalls[1]).toBeGreaterThanOrEqual(1000);
  expect(sleepCalls[1]).toBeLessThanOrEqual(3000);
});

test("does not wait when only a single account is initialized", async () => {
  const sleepCalls = [];
  const mockSleep = ms => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };

  const manager = new CloudShellManager(null, {
    authIndices: [0],
    createContextFn: jest.fn().mockResolvedValue({
      newPage: jest.fn().mockResolvedValue({ isClosed: () => false }),
    }),
    sleepFn: mockSleep,
  });
  manager.createControllerFn = () => ({
    navigate: jest.fn().mockResolvedValue(),
    waitForTerminalReady: jest.fn().mockResolvedValue(),
  });

  await manager.init();
  expect(sleepCalls.length).toBe(0);
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: FAIL (因为 `init()` 中尚未实现 sleep 退避逻辑)

- [x] **Step 3: 在 `CloudShellManager.js` 中实现启动延迟退避**

1. 在构造函数中引入 `this.startupDelayRange = options.startupDelayRange || [1000, 3000];` 和 `this.sleep = options.sleepFn || (ms => new Promise(r => setTimeout(r, ms)));`；
2. 在 `init()` 循环中：
   ```javascript
   for (let i = 0; i < this.authIndices.length; i++) {
     const authIndex = this.authIndices[i];
     if (i > 0) {
       const [minDelay, maxDelay] = this.startupDelayRange;
       const delayMs = minDelay === maxDelay ? minDelay : Math.floor(minDelay + Math.random() * (maxDelay - minDelay));
       if (delayMs > 0) {
         this.log(
           `⏳ Waiting ${(delayMs / 1000).toFixed(1)}s before initializing account #${authIndex} to avoid detection...`
         );
         await this.sleep(delayMs);
       }
     }
     // ... initialize account
   }
   ```
3. 允许 `createControllerFn` 选项注入以方便单元测试。

- [x] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/cloudshell_manager.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellManager.js test/cloudshell/cloudshell_manager.test.js
git commit -m "feat(cloudshell): add 1-3s staggered startup delay between accounts"
```

---

### Task 2: 实现弹窗阻断按钮的拟人物理点击与优雅回退

**Files:**

- Modify: `scripts/cloudshell/CloudShellController.js:80-120`
- Modify: `test/cloudshell/cloudshell_controller_lifecycle.test.js`
- Create: `test/cloudshell/cloudshell_controller_click.test.js`

**Interfaces:**

- Produces: `controller.clickElementSimulated(targetLocator, label)`
- Consumes: `locator.boundingBox()`, `this.simulateHumanMovement(x, y)`, `this.page.mouse.down()`, `this.page.mouse.up()`, `locator.click({ force: true })`

- [x] **Step 1: 编写拟人物理点击与回退的单元测试**

创建 `test/cloudshell/cloudshell_controller_click.test.js`：

```javascript
/* eslint-env jest */
const { CloudShellController } = require("../../scripts/cloudshell/CloudShellController");

describe("CloudShellController Simulated Click & Fallback", () => {
  test("clickElementSimulated performs smooth move and mouse down/up on button center", async () => {
    const mouseEvents = [];
    const mockPage = {
      isClosed: () => false,
      mouse: {
        down: async () => mouseEvents.push("down"),
        move: async (x, y) => mouseEvents.push({ type: "move", x, y }),
        up: async () => mouseEvents.push("up"),
      },
    };

    const controller = new CloudShellController(mockPage);
    // Spy simulateHumanMovement
    const moveSpy = jest.spyOn(controller, "simulateHumanMovement").mockResolvedValue();

    let visible = true;
    const mockLocator = {
      boundingBox: async () => ({ height: 40, width: 100, x: 200, y: 300 }),
      click: jest.fn().mockResolvedValue(),
      isVisible: async () => {
        const res = visible;
        visible = false; // button disappears after click
        return res;
      },
    };

    const result = await controller.clickElementSimulated(mockLocator, "Authorize");
    expect(result).toBe(true);
    expect(moveSpy).toHaveBeenCalled();
    const [targetX, targetY] = moveSpy.mock.calls[0];
    // Target coordinates must fall inside button bounding box (200~300, 300~340)
    expect(targetX).toBeGreaterThanOrEqual(200);
    expect(targetX).toBeLessThanOrEqual(300);
    expect(targetY).toBeGreaterThanOrEqual(300);
    expect(targetY).toBeLessThanOrEqual(340);

    expect(mouseEvents).toContain("down");
    expect(mouseEvents).toContain("up");
    // Fallback JS click should NOT be called since button disappeared
    expect(mockLocator.click).not.toHaveBeenCalled();
  });

  test("clickElementSimulated falls back to JS click when button remains visible", async () => {
    const mockPage = {
      isClosed: () => false,
      mouse: {
        down: async () => {},
        up: async () => {},
      },
    };

    const controller = new CloudShellController(mockPage);
    jest.spyOn(controller, "simulateHumanMovement").mockResolvedValue();

    const mockLocator = {
      boundingBox: async () => ({ height: 40, width: 100, x: 200, y: 300 }),
      click: jest.fn().mockResolvedValue(),
      isVisible: async () => true, // button still visible after physical click
    };

    const result = await controller.clickElementSimulated(mockLocator, "Authorize");
    expect(result).toBe(true);
    // Fallback JS click MUST be triggered
    expect(mockLocator.click).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });
});
```

- [x] **Step 2: 运行测试以确认失败**

Run: `npx jest test/cloudshell/cloudshell_controller_click.test.js`
Expected: FAIL (`clickElementSimulated` is not a function)

- [x] **Step 3: 在 `CloudShellController.js` 中实现拟人物理点击与回退**

1. 实现 `async clickElementSimulated(targetLocator, label = "button")`：
   - 尝试获取 `box = await targetLocator.boundingBox().catch(() => null)`；
   - 若有 `box`：
     - 计算中心区域微扰动点 `targetX = box.x + box.width * (0.3 + Math.random() * 0.4)`，`targetY = box.y + box.height * (0.3 + Math.random() * 0.4)`；
     - `await this.simulateHumanMovement(targetX, targetY)`；
     - 微悬停 `await new Promise(r => setTimeout(r, 150 + Math.random() * 150))`；
     - `await this.page.mouse.down()`；
     - 物理按压时长 `await new Promise(r => setTimeout(r, 150 + Math.random() * 200))`；
     - `await this.page.mouse.up()`；
     - `this.log(\`🖱️ Physical click executed on "\${label}". Verifying...\`)`;
     - `await new Promise(r => setTimeout(r, 800))`；
     - 校验 `stillVisible = await targetLocator.isVisible({ timeout: 500 }).catch(() => false)`；
     - 若 `!stillVisible` 则点击成功，返回 `true`。
   - 若 `!box` 或物理点击后按钮依然可见：
     - `this.warn(\`⚠️ Physical click ineffective or boundingBox unavailable for "\${label}", falling back to JS force click...\`)`;
     - `await targetLocator.click({ force: true, timeout: 3000 })`;
     - 返回 `true`。
2. 重构 `bypassModalsOnce()`：
   - 将原来直接的 `await target.click({ timeout: 5000 })` 改为调用 `await this.clickElementSimulated(target, selector)`。
3. 同步更新 `test/cloudshell/cloudshell_controller_lifecycle.test.js` 中的 mock 对象以兼容 `boundingBox` 与 `clickElementSimulated`。

- [x] **Step 4: 运行测试确认通过**

Run: `npx jest test/cloudshell/cloudshell_controller_click.test.js test/cloudshell/cloudshell_controller_lifecycle.test.js`
Expected: PASS

- [x] **Step 5: 提交更改**

```bash
git add scripts/cloudshell/CloudShellController.js test/cloudshell/cloudshell_controller_click.test.js test/cloudshell/cloudshell_controller_lifecycle.test.js
git commit -m "feat(cloudshell): implement simulated physical click with JS fallback for dialogs"
```

---

### Task 3: 全量测试回归、文档更新与质量验收 (Docs & Lint)

**Files:**

- Modify: `scripts/cloudshell/README.md`

- [x] **Step 1: 更新 `scripts/cloudshell/README.md`**

在“功能特性”与“工作原理”章节中，补充：

- 多账号启动自动打散（1~3 秒随机退避），消除并发指纹；
- 弹窗旁路升级为拟人化物理鼠标移动、点击与回退兜底机制。

- [x] **Step 2: 运行代码规范检查与格式化**

Run: `npm run format && npm run lint`
Expected: 0 错误，代码排版与格式符合规范。

- [x] **Step 3: 运行全量测试套件**

Run: `npx jest test/cloudshell/`
Expected: 所有 11 个测试套件（50+ 测试用例）100% 全部通过。

- [x] **Step 4: 提交更改**

```bash
git add scripts/cloudshell/README.md
git commit -m "docs(cloudshell): document staggered startup delay and simulated physical click"
```
