/**
 * File: ConcurrentRequestHandler.js
 * Description: Minimal and high-performance Gemini API request handler for concurrent execution
 */

class ConcurrentRequestHandler {
    /**
     * @param {Object} connectionRegistry - ConnectionRegistry instance
     * @param {Object} scheduler - AccountScheduler instance
     * @param {Object} [logger] - Logger instance
     * @param {Array} [modelList] - Model list from configuration
     */
    constructor(connectionRegistry, scheduler, logger = console, modelList = [], usageStatsService = null) {
        this.connectionRegistry = connectionRegistry;
        this.scheduler = scheduler;
        this.logger = logger;
        this.modelList = modelList;
        this.usageStatsService = usageStatsService;

        if (this.connectionRegistry && typeof this.connectionRegistry.sendRequest !== "function") {
            this.connectionRegistry.sendRequest = this._sendRequestImpl.bind(this);
        }
    }

    /**
     * Internal implementation of sendRequest that integrates with ConnectionRegistry and MessageQueue
     * @param {number} authIndex
     * @param {Object} requestPayload
     * @param {Function} callback
     */
    async _sendRequestImpl(authIndex, requestPayload, callback) {
        const connection = this.connectionRegistry.getConnectionByAuth(authIndex);
        if (!connection) {
            const error = new Error(`No WebSocket connection found for authIndex=${authIndex}`);
            error.statusCode = 503;
            throw error;
        }

        const requestId =
            requestPayload.requestId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const requestAttemptId =
            requestPayload.requestAttemptId || `${requestId}_attempt_1_${Math.random().toString(36).substring(2, 8)}`;

        const messageQueue = this.connectionRegistry.createMessageQueue(requestId, authIndex, requestAttemptId);

        try {
            const payload = {
                body: requestPayload.body,
                event_type: "proxy_request",
                headers: requestPayload.headers || {},
                is_generative:
                    requestPayload.method === "POST" &&
                    (requestPayload.path.includes("generateContent") ||
                        requestPayload.path.includes("streamGenerateContent")),
                method: requestPayload.method || "POST",
                path: requestPayload.path,
                query_params: requestPayload.query || {},
                request_attempt_id: requestAttemptId,
                request_attempt_number: 1,
                request_id: requestId,
                streaming_mode: requestPayload.isStream ? "real" : "fake",
            };

            connection.send(JSON.stringify(payload));

            let isFinished = false;
            let fullResponseBody = "";
            let responseStatus = 200;
            let responseHeaders = {};

            while (!isFinished) {
                const message = await messageQueue.dequeue();

                if (message.type === "STREAM_END") {
                    isFinished = true;
                    const responseMeta = { headers: responseHeaders, status: responseStatus };
                    if (requestPayload.isStream) {
                        callback(null, true, false, responseMeta);
                    } else {
                        try {
                            const parsedBody = JSON.parse(fullResponseBody);
                            callback(parsedBody, true, false, responseMeta);
                        } catch (e) {
                            callback(fullResponseBody, true, false, responseMeta);
                        }
                    }
                } else if (message.event_type === "error") {
                    isFinished = true;
                    const errStatus = message.status || 500;
                    const responseMeta = { headers: responseHeaders, status: errStatus };
                    callback(message.message || "Request failed", true, true, responseMeta);
                    break;
                } else if (message.event_type === "response_headers") {
                    if (message.status) {
                        responseStatus = Number(message.status);
                    }
                    if (message.headers) {
                        responseHeaders = message.headers;
                    }
                    if (this.logger && typeof this.logger.debug === "function") {
                        this.logger.debug(`[ConcurrentRequestHandler] Received response headers for ${requestId}`);
                    }
                } else {
                    const data = message.data || "";
                    const responseMeta = { headers: responseHeaders, status: responseStatus };
                    if (requestPayload.isStream) {
                        callback(data, false, false, responseMeta);
                    } else {
                        fullResponseBody += data;
                    }
                }
            }
        } catch (error) {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[ConcurrentRequestHandler] WebSocket queue error: ${error.message}`);
            }
            callback(error.message, true, true);
        } finally {
            this.connectionRegistry.removeMessageQueue(requestId, "request_complete");
        }
    }

    /**
     * Register Express routes for native Gemini API endpoints
     * @param {Object} app - Express application instance
     */
    registerRoutes(app) {
        // Models list endpoint
        app.get(["/v1beta/models", "/v1/models"], (req, res) => {
            if (req.path.startsWith("/v1/models")) {
                const models = this.modelList.map(model => ({
                    context_window: model.inputTokenLimit,
                    created: Math.floor(Date.now() / 1000),
                    id: model.name.replace("models/", ""),
                    max_tokens: model.outputTokenLimit,
                    object: "model",
                    owned_by: "google",
                }));
                return res.status(200).json({ data: models, object: "list" });
            }
            return res.status(200).json({ models: this.modelList });
        });

        // Gemini API POST endpoints
        app.post("/v1beta/models/*", (req, res) => {
            this.handleGeminiRequest(req, res);
        });

        app.post("/v1/models/*", (req, res) => {
            this.handleGeminiRequest(req, res);
        });
    }

    /**
     * Extract clean model name from request path
     * @param {string} pathStr
     * @returns {string|null}
     */
    _extractCleanModelName(pathStr) {
        if (typeof pathStr !== "string") return null;
        const match = pathStr.match(/\/models\/([^:/?]+)(?::|$)/);
        if (!match) return null;
        const rawModel = match[1];
        const FormatConverter = require("../core/FormatConverter");
        const { cleanModelName: toolStripped } = FormatConverter.parseModelBuiltInToolSuffixes(rawModel);
        const { cleanModelName: streamStripped } = FormatConverter.parseModelStreamingModeSuffix(toolStripped);
        const { cleanModelName } = FormatConverter.parseModelThinkingLevel(streamStripped);
        return cleanModelName;
    }

    /**
     * Get account name for a given authIndex
     * @param {number} authIndex
     * @returns {string|null}
     */
    _getAccountName(authIndex) {
        if (!Number.isInteger(authIndex) || authIndex < 0) return null;
        return this.scheduler?.authSource?.accountNameMap?.get(authIndex) || null;
    }

    /**
     * Process image in response, converting inlineData to Markdown Data URL if present
     * @param {Object} chunk
     * @returns {Object}
     */
    _processImageInResponse(chunk) {
        if (!chunk || typeof chunk !== "object") return chunk;
        try {
            const candidate = chunk.candidates?.[0];
            if (candidate?.content?.parts) {
                const imagePartIndex = candidate.content.parts.findIndex(p => p && p.inlineData);
                if (imagePartIndex > -1) {
                    const imagePart = candidate.content.parts[imagePartIndex];
                    const image = imagePart.inlineData;
                    candidate.content.parts[imagePartIndex] = {
                        text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
                    };
                }
            }
        } catch (e) {
            if (this.logger && typeof this.logger.warn === "function") {
                this.logger.warn(`[ConcurrentRequestHandler] Image process error: ${e.message}`);
            }
        }
        return chunk;
    }

    /**
     * Process native Gemini API request
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleGeminiRequest(req, res) {
        const FormatConverter = require("../core/FormatConverter");
        const match = typeof req.path === "string" ? req.path.match(/\/models\/([^:/?]+)(?::|$)/) : null;
        const rawModel = match ? match[1] : req.path;
        const { cleanModelName: toolStripped } = FormatConverter.parseModelBuiltInToolSuffixes(rawModel);
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

        const maxAttempts = 2;
        let attempt = 0;
        let lastError = null;
        let successfulAuthIndex = null;
        let lastAttemptAuthIndex = null;

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const isStream = req.path.includes("streamGenerateContent") || req.query.alt === "sse";

        this.usageStatsService?.startRequest(requestId, {
            apiFormat: "gemini",
            clientIp: req.ip || (req.headers && req.headers["x-forwarded-for"]) || null,
            initialAccountName: null,
            initialAuthIndex: null,
            isStreaming: isStream,
            method: req.method,
            model: cleanModelName,
            path: req.path,
            requestCategory: "generation",
            streamMode: isStream ? "real" : null,
        });

        while (attempt < maxAttempts) {
            attempt++;
            let authIndex;
            try {
                authIndex = await this.scheduler.getNextAuthIndex(cleanModelName);
                lastAttemptAuthIndex = authIndex;
                if (typeof this.scheduler.acquireInFlight === "function") {
                    this.scheduler.acquireInFlight(authIndex);
                }
            } catch (err) {
                lastError = err;
                break;
            }

            const accountName = this._getAccountName(authIndex);
            if (attempt === 1 && typeof this.usageStatsService?.updateRequest === "function") {
                this.usageStatsService.updateRequest(requestId, {
                    initialAccountName: accountName,
                    initialAuthIndex: authIndex,
                });
            }

            this.usageStatsService?.recordAttempt(requestId, authIndex, accountName);

            const requestAttemptId = `${requestId}_attempt_${attempt}_${Math.random().toString(36).substring(2, 8)}`;
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

            try {
                const requestBodyStr = req.method !== "GET" ? JSON.stringify(req.body) : undefined;

                const requestPayload = {
                    action: "generateContent",
                    body: requestBodyStr,
                    headers: req.headers,
                    isStream,
                    method: req.method,
                    path: req.path,
                    query: req.query,
                    requestAttemptId,
                    requestId,
                };

                if (typeof this.scheduler.recordUsage === "function" && cleanModelName) {
                    this.scheduler.recordUsage(authIndex, cleanModelName);
                }

                let attemptError = null;

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

                            attemptError = {
                                message: chunk || "Internal Error",
                                statusCode: responseStatus,
                                statusText,
                            };

                            if (!res.headersSent) {
                                if (attempt >= maxAttempts || attemptError.statusCode === 429) {
                                    res.status(responseStatus).json({
                                        error: {
                                            code: responseStatus,
                                            message: chunk || "Internal Error",
                                            status: statusText,
                                        },
                                    });
                                }
                            } else if (isStream) {
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
                );

                isRequestCompleted = true;

                if (attemptError) {
                    if (typeof this.scheduler.recordFailure === "function") {
                        this.scheduler.recordFailure(authIndex, attemptError.statusCode);
                    }
                    lastError = attemptError;
                    if (res.headersSent || attemptError.statusCode === 429) {
                        break;
                    }
                } else {
                    if (typeof this.scheduler.recordSuccess === "function") {
                        this.scheduler.recordSuccess(authIndex);
                    }
                    successfulAuthIndex = authIndex;
                    lastError = null;
                    break;
                }
            } catch (error) {
                isRequestCompleted = true;
                if (typeof this.scheduler.recordFailure === "function") {
                    this.scheduler.recordFailure(authIndex, 500);
                }
                lastError = { message: error.message, statusCode: 500, statusText: "INTERNAL" };
                if (res.headersSent) {
                    break;
                }
            } finally {
                if (typeof this.scheduler.releaseInFlight === "function") {
                    this.scheduler.releaseInFlight(authIndex);
                }
                if (typeof this.scheduler.checkAndRetireAccount === "function" && authIndex !== undefined) {
                    this.scheduler.checkAndRetireAccount(authIndex).catch(() => {});
                }
            }
        }

        if (lastError && !res.headersSent) {
            const statusCode = lastError.statusCode || 503;
            const statusText = lastError.statusText || (statusCode === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE");
            res.status(statusCode).json({
                error: { code: statusCode, message: lastError.message, status: statusText },
            });
        }

        const finalAuthIndex =
            successfulAuthIndex !== null ? successfulAuthIndex : lastError ? lastAttemptAuthIndex : null;
        const finalAccountName = finalAuthIndex !== null ? this._getAccountName(finalAuthIndex) : null;

        this.usageStatsService?.finishRequest(requestId, {
            errorMessage: lastError ? lastError.message : null,
            finalAccountName,
            finalAuthIndex,
            outcome: lastError ? "error" : "success",
            statusCode: lastError ? lastError.statusCode || 500 : 200,
        });
    }
}

module.exports = ConcurrentRequestHandler;
