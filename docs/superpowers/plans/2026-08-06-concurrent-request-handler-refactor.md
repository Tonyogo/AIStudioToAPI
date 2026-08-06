# Concurrent Request Handler Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `ConcurrentRequestHandler.js` to remove retry loops (single-dispatch architecture) and decompose `handleGeminiRequest` into modular helper methods (`_buildProxyRequestPayload` and `_sendResponseChunk`).

**Architecture:** Decompose `handleGeminiRequest` into `_buildProxyRequestPayload` (request cleaning, suffix parsing, tool/thinking/safety injection) and `_sendResponseChunk` (response transform, image processing, SSE/JSON output). Remove the `while (attempt < maxAttempts)` loop in favor of single dispatch.

**Tech Stack:** Node.js, Express, Jest, ESLint

## Global Constraints

- All 61+ Jest tests in `test/concurrent/` must pass 100%.
- ESLint (`npm run lint:js`) must pass with 0 errors.

---

### Task 1: Refactor `ConcurrentRequestHandler.js` by removing retries and modularizing helpers, and update unit tests

**Files:**
- Modify: `src/concurrent/ConcurrentRequestHandler.js`
- Test: `test/concurrent/concurrent_request_handler.test.js`

**Interfaces:**
- Consumes: `this.scheduler.getNextAuthIndex`, `this.connectionRegistry.sendRequest`, `FormatConverter` helper methods
- Produces: `ConcurrentRequestHandler.prototype._buildProxyRequestPayload`, `ConcurrentRequestHandler.prototype._sendResponseChunk`, and refactored `ConcurrentRequestHandler.prototype.handleGeminiRequest`.

- [ ] **Step 1: Write unit tests for single dispatch without retry in `test/concurrent/concurrent_request_handler.test.js`**

Update/add test in `test/concurrent/concurrent_request_handler.test.js` verifying that when `sendRequest` reports an error, `handleGeminiRequest` does NOT retry across accounts and directly returns the error:

```javascript
    test("handleGeminiRequest does not retry across accounts on error and returns error directly", async () => {
        mockConnectionRegistry.sendRequest = jest.fn((authIndex, payload, cb) => {
            cb("Backend error", true, true, { status: 500 });
        });

        const handler = new ConcurrentRequestHandler(mockConnectionRegistry, mockScheduler, mockLogger);

        const req = {
            body: { contents: [{ parts: [{ text: "hi" }] }] },
            method: "POST",
            path: "/v1beta/models/gemini-2.5-flash:generateContent",
            query: {},
        };

        const res = {
            headersSent: false,
            json: jest.fn(),
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
        };

        await handler.handleGeminiRequest(req, res);

        expect(mockScheduler.getNextAuthIndex).toHaveBeenCalledTimes(1);
        expect(mockConnectionRegistry.sendRequest).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: {
                code: 500,
                message: "Backend error",
                status: "INTERNAL",
            },
        });
    });
```

- [ ] **Step 2: Run test to verify current behavior vs new expectations**

Run: `npx jest test/concurrent/concurrent_request_handler.test.js`
Expected: Test runs (may pass or fail depending on retry loop behavior with `maxAttempts=2`).

- [ ] **Step 3: Refactor `src/concurrent/ConcurrentRequestHandler.js`**

1. Create `_buildProxyRequestPayload(req, requestId)`:
```javascript
    /**
     * Build normalized proxy request payload for native Gemini API requests
     * @param {Object} req - Express request object
     * @param {string} requestId - Request ID
     * @returns {Object} Payload metadata and normalized request body
     */
    _buildProxyRequestPayload(req, requestId) {
        const FormatConverter = require("../core/FormatConverter");
        const config = this.scheduler?.config || {};
        const fullPath = req.path;
        let cleanPath = fullPath.replace(/^\/proxy/, "");
        const bodyObj = req.body;
        let requestBodyObj = bodyObj;
        let responseTransform = null;

        const modelPathMatch = cleanPath.match(
            /^(\/(?:v1beta|v1)\/models\/)([^:]+)(:(generateContent|streamGenerateContent).*)$/
        );
        let modelThinkingLevel = null;
        let modelStreamingMode = null;
        let modelForceCodeExecution = false;
        let modelForceWebSearch = false;

        const match = typeof cleanPath === "string" ? cleanPath.match(/\/models\/([^:/?]+)(?::|$)/) : null;
        const rawModel = match ? match[1] : cleanPath;

        const {
            cleanModelName: toolStripped,
            forceCodeExecution: parsedForceCodeExecution,
            forceWebSearch: parsedForceWebSearch,
        } = FormatConverter.parseModelBuiltInToolSuffixes(rawModel);
        const { cleanModelName: streamStripped, streamingMode: parsedStreamingMode } =
            FormatConverter.parseModelStreamingModeSuffix(toolStripped);
        const { cleanModelName, thinkingLevel: parsedThinkingLevel } =
            FormatConverter.parseModelThinkingLevel(streamStripped);

        modelForceCodeExecution = parsedForceCodeExecution;
        modelForceWebSearch = parsedForceWebSearch;
        modelStreamingMode = parsedStreamingMode;
        modelThinkingLevel = parsedThinkingLevel;

        if (modelPathMatch) {
            const pathPrefix = modelPathMatch[1];
            const pathSuffix = modelPathMatch[3];
            if (cleanModelName !== modelPathMatch[2]) {
                cleanPath = `${pathPrefix}${cleanModelName}${pathSuffix}`;
            }
        }

        if (config.forceThinking && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (
                !bodyObj.generationConfig.thinkingConfig ||
                bodyObj.generationConfig.thinkingConfig.includeThoughts === undefined
            ) {
                if (this.logger && typeof this.logger.info === "function") {
                    this.logger.info(
                        `[Proxy] ⚠️ Force thinking enabled, setting includeThoughts=true. (Google Native)`
                    );
                }
                bodyObj.generationConfig.thinkingConfig = {
                    ...(bodyObj.generationConfig.thinkingConfig || {}),
                    includeThoughts: true,
                };
            }
        }

        if (modelThinkingLevel && req.method === "POST" && bodyObj && bodyObj.contents) {
            if (!bodyObj.generationConfig) {
                bodyObj.generationConfig = {};
            }
            if (!bodyObj.generationConfig.thinkingConfig) {
                bodyObj.generationConfig.thinkingConfig = {};
            }
            bodyObj.generationConfig.thinkingConfig.thinkingLevel = modelThinkingLevel;
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[Proxy] Applied thinkingLevel from model name suffix: ${modelThinkingLevel} (Google Native)`
                );
            }
        }

        if (req.method === "POST" && bodyObj) {
            if (bodyObj.contents) {
                this.formatConverter.ensureThoughtSignature(bodyObj);
            }
            if (bodyObj.tools) {
                this.formatConverter.sanitizeGeminiTools(bodyObj);
            }
        }

        const embedContentMatch = cleanPath.match(/^\/(?:v1beta|v1)\/models\/([^:]+):embedContent$/);
        if (req.method === "POST" && embedContentMatch) {
            const modelName = embedContentMatch[1];
            const version = cleanPath.startsWith("/v1/") ? "/v1" : "/v1beta";
            cleanPath = `${version}/models/${modelName}:batchEmbedContents`;
            requestBodyObj = {
                requests: [
                    {
                        ...bodyObj,
                        model: `models/${modelName}`,
                    },
                ],
            };
            responseTransform = "batchEmbedToEmbedContent";
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(`[Proxy] Rewriting embedContent to batchEmbedContents for model "${modelName}".`);
            }
        }

        if (
            (config.forceWebSearch ||
                modelForceWebSearch ||
                config.forceUrlContext ||
                config.forceCodeExecution ||
                modelForceCodeExecution) &&
            req.method === "POST" &&
            bodyObj &&
            bodyObj.contents
        ) {
            if (!bodyObj.tools) {
                bodyObj.tools = [];
            }

            const toolsToAdd = [];

            if (config.forceWebSearch || modelForceWebSearch) {
                const hasSearch = FormatConverter.hasGeminiGoogleSearchTool(bodyObj.tools);
                if (!hasSearch) {
                    bodyObj.tools.push({ googleSearch: {} });
                    toolsToAdd.push("googleSearch");
                }
            }

            if (config.forceUrlContext) {
                const hasUrlContext = FormatConverter.hasGeminiUrlContextTool(bodyObj.tools);
                if (!hasUrlContext) {
                    bodyObj.tools.push({ urlContext: {} });
                    toolsToAdd.push("urlContext");
                }
            }

            if (config.forceCodeExecution || modelForceCodeExecution) {
                const hasCodeExecution = FormatConverter.hasGeminiCodeExecutionTool(bodyObj.tools);
                if (!hasCodeExecution) {
                    bodyObj.tools.push({ codeExecution: {} });
                    toolsToAdd.push("codeExecution");
                }
            }

            if (toolsToAdd.length > 0 && this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[Proxy] ⚠️ Forcing tools enabled, injecting: [${toolsToAdd.join(", ")}] (Google Native)`
                );
            }
        }

        this.formatConverter.ensureServerSideToolInvocations(bodyObj, "[Proxy]");

        if (req.method === "POST" && bodyObj && bodyObj.contents && !bodyObj.safetySettings) {
            bodyObj.safetySettings = this.formatConverter.getDefaultSafetySettings();
        }

        const isStream = cleanPath.includes("streamGenerateContent") || req.query.alt === "sse";

        return {
            cleanModelName,
            cleanPath,
            isStream,
            modelStreamingMode,
            requestBodyObj,
            responseTransform,
        };
    }
```

2. Create `_sendResponseChunk`:
```javascript
    /**
     * Send response chunk to client with transform and image processing
     */
    _sendResponseChunk(res, chunk, isFinished, responseTransform, isStream, meta) {
        if (responseTransform === "batchEmbedToEmbedContent" && chunk && typeof chunk === "object") {
            if (Array.isArray(chunk.embeddings) && chunk.embeddings.length > 0) {
                chunk = chunk.embeddings[0];
            }
        }

        if (isStream) {
            if (!res.headersSent) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders?.();
            }
            if (chunk) {
                const dataStr = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                res.write(dataStr);
            }
            if (isFinished) {
                res.end();
            }
        } else {
            if (isFinished && !res.headersSent) {
                const responseStatus = meta.status || 200;
                if (meta.headers) {
                    for (const [headerName, headerVal] of Object.entries(meta.headers)) {
                        if (
                            headerName.toLowerCase() !== "transfer-encoding" &&
                            headerName.toLowerCase() !== "content-encoding"
                        ) {
                            res.setHeader(headerName, headerVal);
                        }
                    }
                }
                const processedChunk = this._processImageInResponse(chunk);
                res.status(responseStatus).json(processedChunk);
            }
        }
    }
```

3. Refactor `handleGeminiRequest(req, res)` (single dispatch, no retry loop):
```javascript
    async handleGeminiRequest(req, res) {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const payload = this._buildProxyRequestPayload(req, requestId);
        const config = this.scheduler?.config || {};

        this.usageStatsService?.startRequest(requestId, {
            apiFormat: "gemini",
            clientIp: req.ip || (req.headers && req.headers["x-forwarded-for"]) || null,
            initialAccountName: null,
            initialAuthIndex: null,
            isStreaming: payload.isStream,
            method: req.method,
            model: payload.cleanModelName,
            path: req.path,
            requestCategory: "generation",
            streamMode: payload.isStream ? "real" : null,
        });

        let authIndex;
        try {
            authIndex = await this.scheduler.getNextAuthIndex(payload.cleanModelName);
            if (typeof this.scheduler.acquireInFlight === "function") {
                this.scheduler.acquireInFlight(authIndex);
            }
        } catch (err) {
            const statusCode = err.statusCode || 503;
            const statusText = err.statusText || (statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE");
            this.usageStatsService?.finishRequest(requestId, {
                errorMessage: err.message,
                finalAccountName: null,
                finalAuthIndex: null,
                outcome: "error",
                statusCode,
            });
            return res.status(statusCode).json({
                error: { code: statusCode, message: err.message, status: statusText },
            });
        }

        const accountName = this._getAccountName(authIndex);
        if (typeof this.usageStatsService?.updateRequest === "function") {
            this.usageStatsService.updateRequest(requestId, {
                initialAccountName: accountName,
                initialAuthIndex: authIndex,
            });
        }
        this.usageStatsService?.recordAttempt(requestId, authIndex, accountName);

        const requestAttemptId = `${requestId}_attempt_1_${Math.random().toString(36).substring(2, 8)}`;
        let isRequestCompleted = false;

        if (typeof res.on === "function") {
            res.on("close", () => {
                if (!isRequestCompleted && !res.writableEnded) {
                    const connection = this.connectionRegistry.getConnectionByAuth(authIndex);
                    if (connection) {
                        connection.send(
                            JSON.stringify({
                                event_type: "cancel_request",
                                request_attempt_id: requestAttemptId,
                                request_id: requestId,
                            })
                        );
                    }
                    this.connectionRegistry.removeMessageQueue(requestId, "client_disconnect");
                }
            });
        }

        let requestError = null;

        try {
            const requestBodyStr =
                req.method !== "GET" && payload.requestBodyObj ? JSON.stringify(payload.requestBodyObj) : undefined;

            const requestPayload = {
                action: "generateContent",
                body: requestBodyStr,
                headers: req.headers,
                isStream: payload.isStream,
                method: req.method,
                path: payload.cleanPath,
                query: req.query,
                requestAttemptId,
                requestId,
                responseTransform: payload.responseTransform,
                streamingMode: payload.isStream ? payload.modelStreamingMode || config.streamingMode || "real" : "fake",
            };

            if (typeof this.scheduler.recordUsage === "function" && payload.cleanModelName) {
                this.scheduler.recordUsage(authIndex, payload.cleanModelName);
            }

            await this.connectionRegistry.sendRequest(
                authIndex,
                requestPayload,
                (chunk, isFinished, isError, meta = {}) => {
                    if (isFinished || isError) {
                        isRequestCompleted = true;
                    }
                    if (isError) {
                        const responseStatus = meta.status || 500;
                        const statusText =
                            responseStatus === 429
                                ? "RESOURCE_EXHAUSTED"
                                : responseStatus === 400
                                  ? "INVALID_ARGUMENT"
                                  : responseStatus === 503
                                    ? "UNAVAILABLE"
                                    : "INTERNAL";

                        requestError = {
                            message: chunk || "Internal Error",
                            statusCode: responseStatus,
                            statusText,
                        };

                        if (!res.headersSent) {
                            res.status(responseStatus).json({
                                error: {
                                    code: responseStatus,
                                    message: chunk || "Internal Error",
                                    status: statusText,
                                },
                            });
                        } else if (payload.isStream) {
                            res.write(
                                `data: ${JSON.stringify({
                                    error: {
                                        code: responseStatus,
                                        message: chunk || "Internal Error",
                                        status: statusText,
                                    },
                                })}\n\n`
                            );
                            res.end();
                        }
                        return;
                    }

                    this._sendResponseChunk(res, chunk, isFinished, payload.responseTransform, payload.isStream, meta);
                }
            );

            isRequestCompleted = true;

            if (requestError) {
                if (typeof this.scheduler.recordFailure === "function") {
                    this.scheduler.recordFailure(authIndex, requestError.statusCode);
                }
            } else {
                if (typeof this.scheduler.recordSuccess === "function") {
                    this.scheduler.recordSuccess(authIndex);
                }
            }
        } catch (error) {
            isRequestCompleted = true;
            if (typeof this.scheduler.recordFailure === "function") {
                this.scheduler.recordFailure(authIndex, 500);
            }
            requestError = { message: error.message, statusCode: 500, statusText: "INTERNAL" };
            if (!res.headersSent) {
                res.status(500).json({
                    error: { code: 500, message: error.message, status: "INTERNAL" },
                });
            }
        } finally {
            if (typeof this.scheduler.releaseInFlight === "function") {
                this.scheduler.releaseInFlight(authIndex);
            }
            if (typeof this.scheduler.checkAndRetireAccount === "function" && authIndex !== undefined) {
                this.scheduler.checkAndRetireAccount(authIndex).catch(() => {});
            }

            this.usageStatsService?.finishRequest(requestId, {
                errorMessage: requestError ? requestError.message : null,
                finalAccountName: accountName,
                finalAuthIndex: authIndex,
                outcome: requestError ? "error" : "success",
                statusCode: requestError ? requestError.statusCode || 500 : 200,
            });
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
git commit -m "refactor(concurrent): modularize handleGeminiRequest and remove retry loop"
```
