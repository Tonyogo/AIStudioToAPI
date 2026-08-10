/**
 * File: ConcurrentRequestHandler.js
 * Description: Minimal and high-performance Gemini API request handler for concurrent execution
 */

const FormatConverter = require("../core/FormatConverter");

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

        const config = this.scheduler?.config || {};
        this.formatConverter = new FormatConverter(this.logger, { config });

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
                streaming_mode: requestPayload.isStream ? requestPayload.streamingMode || "real" : "fake",
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
     * Build normalized proxy request payload for native Gemini API requests
     * @param {Object} req - Express request object
     * @returns {Object} Payload metadata and normalized request body
     */
    _buildProxyRequestPayload(req) {
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

    /**
     * Process native Gemini API request
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleGeminiRequest(req, res) {
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const payload = this._buildProxyRequestPayload(req);
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
}

module.exports = ConcurrentRequestHandler;
