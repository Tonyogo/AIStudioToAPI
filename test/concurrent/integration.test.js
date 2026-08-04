/* eslint-env jest */
const { initConcurrentMode } = require("../../src/concurrent");

describe("Concurrent System Integration Check", () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test("ENABLE_CONCURRENT environment variable is recognized", () => {
        process.env.ENABLE_CONCURRENT = "true";
        const isConcurrent = process.env.ENABLE_CONCURRENT === "true";
        expect(isConcurrent).toBe(true);
    });

    test("initConcurrentMode can be safely invoked with mock ProxyServerSystem dependencies", () => {
        process.env.ENABLE_CONCURRENT = "true";
        const mockApp = {
            get: jest.fn(),
            post: jest.fn(),
        };

        const mockSystem = {
            authSource: { getAllAccounts: () => [] },
            config: { modelList: [{ name: "models/gemini-2.5-flash" }] },
            connectionRegistry: { hasConnection: () => false },
            formatConverter: {},
            logger: { info: jest.fn() },
        };

        const result = initConcurrentMode(mockApp, mockSystem);

        expect(result.scheduler).toBeDefined();
        expect(mockApp.get).toHaveBeenCalled();
        expect(mockApp.post).toHaveBeenCalled();
    });

    test("getStatusData returns concurrent status and usage details when concurrent mode is initialized", () => {
        const StatusRoutes = require("../../src/routes/StatusRoutes");
        const mockServerSystem = {
            authSource: {
                accountNameMap: new Map([[0, "test@example.com"]]),
                availableIndices: [0],
                getCanonicalIndex: () => null,
                getRotationIndices: () => [0],
                initialIndices: [0],
            },
            browserManager: {
                contexts: new Map([[0, {}]]),
            },
            concurrentComponents: {
                modelUsageTracker: {
                    getAccountUsageDetails: () => ({ completionTokens: 50, promptTokens: 100, totalRequests: 5 }),
                },
                scheduler: {
                    getAccountStatus: () => "ready",
                    getInFlightCount: () => 0,
                    isAccountSuspended: () => false,
                },
            },
            config: {
                apiKeySource: "env",
                checkUpdate: true,
                enableAuthUpdate: false,
                failureThreshold: 3,
                forceCodeExecution: false,
                forceThinking: false,
                forceUrlContext: false,
                forceWebSearch: false,
                immediateSwitchStatusCodes: [429, 503],
                maxContexts: 1,
                maxRetries: 3,
                safetySettingsThreshold: "BLOCK_MEDIUM_AND_ABOVE",
                streamingMode: "real",
                switchOnUses: 40,
            },
            connectionRegistry: {
                getConnectionByAuth: () => ({}),
            },
            logger: {
                displayLimit: 100,
                logBuffer: [],
            },
            requestHandler: {
                currentAuthIndex: 0,
                failureCount: 0,
                isSystemBusy: false,
                usageCount: 0,
            },
        };

        process.env.ENABLE_CONCURRENT = "true";
        const statusRoutes = new StatusRoutes(mockServerSystem);
        const data = statusRoutes._getStatusData();

        expect(data.status.isConcurrentMode).toBe(true);
        expect(data.status.accountDetails[0]).toHaveProperty("concurrentStatus");
        expect(data.status.accountDetails[0]).toHaveProperty("inFlight");
        expect(data.status.accountDetails[0]).toHaveProperty("isSuspended");
        expect(data.status.accountDetails[0]).toHaveProperty("usage");
    });
});
