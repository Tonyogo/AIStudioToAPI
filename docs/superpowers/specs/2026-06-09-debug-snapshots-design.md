# Design Spec: Display Account Failure Debug Snapshots in Dashboard

This specification describes the architecture, API, and UI design to present failed account session snapshots (screenshots and HTML source) in the AIStudioToAPI dashboard under a dedicated "Debug" panel.

---

## Context
AIStudioToAPI implements a robust automated browser runner to proxy Google AI Studio API requests. When an automated context fails to initialize, reconnect, or crashes, it automatically saves a full-page screenshot (`.png`) and the page HTML source (`.html`) in the project directory using the helper method `_saveDebugArtifacts`.

Currently, these files accumulate in the root directory of the repository and are only accessible by directly logging into the server/container and reading the filesystem. To make diagnostic workflows developer-friendly, this feature adds a dedicated "Debug & Snapshots" management view to the Status Page UI, allowing developers to view historical failures, browse snapshots, render HTML page structures under a sandbox, and purge files.

---

## Architecture & Data Storage Design

### 1. Unified Storage Folder
All debug failure files will be stored in a dedicated folder in the data directory:
`data/debug/`

We will update the `_saveDebugArtifacts` method in `src/core/BrowserManager.js` to write files directly to `data/debug/` instead of the root directory. If the directory does not exist, it will be created recursively on-demand.

The `.gitignore` file will be modified to exclude the debug folder:
```gitignore
/data/debug/
```

### 2. Upgraded File Naming Schema
To easily extract metadata like account indices and failure scenarios directly from the filenames without side-channel databases, the filenames are unified as follows:
- **Screenshots**: `data/debug/debug_screenshot_auth_[index]_[scene]_[timestamp].png`
- **Page Source**: `data/debug/debug_page_source_auth_[index]_[scene]_[timestamp].html`

**Extraction Regex Pattern**:
```javascript
/^debug_(screenshot|page_source)_(?:auth_(\d+)_)?([a-zA-Z0-9_-]+)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.(png|html)$/
```

- `type`: `screenshot` or `page_source`
- `authIndex`: The index of the account (optional, captured group 2)
- `scene`: The scenario (e.g. `init_failed`, `reconnect_failed`, `click_failed`)
- `timestamp`: The timestamp (formatted as `YYYY-MM-DDTHH-mm-ss`)

### 3. Backend Data Aggregation
The backend scan filters files in `data/debug/` and groups them by `timestamp + scene` into a single **Incident Record** so that the screenshots and corresponding HTML page sources are presented together in the UI table as a single logical event.

---

## API Design (Express Router)

All endpoints require authentication (by chaining the `isAuthenticated` middleware).

### 1. GET /api/debug/snapshots
Scans the `data/debug/` folder, aggregates matching `.png` and `.html` files, parses the filenames to extract metadata, sorts them in descending order (newest first), and returns the array of incidents.

**Response Structure**:
```json
[
  {
    "id": "2026-06-08T14-15-44_init_failed",
    "timestamp": "2026-06-08T14:15:44",
    "authIndex": 2,
    "scene": "init_failed",
    "hasScreenshot": true,
    "hasHtml": true,
    "screenshotFile": "debug_screenshot_auth_2_init_failed_2026-06-08T14-15-44.png",
    "htmlFile": "debug_page_source_auth_2_init_failed_2026-06-08T14-15-44.html"
  }
]
```

### 2. GET /api/debug/snapshots/:id/screenshot
Retrieves the corresponding PNG screenshot.
- Returns binary file with `Content-Type: image/png`.
- Returns a `404 Not Found` if the screenshot file is missing.

### 3. GET /api/debug/snapshots/:id/html
Retrieves the corresponding HTML page source.
- Returns HTML content with `Content-Type: text/html; charset=utf-8`.
- To prevent any security risks (e.g. malicious scripts executing in the control domain), the endpoint will include a strict CSP header:
  `Content-Security-Policy: default-src 'self' 'unsafe-inline'; sandbox`

### 4. DELETE /api/debug/snapshots/:id
Deletes both the `.png` and `.html` files associated with the specified Incident ID.

### 5. DELETE /api/debug/snapshots
Clears/purges all files from the `data/debug/` folder.

---

## Frontend UI/UX Design (Vue 3 / Element Plus)

### 1. Tab View ("Debug")
A new menu-item representing "Debug & Failure Snapshots" is added to the sidebar in `StatusPage.vue`.
Clicking the tab switches `activeTab` to `"debug"`.

### 2. Layout & Interactions
The view contains:
- **Header Section**: Contains title and Action Buttons:
  - `[ 🔄 Refresh ]` and `[ 🗑 Purge All Snapshots ]` (with ElMessageBox confirmation).
- **ElTable List View**:
  - Columns:
    - **Incident Time**: Formatted locally.
    - **Account Index**: Displayed in a stylized ElTag (e.g., `#2`, or gray `"Unassigned"` badge if `authIndex` is absent).
    - **Failure Context**: Maps `scene` string to friendly labels (e.g., `init_failed` -> `Initialization Failed` / `初始化失败`).
    - **Action Controls**:
      - `[ View Screenshot ]` (eye/image icon).
      - `[ View Page Source ]` (code/terminal icon).
      - `[ Delete ]` (trash icon).

### 3. Dialog Viewer Modals
- **Screenshot Viewer Dialog**:
  - Large center modal (`width="80%"`).
  - Displays the screenshot using `<img src="/api/debug/snapshots/[id]/screenshot" style="max-width:100%; height:auto;" />`.
- **Page Source Viewer Dialog**:
  - Extra-large modal (`width="85%"`, `top="5vh"`).
  - Contains an `<iframe>` loading `/api/debug/snapshots/[id]/html`.
  - To prevent potential XSS vulnerabilities, the `<iframe>` strictly enforces:
    `sandbox="allow-same-origin"` (preserving HTML structures and CSS stylesheets, but strictly disabling all script executions).

---

## Verification Plan

### 1. Code Quality
Ensure the code compiled successfully and adheres to linting rules:
```bash
npm run build:ui
npm run lint:js
```

### 2. End-to-End Verification Flow
1. Start the server in development mode.
2. Manually trigger a browser initialization failure (e.g., loading an invalid Google account auth configuration), verifying that files are saved in the new folder `data/debug/` with the correct file name structure.
3. Access the newly created "Debug" tab in the dashboard.
4. Verify the Incident is shown correctly with Timestamp, Account Index, and Scene.
5. Click "View Screenshot", checking if the ElDialog successfully loads and displays the PNG.
6. Click "View Page Source", checking if the sandboxed iframe successfully displays the HTML structure without rendering issues.
7. Perform a deletion, and verify files are physically removed from `data/debug/`.
8. Click "Purge All", and verify the folder becomes empty.
