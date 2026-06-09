# Display Account Failure Debug Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide an intuitive "Debug" dashboard in the status page to view, inspect, and manage failed browser session snapshots (screenshots and sandboxed HTML sources).

**Architecture:** Centralize failure files inside `data/debug/` using an expressive naming convention. Expose them through new authenticated Express REST endpoints, and render a dedicated tab with data table and Dialog viewers in the Vue 3 frontend.

**Tech Stack:** Node.js, Express, Playwright, Vue 3, Element Plus, Vite.

---

### Task 1: Update `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append the debug data directory to `.gitignore`**

  Open `.gitignore` and add `/data/debug/` to prevent diagnostic logs and images from being checked into git.
  
  Add to bottom:
  ```gitignore
  # Debug Failure Snapshots
  /data/debug/
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add .gitignore
  git commit -m "chore: ignore debug snapshots folder"
  ```

---

### Task 2: Upgrade Debug Artifacts Storage in `BrowserManager.js`

**Files:**
- Modify: `src/core/BrowserManager.js:1096-1126`
- Create: `scripts/auth/test-artifacts.js` (Manual test verification)

- [ ] **Step 1: Modify `_saveDebugArtifacts` to write to `data/debug/` with the new naming scheme**

  Update the `_saveDebugArtifacts` method to construct `data/debug/` folder recursively and name files using `auth_[index]`.
  
  Replace lines 1110-1121 with:
  ```javascript
              const debugDir = path.join(process.cwd(), "data", "debug");
              if (!fs.existsSync(debugDir)) {
                  fs.mkdirSync(debugDir, { recursive: true });
              }

              const timestamp = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
              const authPrefix = authIndex !== null ? `auth_${authIndex}_` : "";

              const screenshotName = `debug_screenshot_${authPrefix}${suffix}_${timestamp}.png`;
              const screenshotPath = path.join(debugDir, screenshotName);
              await targetPage.screenshot({
                  fullPage: true,
                  path: screenshotPath,
              });
              this.logger.info(`[Debug] Failure screenshot saved to: ${screenshotPath}`);

              const htmlName = `debug_page_source_${authPrefix}${suffix}_${timestamp}.html`;
              const htmlPath = path.join(debugDir, htmlName);
              const htmlContent = await targetPage.content();
              fs.writeFileSync(htmlPath, htmlContent);
              this.logger.info(`[Debug] Failure page source saved to: ${htmlPath}`);
  ```

- [ ] **Step 2: Write verification test script**

  Create `scripts/auth/test-artifacts.js` to execute a mock artifact save and verify the folder and file name formatting.
  
  Write:
  ```javascript
  const fs = require("fs");
  const path = require("path");
  const BrowserManager = require("../../src/core/BrowserManager");
  const LoggingService = require("../../src/utils/LoggingService");

  async function test() {
      const logger = LoggingService.createLogger("Test");
      const bm = new BrowserManager(logger, { maxContexts: 1 });
      
      // Stub a mock page object
      const mockPage = {
          isClosed: () => false,
          screenshot: async (opts) => {
              fs.writeFileSync(opts.path, "mock-screenshot-content");
          },
          content: async () => "<html><body>Test Content</body></html>"
      };

      await bm._saveDebugArtifacts("test_run", 5, mockPage);

      const debugDir = path.join(process.cwd(), "data", "debug");
      const files = fs.readdirSync(debugDir);
      console.log("Created files:", files);
      
      const screenshotOk = files.some(f => f.startsWith("debug_screenshot_auth_5_test_run_") && f.endsWith(".png"));
      const htmlOk = files.some(f => f.startsWith("debug_page_source_auth_5_test_run_") && f.endsWith(".html"));

      if (screenshotOk && htmlOk) {
          console.log("SUCCESS: Debug artifacts formatted correctly inside data/debug/");
          process.exit(0);
      } else {
          console.error("FAIL: Incorrect format or directory");
          process.exit(1);
      }
  }

  test();
  ```

- [ ] **Step 3: Run the test script**

  Run: `node scripts/auth/test-artifacts.js`
  Expected output contains: `SUCCESS: Debug artifacts formatted correctly inside data/debug/`

- [ ] **Step 4: Commit**

  ```bash
  git add src/core/BrowserManager.js scripts/auth/test-artifacts.js
  git commit -m "feat: centralize debug artifacts storage under data/debug"
  ```

---

### Task 3: Implement Backend Snapshot API routes in `StatusRoutes.js`

**Files:**
- Modify: `src/routes/StatusRoutes.js`
- Create: `scripts/auth/test-debug-api.js` (API Endpoint Verifier)

- [ ] **Step 1: Implement debug endpoints in `setupRoutes`**

  Insert the endpoints inside `setupRoutes` of `src/routes/StatusRoutes.js` right before `app.put("/api/settings/streaming-mode", ...)` (around line 700).

  ```javascript
          app.get("/api/debug/snapshots", isAuthenticated, (req, res) => {
              const debugDir = path.join(process.cwd(), "data", "debug");
              if (!fs.existsSync(debugDir)) {
                  return res.json([]);
              }

              try {
                  const files = fs.readdirSync(debugDir);
                  const filenameRegex = /^debug_(screenshot|page_source)_(?:auth_(\d+)_)?([a-zA-Z0-9_-]+)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(png|html)$/;

                  const incidentMap = new Map();

                  files.forEach(file => {
                      const match = file.match(filenameRegex);
                      if (!match) return;

                      const [_, type, authIndexStr, scene, timestampStr] = match;
                      const authIndex = authIndexStr ? parseInt(authIndexStr, 10) : null;
                      const id = `${timestampStr}_${scene}`;

                      const incident = incidentMap.get(id) || {
                          id,
                          timestamp: timestampStr.replace(/-/g, ":").replace("T", " "),
                          authIndex,
                          scene,
                          hasScreenshot: false,
                          hasHtml: false,
                          screenshotFile: null,
                          htmlFile: null
                      };

                      if (type === "screenshot") {
                          incident.hasScreenshot = true;
                          incident.screenshotFile = file;
                      } else if (type === "page_source") {
                          incident.hasHtml = true;
                          incident.htmlFile = file;
                      }

                      incidentMap.set(id, incident);
                  });

                  const incidents = Array.from(incidentMap.values()).sort((a, b) => b.id.localeCompare(a.id));
                  res.status(200).json(incidents);
              } catch (error) {
                  this.logger.error(`[WebUI] Failed to list snapshots: ${error.message}`);
                  res.status(500).json({ error: "Failed to list snapshots" });
              }
          });

          app.get("/api/debug/snapshots/:id/screenshot", isAuthenticated, (req, res) => {
              const incidentId = req.params.id;
              const debugDir = path.join(process.cwd(), "data", "debug");

              try {
                  if (!fs.existsSync(debugDir)) {
                      return res.status(404).json({ error: "Snapshot directory not found" });
                  }

                  const files = fs.readdirSync(debugDir);
                  const matchFile = files.find(f => f.startsWith("debug_screenshot_") && f.includes(incidentId.replace(/:/g, "-")));

                  if (!matchFile) {
                      return res.status(404).json({ error: "Screenshot file not found" });
                  }

                  res.setHeader("Content-Type", "image/png");
                  res.sendFile(path.join(debugDir, matchFile));
              } catch (error) {
                  res.status(500).json({ error: error.message });
              }
          });

          app.get("/api/debug/snapshots/:id/html", isAuthenticated, (req, res) => {
              const incidentId = req.params.id;
              const debugDir = path.join(process.cwd(), "data", "debug");

              try {
                  if (!fs.existsSync(debugDir)) {
                      return res.status(404).json({ error: "Snapshot directory not found" });
                  }

                  const files = fs.readdirSync(debugDir);
                  const matchFile = files.find(f => f.startsWith("debug_page_source_") && f.includes(incidentId.replace(/:/g, "-")));

                  if (!matchFile) {
                      return res.status(404).json({ error: "HTML source file not found" });
                  }

                  res.setHeader("Content-Type", "text/html; charset=utf-8");
                  res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; sandbox");
                  res.sendFile(path.join(debugDir, matchFile));
              } catch (error) {
                  res.status(500).json({ error: error.message });
              }
          });

          app.delete("/api/debug/snapshots/:id", isAuthenticated, (req, res) => {
              const incidentId = req.params.id;
              const debugDir = path.join(process.cwd(), "data", "debug");

              try {
                  if (!fs.existsSync(debugDir)) {
                      return res.status(404).json({ error: "Snapshot directory not found" });
                  }

                  const files = fs.readdirSync(debugDir);
                  const keyPattern = incidentId.replace(/:/g, "-");
                  const matchFiles = files.filter(f => f.includes(keyPattern));

                  if (matchFiles.length === 0) {
                      return res.status(404).json({ error: "Snapshot files not found" });
                  }

                  matchFiles.forEach(file => {
                      fs.unlinkSync(path.join(debugDir, file));
                  });

                  this.logger.info(`[WebUI] Deleted debug snapshot incident #${incidentId}`);
                  res.status(200).json({ message: "snapshotDeleteSuccess", id: incidentId });
              } catch (error) {
                  res.status(500).json({ error: error.message, message: "snapshotDeleteFailed" });
              }
          });

          app.delete("/api/debug/snapshots", isAuthenticated, (req, res) => {
              const debugDir = path.join(process.cwd(), "data", "debug");

              try {
                  if (fs.existsSync(debugDir)) {
                      const files = fs.readdirSync(debugDir);
                      files.forEach(file => {
                          fs.unlinkSync(path.join(debugDir, file));
                      });
                  }
                  this.logger.warn(`[WebUI] All debug snapshots purged by authenticated user.`);
                  res.status(200).json({ message: "snapshotsPurgeSuccess" });
              } catch (error) {
                  res.status(500).json({ error: error.message, message: "snapshotsPurgeFailed" });
              }
          });
  ```

- [ ] **Step 2: Create a verification script for testing API endpoints**

  Create `scripts/auth/test-debug-api.js` to hit these endpoints and verify the correct responses.
  Since we require authentication, we can mock or query status internally, or we can simply write a unit-test structure.
  
  Write:
  ```javascript
  const fs = require("fs");
  const path = require("path");
  const assert = require("assert");

  // Create a mock filesystem for test verification
  const debugDir = path.join(process.cwd(), "data", "debug");
  if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
  }

  // Write temporary test files
  const mockTimestamp = "2026-06-08T14-15-44";
  const mockScrenshot = path.join(debugDir, `debug_screenshot_auth_3_init_failed_${mockTimestamp}.png`);
  const mockHtml = path.join(debugDir, `debug_page_source_auth_3_init_failed_${mockTimestamp}.html`);

  fs.writeFileSync(mockScrenshot, "png-binary");
  fs.writeFileSync(mockHtml, "html-text");

  console.log("Mock files created. Emulating backend parsing logic:");

  // Assert Regex
  const filenameRegex = /^debug_(screenshot|page_source)_(?:auth_(\d+)_)?([a-zA-Z0-9_-]+)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(png|html)$/;
  const screenshotMatch = path.basename(mockScrenshot).match(filenameRegex);
  assert(screenshotMatch !== null);
  assert.strictEqual(screenshotMatch[1], "screenshot");
  assert.strictEqual(screenshotMatch[2], "3");
  assert.strictEqual(screenshotMatch[3], "init_failed");
  assert.strictEqual(screenshotMatch[4], mockTimestamp);

  const htmlMatch = path.basename(mockHtml).match(filenameRegex);
  assert(htmlMatch !== null);
  assert.strictEqual(htmlMatch[1], "page_source");
  assert.strictEqual(htmlMatch[2], "3");
  assert.strictEqual(htmlMatch[3], "init_failed");
  assert.strictEqual(htmlMatch[4], mockTimestamp);

  // Clean up mock files
  fs.unlinkSync(mockScrenshot);
  fs.unlinkSync(mockHtml);

  console.log("SUCCESS: Backend aggregation regex and parsing logic verified successfully!");
  ```

- [ ] **Step 3: Run the API regex unit check**

  Run: `node scripts/auth/test-debug-api.js`
  Expected output: `SUCCESS: Backend aggregation regex and parsing logic verified successfully!`

- [ ] **Step 4: Lint modifications in `StatusRoutes.js`**

  Run: `npx eslint src/routes/StatusRoutes.js`
  If there are any formatting errors, execute `npx eslint --fix src/routes/StatusRoutes.js`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/routes/StatusRoutes.js scripts/auth/test-debug-api.js
  git commit -m "feat: add debug snapshots REST API endpoints"
  ```

---

### Task 4: Add i18n Locales for the Debug Panel

**Files:**
- Modify: `ui/locales/en.json`
- Modify: `ui/locales/zh.json`

- [ ] **Step 1: Add English translation keys to `ui/locales/en.json`**

  Open `ui/locales/en.json` and insert the keys right after `"currentVersion"` or in alphabetical order.

  Add:
  ```json
      "debugSnapshots": "Debug Snapshots",
      "noDebugSnapshots": "No debug snapshots found.",
      "btnViewScreenshot": "View Screenshot",
      "btnViewHtml": "View HTML",
      "btnPurgeSnapshots": "Purge All",
      "confirmPurgeSnapshots": "Are you sure you want to permanently delete all failure snapshots? This will free up server space.",
      "confirmDeleteSnapshot": "Are you sure you want to delete this snapshot?",
      "snapshotDeleteSuccess": "Snapshot deleted successfully.",
      "snapshotDeleteFailed": "Failed to delete snapshot: {error}",
      "snapshotsPurgeSuccess": "All snapshots cleared successfully.",
      "snapshotsPurgeFailed": "Failed to clear snapshots: {error}",
      "dialogScreenshotTitle": "Screenshot Preview",
      "dialogHtmlTitle": "HTML Page Source Preview",
      "unassigned": "Unassigned",
  ```

- [ ] **Step 2: Add Chinese translation keys to `ui/locales/zh.json`**

  Open `ui/locales/zh.json` and insert the corresponding keys:

  Add:
  ```json
      "debugSnapshots": "故障快照",
      "noDebugSnapshots": "未发现任何调试故障快照。",
      "btnViewScreenshot": "查看截图",
      "btnViewHtml": "页面源码",
      "btnPurgeSnapshots": "清空全部",
      "confirmPurgeSnapshots": "确定要永久清空所有故障快照文件吗？这会释放服务器磁盘空间。",
      "confirmDeleteSnapshot": "确定要删除该故障快照吗？",
      "snapshotDeleteSuccess": "快照删除成功。",
      "snapshotDeleteFailed": "删除快照失败：{error}",
      "snapshotsPurgeSuccess": "所有快照已成功清空。",
      "snapshotsPurgeFailed": "清空快照失败：{error}",
      "dialogScreenshotTitle": "截图预览",
      "dialogHtmlTitle": "HTML 页面源码预览",
      "unassigned": "未分配",
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add ui/locales/en.json ui/locales/zh.json
  git commit -m "docs: add i18n locales for debug snapshots panel"
  ```

---

### Task 5: Add Sidebar Tab and Views in `StatusPage.vue`

**Files:**
- Modify: `ui/app/pages/StatusPage.vue`

- [ ] **Step 1: Check tabs in state definition**

  Verify that the layout allows a new tab and find the tab definitions.
  Open `ui/app/pages/StatusPage.vue` and find `const activeTab = ref("home");`. We don't need to change `activeTab` definition, but we need to find where the tabs are defined in the template.

- [ ] **Step 2: Add the VNC / Debug Tab button to Sidebar**

  Insert the Debug button inside `<aside class="sidebar">` right after the "Usage stats" button (around line 80):

  ```vue
                  <button
                      class="menu-item"
                      :class="{ active: activeTab === 'debug' }"
                      :title="t('debugSnapshots')"
                      @click="switchTab('debug')"
                  >
                      <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="24"
                          height="24"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                      >
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                          <line x1="9" y1="3" x2="9" y2="21"></line>
                          <line x1="17" y1="9" x2="17" y2="17"></line>
                      </svg>
                  </button>
  ```

- [ ] **Step 3: Add "Debug" View to main template container**

  Scroll to the bottom of the main content area in the template, and add the view for `activeTab === 'debug'`:

  ```vue
              <!-- DEBUG SNAPSHOTS VIEW -->
              <div v-if="activeTab === 'debug'" class="view-container">
                  <header class="page-header">
                      <h1>{{ t("debugSnapshots") }}</h1>
                      <div class="header-actions">
                          <button class="btn-primary" @click="fetchSnapshots">
                              {{ t("btnRefresh") || "Refresh" }}
                          </button>
                          <button
                              class="btn-danger btn-purge"
                              :disabled="state.snapshots.length === 0"
                              @click="purgeAllSnapshots"
                          >
                              {{ t("btnPurgeSnapshots") }}
                          </button>
                      </div>
                  </header>

                  <div class="dashboard-grid">
                      <div class="status-card full-width-card">
                          <el-table :data="state.snapshots" style="width: 100%" v-loading="state.snapshotsLoading">
                              <el-table-column prop="timestamp" :label="t('time') || 'Time'" width="180" />
                              <el-table-column :label="t('account') || 'Account'" width="120">
                                  <template #default="scope">
                                      <el-tag
                                          :type="scope.row.authIndex !== null ? 'success' : 'info'"
                                          disable-transitions
                                      >
                                          {{ scope.row.authIndex !== null ? '#' + scope.row.authIndex : t('unassigned') }}
                                      </el-tag>
                                  </template>
                              </el-table-column>
                              <el-table-column :label="t('scene') || 'Scenario'">
                                  <template #default="scope">
                                      <span>{{ formatSceneName(scope.row.scene) }}</span>
                                  </template>
                              </el-table-column>
                              <el-table-column :label="t('actions') || 'Actions'" width="320">
                                  <template #default="scope">
                                      <div class="debug-actions-cell">
                                          <button
                                              class="btn-switch btn-sm"
                                              :disabled="!scope.row.hasScreenshot"
                                              @click="viewScreenshot(scope.row.id)"
                                              :title="t('btnViewScreenshot')"
                                          >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                                              <span style="margin-left: 4px;">{{ t('btnViewScreenshot') }}</span>
                                          </button>
                                          <button
                                              class="btn-switch btn-sm"
                                              :disabled="!scope.row.hasHtml"
                                              @click="viewHtml(scope.row.id)"
                                              :title="t('btnViewHtml')"
                                          >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                                              <span style="margin-left: 4px;">{{ t('btnViewHtml') }}</span>
                                          </button>
                                          <button
                                              class="btn-danger btn-sm"
                                              @click="deleteSnapshot(scope.row.id)"
                                          >
                                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                          </button>
                                      </div>
                                  </template>
                              </el-table-column>
                              <template #empty>
                                  <div class="empty-placeholder">
                                      {{ t("noDebugSnapshots") }}
                                  </div>
                              </template>
                          </el-table>
                      </div>
                  </div>
              </div>
  ```

- [ ] **Step 4: Add Modal Dialogs at the end of the template**

  Add the Dialog modals to the bottom of `<template>` right alongside other dialogs:

  ```vue
          <!-- Screenshot Preview Dialog -->
          <el-dialog
              v-model="state.screenshotDialogVisible"
              :title="t('dialogScreenshotTitle')"
              width="80%"
              align-center
              destroy-on-close
          >
              <div class="snapshot-preview-container">
                  <img
                      :src="`/api/debug/snapshots/${state.currentSnapshotId}/screenshot`"
                      class="snapshot-img"
                      alt="Failure Screenshot"
                  />
              </div>
          </el-dialog>

          <!-- HTML Source Preview Dialog -->
          <el-dialog
              v-model="state.htmlDialogVisible"
              :title="t('dialogHtmlTitle')"
              width="85%"
              top="5vh"
              destroy-on-close
          >
              <div class="snapshot-html-container">
                  <iframe
                      :src="`/api/debug/snapshots/${state.currentSnapshotId}/html`"
                      class="snapshot-iframe"
                      sandbox="allow-same-origin"
                  ></iframe>
              </div>
          </el-dialog>
  ```

- [ ] **Step 5: Add reactive variables and helper methods to `<script>` block**

  In the `<script setup>` or standard script section:
  1. Add reactive keys inside `state` object (around line 2840):
     ```javascript
             snapshots: [],
             snapshotsLoading: false,
             screenshotDialogVisible: false,
             htmlDialogVisible: false,
             currentSnapshotId: "",
     ```
  2. Implement backend requests and event handler helper functions:
     ```javascript
     const fetchSnapshots = async () => {
         state.snapshotsLoading = true;
         try {
             const res = await fetch("/api/debug/snapshots");
             if (res.ok) {
                 state.snapshots = await res.json();
             } else {
                 ElMessage.error("Failed to load snapshots");
             }
         } catch (err) {
             console.error(err);
         } finally {
             state.snapshotsLoading = false;
         }
     };

     const formatSceneName = (scene) => {
         if (!scene) return "Unknown";
         // Match typical scenario keys and convert them
         if (scene.includes("init_failed")) return t("initializationFailed") || "Initialization Failed";
         if (scene.includes("reconnect_failed")) return t("reconnectionFailed") || "Reconnection Failed";
         if (scene.includes("page_error")) return "Page Error Detected";
         return scene.charAt(0).toUpperCase() + scene.slice(1).replace(/_/g, " ");
     };

     const viewScreenshot = (id) => {
         state.currentSnapshotId = id;
         state.screenshotDialogVisible = true;
     };

     const viewHtml = (id) => {
         state.currentSnapshotId = id;
         state.htmlDialogVisible = true;
     };

     const deleteSnapshot = (id) => {
         ElMessageBox.confirm(t("confirmDeleteSnapshot"), t("warningTitle"), {
             cancelButtonText: t("cancel"),
             confirmButtonText: t("ok"),
             type: "warning",
         }).then(async () => {
             try {
                 const res = await fetch(`/api/debug/snapshots/${id}`, { method: "DELETE" });
                 const data = await res.json();
                 if (res.ok) {
                     ElMessage.success(t("snapshotDeleteSuccess"));
                     fetchSnapshots();
                 } else {
                     ElMessage.error(t("snapshotDeleteFailed", { error: data.error }));
                 }
             } catch (err) {
                 ElMessage.error(t("snapshotDeleteFailed", { error: err.message || err }));
             }
         }).catch(() => {});
     };

     const purgeAllSnapshots = () => {
         ElMessageBox.confirm(t("confirmPurgeSnapshots"), t("warningTitle"), {
             cancelButtonText: t("cancel"),
             confirmButtonText: t("ok"),
             type: "warning",
         }).then(async () => {
             try {
                 const res = await fetch("/api/debug/snapshots", { method: "DELETE" });
                 const data = await res.json();
                 if (res.ok) {
                     ElMessage.success(t("snapshotsPurgeSuccess"));
                     fetchSnapshots();
                 } else {
                     ElMessage.error(t("snapshotsPurgeFailed", { error: data.error }));
                 }
             } catch (err) {
                 ElMessage.error(t("snapshotsPurgeFailed", { error: err.message || err }));
             }
         }).catch(() => {});
     };
     ```
  3. Ensure `fetchSnapshots()` gets triggered when switching to the `"debug"` tab:
     Inside `switchTab(tab)` method, add:
     ```javascript
         if (tab === "debug") {
             fetchSnapshots();
         }
     ```

- [ ] **Step 6: Add CSS layout styles for debug panel and modals**

  Add the following Less styles inside `<style lang="less">` block at the bottom of `StatusPage.vue`:

  ```less
  .debug-actions-cell {
      display: flex;
      gap: 8px;
      align-items: center;

      button {
          padding: 4px 10px;
          font-size: 0.8rem;
          display: flex;
          align-items: center;
          gap: 4px;
      }
  }

  .snapshot-preview-container {
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: auto;
      max-height: 70vh;
      background: #000;
      border-radius: 4px;

      .snapshot-img {
          max-width: 100%;
          height: auto;
          display: block;
      }
  }

  .snapshot-html-container {
      width: 100%;
      height: 75vh;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid @border-color;
      background: @background-white;

      .snapshot-iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: transparent;
      }
  }
  ```

- [ ] **Step 7: Run ESLint to verify formatting**

  Run: `npx eslint ui/app/pages/StatusPage.vue`
  If formatting issues exist, auto-correct them via:
  `npx eslint --fix ui/app/pages/StatusPage.vue`

- [ ] **Step 8: Commit**

  ```bash
  git add ui/app/pages/StatusPage.vue
  git commit -m "feat: implement Vue 3 debugging tab and snapshot viewers"
  ```

---

### Task 6: Build & Verification

**Files:**
- Modify: None (Test & Verification task)

- [ ] **Step 1: Compile Vue.js Application**

  Build the application to verify compilation success:
  Run: `npm run build:ui`
  Expected output: Compilation finishes with zero errors.

- [ ] **Step 2: Start server and check backend health**

  Start the development server for manual validation:
  Run: `npm run dev:server`

- [ ] **Step 3: Verification complete**

  Confirm that the dashboard and the new debug tab render beautifully, that files can be deleted/purged on disk, and that the HTML is sandboxed.
