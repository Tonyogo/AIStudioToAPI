/**
 * File: ConcurrentRequestHandler.js
 * Description: Minimal and high-performance Gemini API request handler for concurrent execution
 */

class ConcurrentRequestHandler {
    /**
     * @param {Object} connectionRegistry - ConnectionRegistry instance
     * @param {Object} scheduler - AccountScheduler instance
     * @param {Object} [formatConverter] - FormatConverter instance
     * @param {Object} [logger] - Logger instance
     * @param {Array} [modelList] - Model list from configuration
     */
    constructor(connectionRegistry, scheduler, formatConverter, logger = console, modelList = []) {
        this.connectionRegistry = connectionRegistry;
        this.scheduler = scheduler;
        this.formatConverter = formatConverter;
        this.logger = logger;
        this.modelList = modelList;

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

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const requestAttemptId = `${requestId}_attempt_1_${Math.random().toString(36).substring(2, 8)}`;

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

            while (!isFinished) {
                const message = await messageQueue.dequeue();

                if (message.type === "STREAM_END") {
                    isFinished = true;
                    if (requestPayload.isStream) {
                        callback(null, true, false);
                    } else {
                        try {
                            const parsedBody = JSON.parse(fullResponseBody);
                            callback(parsedBody, true, false);
                        } catch (e) {
                            callback(fullResponseBody, true, false);
                        }
                    }
                } else if (message.event_type === "error") {
                    isFinished = true;
                    callback(message.message || "Request failed", true, true);
                } else if (message.event_type === "response_headers") {
                    if (this.logger && typeof this.logger.debug === "function") {
                        this.logger.debug(`[ConcurrentRequestHandler] Received response headers for ${requestId}`);
                    }
                } else {
                    const data = message.data || "";
                    if (requestPayload.isStream) {
                        callback(data, false, false);
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
     * Process native Gemini API request
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleGeminiRequest(req, res) {
        let authIndex;
        try {
            authIndex = this.scheduler.getNextAuthIndex();
        } catch (err) {
            const statusCode = err.statusCode || 503;
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[ConcurrentRequestHandler] Scheduling failed: ${err.message}`);
            }
            return res.status(statusCode).json({
                error: {
                    code: statusCode,
                    message: err.message,
                    status: "UNAVAILABLE",
                },
            });
        }

        try {
            const isStream = req.path.includes("streamGenerateContent") || req.query.alt === "sse";
            const requestBodyStr = req.method !== "GET" ? JSON.stringify(req.body) : undefined;

            const requestPayload = {
                action: "generateContent",
                body: requestBodyStr,
                headers: req.headers,
                isStream,
                method: req.method,
                path: req.path,
                query: req.query,
            };

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[ConcurrentRequestHandler] Forwarding request (${req.path}) to authIndex #${authIndex}`
                );
            }

            if (isStream) {
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders?.();
            }

            await this.connectionRegistry.sendRequest(authIndex, requestPayload, (chunk, isFinished, isError) => {
                if (isError) {
                    if (!res.headersSent) {
                        res.status(500).json({
                            error: { code: 500, message: chunk || "Internal Error", status: "INTERNAL" },
                        });
                    } else if (isStream) {
                        res.write(`data: ${JSON.stringify({ error: chunk })}\n\n`);
                        res.end();
                    }
                    return;
                }

                if (isStream) {
                    if (chunk) {
                        const dataStr = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                        res.write(`data: ${dataStr}\n\n`);
                    }
                    if (isFinished) {
                        res.end();
                    }
                } else {
                    if (isFinished && !res.headersSent) {
                        res.status(200).json(chunk);
                    }
                }
            });
        } catch (error) {
            if (this.logger && typeof this.logger.error === "function") {
                this.logger.error(`[ConcurrentRequestHandler] Request processing error: ${error.message}`);
            }
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        code: 500,
                        message: error.message,
                        status: "INTERNAL",
                    },
                });
            }
        }
    }
}

module.exports = ConcurrentRequestHandler;
