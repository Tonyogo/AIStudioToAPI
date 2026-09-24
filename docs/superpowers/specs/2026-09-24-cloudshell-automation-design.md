# Design Specification: Google Cloud Shell Automation Runner

- **Author**: AI Assistant & yatao
- **Date**: 2026-09-24
- **Topic**: Google Cloud Shell Auth Injection & Interactive Command Automation
- **Status**: Approved for Implementation

---

## 1. Overview & Purpose

### 1.1 Goal
Create a standalone CLI runner script (`scripts/cloudshell/runCloudShell.js`) that leverages AIStudioToAPI's existing authentication mechanisms, Camoufox/Firefox browser automation, proxy configurations, and anti-fingerprinting techniques to:
1. Inject stored Google credentials (`configs/auth/auth-N.json`).
2. Navigate to Google Cloud Shell (`https://shell.cloud.google.com/?show=terminal`).
3. Handle Cloud Shell startup lifecycle, wait for VM provisioning, and automatically bypass modal popups (e.g. "Authorize", "Reconnect", ToS).
4. Locate the embedded Web Terminal (xterm.js inside iframes) and simulate realistic keyboard typing to dispatch predefined commands.
5. Provide keep-alive / anti-idle heartbeat capabilities to prevent the Google Cloud Shell VM from terminating due to inactivity.

### 1.2 Non-Goals
- Real-time bi-directional interactive SSH terminal emulation over local stdin/stdout (e.g., ncurses/tmux terminal mirror).
- Replacing gcloud CLI or Google Cloud SDK programmatic API access.

---

## 2. CLI Interface & Configuration

### 2.1 File Location & Script Entry
- Script entry point: `scripts/cloudshell/runCloudShell.js`
- npm script mapping in `package.json`: `"cloudshell": "node scripts/cloudshell/runCloudShell.js"`

### 2.2 CLI Options

| Argument | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `--auth <index>` | Integer | `0` | Specifies which auth credential file to load (`configs/auth/auth-N.json`). |
| `--cmd <command>` | String | `null` | Single command to execute in Cloud Shell once the terminal is ready. |
| `--file <path>` | String | `null` | Path to a local bash file containing commands to run sequentially. |
| `--keep-alive <min>` | Integer | `0` | Keep-alive duration in minutes after command dispatch (`0` = exit immediately after commands; `-1` = run indefinitely until `SIGINT`). |
| `--heartbeat-interval <s>` | Integer | `120` | Interval in seconds between anti-idle heartbeats (default 120s, well below Google's 20m timeout). |
| `--headless` / `--headed` | Boolean flag | `--headless` | Launch browser headless or headed (for visual debugging). |
| `--proxy <url>` | String | Env Proxy | Explicit proxy URL (defaults to `parseProxyFromEnv()` from `.env`). |
| `--debug` | Boolean flag | `false` | Enable verbose diagnostics, dumping screenshots and DOM trees to `logs/cloudshell/`. |
| `-h`, `--help` | Boolean flag | `false` | Show CLI help message and examples. |

---

## 3. Architecture & Components

```
┌────────────────────────────────────────────────────────┐
│               runCloudShell.js CLI                     │
├────────────────────────────────────────────────────────┤
│ 1. CLI Arg Parser & Proxy Config Resolver              │
│ 2. Auth Source Loader (configs/auth/auth-N.json)       │
├────────────────────────────────────────────────────────┤
│ Playwright Browser Engine                              │
│ ├─ Camoufox / Firefox Launch with DoH Disabled         │
│ ├─ New Context with storageState (Cookies/Origins)     │
│ └─ InitScript: Privacy & Fingerprint Masking           │
├───────────────────��────────────────────────────────────┤
│ Cloud Shell Controller (Page Automation)               │
│ ├─ Lifecycle Monitor: Detection of Sign-in/Expiration  │
│ ├─ Dialog Auto-Bypasser (Authorize / Reconnect / ToS)  │
│ ├─ Terminal Discovery & Frame Piercing (xterm.js)      │
│ ├─ Command Dispatcher (Simulated Typing + Enter)       │
│ └─ Anti-Idle Heartbeat Timer (Space + Backspace)       │
└────────────────────────────────────────────────────────┘
```

### 3.1 Browser Initialization & Authentication Injection
- **Binary Resolution**:
  - Checks platform and searches for local Camoufox binaries (`camoufox-linux/camoufox`, `camoufox/camoufox.exe`, `camoufox-macos/...`).
  - Falls back to Playwright bundled `firefox` if custom binary is unavailable.
- **Firefox Preferences**:
  - Disable DoH (`network.trr.mode = 5`) to ensure DNS resolution honors system/proxy settings.
  - Disable update checks, telemetry, and background tab throttling.
- **Auth Injection**:
  - Reads `configs/auth/auth-${authIndex}.json`.
  - Injects `storageState` directly into `browser.newContext({ storageState, ... })`.
- **Anti-Fingerprint Script (`addInitScript`)**:
  - Sets `navigator.webdriver = undefined`.
  - Mocks standard plugin entries if empty.
  - Spoofs WebGL vendor/renderer parameters consistently.

### 3.2 Page Lifecycle & Dialog Bypass
1. **Target URL**: `https://shell.cloud.google.com/?show=terminal`
2. **Expired Auth Detection**:
   - Checks if redirected to `accounts.google.com`, `ServiceLogin`, or if title includes "Sign in" / "登录".
   - Immediately raises descriptive error informing the user that authentication has expired.
3. **Provisioning Wait & Polling Dialog Bypasser**:
   - While waiting for the terminal to ready, a periodic scan (every 1.5s) checks for modal overlays:
     - **Authorize Modal**: Clicks buttons with text "Authorize" / "授权" or attribute `[aria-label*="Authorize"]`.
     - **Reconnect Modal**: Clicks "Reconnect" / "重新连接" when session expired or disconnected.
     - **Terms of Service**: Checks for agreement checkboxes and "Agree and continue" / "同意并继续" buttons.

### 3.3 Terminal Piercing & Focus
- Cloud Shell encapsulates xterm inside nested iframes (often `devshell-frame` or cloudshell container frames).
- Scans `page.frames()` to locate:
  1. `textarea.xterm-helper-textarea`
  2. `.xterm-screen`, `.terminal`, or `[role="terminal"]`
- Dispatches click events to the terminal canvas/screen to trigger real DOM focus.
- Focuses the underlying helper textarea if available.

### 3.4 Command Dispatching
- Commands are sanitized and split by line.
- For each command:
  1. Ensures terminal has focus.
  2. Types characters using `page.keyboard.type(cmd, { delay: 15 })` to simulate natural keypress events.
  3. Pauses 200ms, then sends `page.keyboard.press('Enter')`.
  4. Waits 1000ms before executing the next line if multiple commands are provided.

### 3.5 Anti-Idle Heartbeat & Keep-Alive
- If `--keep-alive` is specified (> 0 or -1):
  - Enters a heartbeat loop running every `--heartbeat-interval` seconds (default: 120s).
  - Each tick:
    - Verifies page is still open and active.
    - Sends a benign keypress: `page.keyboard.press('Space')` followed by `page.keyboard.press('Backspace')`.
    - Logs heartbeat timestamp to stdout.
  - Automatically resolves and exits when total elapsed time reaches `--keep-alive` minutes (or continues forever if `-1`).

### 3.6 Graceful Shutdown & Diagnostic Artifacts
- **Signals**: Intercepts `SIGINT` (Ctrl+C) and `SIGTERM`. Cleans up heartbeat intervals and invokes `browser.close()` before process termination.
- **Diagnostics on Failure or `--debug`**:
  - Saves full-page screenshot: `logs/cloudshell/cloudshell-error-<timestamp>.png`.
  - Saves dumped HTML content: `logs/cloudshell/cloudshell-error-<timestamp>.html`.

---

## 4. Verification & Testing Strategy
1. **CLI Argument & Config Test**:
   - Verify `--help` outputs usage instructions.
   - Verify error handling when `auth-N.json` does not exist.
2. **Headed Dry Run**:
   - Run `node scripts/cloudshell/runCloudShell.js --auth 0 --headed --cmd "echo 'Hello CloudShell'"` to visually verify:
     - Auth cookies take effect without Google login prompts.
     - Cloud Shell provisioning completes.
     - Authorize / Reconnect modals are clicked.
     - Terminal receives focus and types the command.
3. **Headless & Keep-Alive Test**:
   - Run in headless mode with `--keep-alive 2` to verify heartbeat events and clean exit.
