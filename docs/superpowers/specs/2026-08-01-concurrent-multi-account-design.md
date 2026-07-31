# Design Specification: Lean Concurrent Multi-Account Forwarding (`src/concurrent`)

**Date:** 2026-08-01  
**Status:** Approved  
**Target Directory:** `src/concurrent/`

---

## 1. Overview

This document specifies the architecture and design for the lean concurrent multi-account version of **AIStudioToAPI**. The primary objective is to enable multi-account parallel request forwarding with **maximum code reuse** and **minimal intrusion** into the existing codebase.

When `ENABLE_CONCURRENT=true` is set, the server mounts a lean request handler specifically for native Gemini API endpoints (`/v1beta/models/*`). Requests are scheduled across active Google accounts using a Round-Robin scheduler over established WebSocket browser context connections.

---

## 2. Core Requirements & Constraints

1. **Activation via Environment Variable**: Triggered solely by `ENABLE_CONCURRENT=true`.
2. **Minimal Intrusion**: Zero structural modifications to `main.js`, `BrowserManager.js`, `ConnectionRegistry.js`, or `FormatConverter.js`.
3. **Single API Format**: Only native Gemini API format is supported (`/v1beta/models/*`). OpenAI, Anthropic, UI management routes, and static assets are completely bypassed in concurrent mode.
4. **Round-Robin Scheduling**: A dedicate `AccountScheduler` routes each incoming request to the next available/connected account (`authIndex`).
5. **Concurrent Forwarding**: Enables concurrent processing of multiple streaming/non-streaming requests across different active accounts without global system lock (`isSystemBusy`).

---

## 3. Architecture & File Structure

All new concurrent logic is self-contained inside `src/concurrent/`:

```
src/
└── concurrent/
    ├── index.js                    # Subsystem entry / facade
    ├── AccountScheduler.js         # Account selection & round-robin scheduler
    └── ConcurrentRequestHandler.js # Minimal Gemini API request handler & SSE streaming
```

### 3.1 Integration in `ProxyServerSystem.js`

In `src/core/ProxyServerSystem.js`, inside `registerRoutes()`:

```javascript
if (process.env.ENABLE_CONCURRENT === "true") {
    this.logger.info("🚀 Concurrent mode ENABLED. Initializing concurrent module...");
    const { initConcurrentMode } = require("../concurrent");
    initConcurrentMode(this.app, {
        authSource: this.authSource,
        connectionRegistry: this.connectionRegistry,
        formatConverter: this.formatConverter,
        logger: this.logger
    });
} else {
    // Standard full-featured router
    this.requestHandler.registerRoutes(this.app);
}
```

---

## 4. Component Details

### 4.1 `src/concurrent/index.js` (Facade)

- **Function**: `initConcurrentMode(app, dependencies)`
- **Dependencies**: `{ authSource, connectionRegistry, formatConverter, logger }`
- **Actions**:
  1. Instantiates `AccountScheduler(authSource, connectionRegistry, logger)`.
  2. Instantiates `ConcurrentRequestHandler(connectionRegistry, scheduler, formatConverter, logger)`.
  3. Invokes `concurrentRequestHandler.registerRoutes(app)` to mount Gemini endpoints.

### 4.2 `src/concurrent/AccountScheduler.js`

- **Responsibilities**:
  - Tracks total accounts from `authSource.getAllAccounts()`.
  - Maintains an internal pointer `currentIndex`.
  - Exposes `getNextAuthIndex()`:
    - Scans starting from `currentIndex`.
    - Checks `connectionRegistry.hasConnection(authIndex)`.
    - Returns the first connected `authIndex` and advances `currentIndex = (foundIndex + 1) % totalAccounts`.
    - Throws `503 Service Unavailable` if no accounts are connected.

### 4.3 `src/concurrent/ConcurrentRequestHandler.js`

- **Responsibilities**:
  - Registers Express routes:
    - `POST /v1beta/models/:modelWithAction` (e.g. `:generateContent` or `:streamGenerateContent`)
    - `POST /v1beta/models/*`
    - `GET /v1beta/models`
  - Handles incoming Gemini API requests:
    1. Obtains target `authIndex` via `scheduler.getNextAuthIndex()`.
    2. Gets WebSocket connection from `connectionRegistry.getConnection(authIndex)`.
    3. Sends formatted request to browser script (`build.js`).
    4. Streams SSE response directly back to client (or buffers for non-streaming).
    5. Implements lightweight retry on WS network error.

---

## 5. Verification Plan

1. **Normal Mode**:
   - Run `npm start` (without `ENABLE_CONCURRENT`).
   - Verify existing full system loads normally.

2. **Concurrent Mode**:
   - Run `ENABLE_CONCURRENT=true npm start`.
   - Send consecutive Gemini API requests:
     `POST http://localhost:7860/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=xxx`
   - Verify requests are dispatched across active `authIndex` connections in Round-Robin order without mutual blocking.
