# Concurrent Thinking Level Model Suffix Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `thinkingLevel` (and built-in tool) model name suffix parsing and injection in `ConcurrentRequestHandler` for concurrent Gemini API requests.

**Architecture:** Update `ConcurrentRequestHandler.js` to parse model suffixes (thinking level, built-in tools) from request paths, clean the model name for scheduler routing, and mutate `req.body` to inject `thinkingLevel` and tool flags into `generationConfig.thinkingConfig` before sending through WebSocket.

**Tech Stack:** Node.js, Express, Jest, ESLint

## Global Constraints

- ESLint (`npm run lint:js`) must pass with 0 errors.
- All Jest tests in `test/concurrent/` must pass 100%.

---

### Task 1: Support thinkingLevel and tool model suffix parsing & injection in `ConcurrentRequestHandler.js` and write unit tests

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `FormatConverter.parseModelBuiltInToolSuffixes`, `FormatConverter.parseModelStreamingModeSuffix`, `FormatConverter.parseModelThinkingLevel`
- Produces: Correctly mutated `req.body.generationConfig.thinkingConfig.thinkingLevel` sent via `sendRequest` in `ConcurrentRequestHandler.js`.

- [ ] **Step 1: Write failing test in `test/concurrent/concurrent_request_handler.test.js`**

Add unit test verifying model suffix parsing and injection in `handleGeminiRequest`:

```javascript
    test("handleGeminiRequest parses model suffixes and injects thinkingLevel into req.body", async () => {
        mockConnectionRegistry.sendRequest.mockImplementation(async (authIndex, payload, cb) => {
            cb({ candidates: [] }, true, false, { status: 200 });
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [{ parts: [{ text: "hi" }] }] },
            method: "POST",
            path: "/v1beta/models/gemini-3-flash-preview-minimal:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledWith("gemini-3-flash-preview");
        expect(mockConnectionRegistry.sendRequest).toHaveBeenCalled();
        const sendPayload = mockConnectionRegistry.sendRequest.mock.calls[0][1];
        const parsedBody = JSON.parse(sendPayload.body);
        expect(parsedBody.generationConfig.thinkingConfig.thinkingLevel).toBe("MINIMAL");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js -t "injects thinkingLevel"`
Expected: FAIL (because `parsedBody.generationConfig` does not exist yet or thinkingLevel is undefined).

- [ ] **Step 3: Update `ConcurrentRequestHandler.js`**

1. Update `_extractCleanModelName(pathStr)` or `handleGeminiRequest(req, res)`:

In `handleGeminiRequest`:
```javascript
        const FormatConverter = require("../core/FormatConverter");
        const {
            cleanModelName: toolStripped,
            forceCodeExecution: modelForceCodeExecution,
            forceWebSearch: modelForceWebSearch,
        } = FormatConverter.parseModelBuiltInToolSuffixes(req.path);
        const { cleanModelName: streamStripped } = FormatConverter.parseModelStreamingModeSuffix(toolStripped);
        const { cleanModelName, thinkingLevel: modelThinkingLevel } =
            FormatConverter.parseModelThinkingLevel(streamStripped);

        if (req.method === "POST" && req.body && typeof req.body === "object") {
            if (modelThinkingLevel) {
                if (!req.body.generationConfig) {
                    req.body.generationConfig = {};
                }
                if (!req.body.generationConfig.thinkingConfig) {
                    req.body.generationConfig.thinkingConfig = {};
                }
                req.body.generationConfig.thinkingConfig.thinkingLevel = modelThinkingLevel;
            }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: PASS

- [ ] **Step 5: Run linter checks**

Run: `npm run lint:js`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit changes**

```bash
git add src/concurrent/ConcurrentRequestHandler.js test/concurrent/concurrent_request_handler.test.js
git commit -m "feat(concurrent): support model thinkingLevel suffix in ConcurrentRequestHandler"
```
