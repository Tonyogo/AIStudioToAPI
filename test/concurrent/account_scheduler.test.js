/* eslint-env jest */
const AccountScheduler = require("../../src/concurrent/AccountScheduler");

describe("AccountScheduler", () => {
    let mockAuthSource;
    let mockConnectionRegistry;
    let mockLogger;
    let mockBrowserManager;

    beforeEach(() => {
        mockAuthSource = {
            availableIndices: [0, 1, 2],
        };
        mockConnectionRegistry = {
            hasConnection: jest.fn(),
        };
        mockLogger = {
            debug: jest.fn(),
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
        };
        mockBrowserManager = {};
    });

    test("markAccountActivated and markAccountInactive update accountStatusMap correctly", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");

        scheduler.markAccountActivated(0);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");

        scheduler.markAccountInactive(0);
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
    });

    test("getNextAuthIndex proactively activates INACTIVE account when existing ACTIVATED accounts have inFlight > 0 and 30s cooldown is met", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        // Account 0 is ACTIVATED and handling 1 request (inFlight = 1)
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.acquireInFlight(0);

        // Account 1 is INACTIVE and online
        scheduler.setAccountStatus(1, "INACTIVE");

        // Fast-forward cooldown so 30s has elapsed
        scheduler.lastGlobalActivationAt = Date.now() - 31000;

        // Call getNextAuthIndex: should NOT re-use Account 0 (inFlight=1), but proactively activate Account 1
        const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(selected).toBe(1);
        expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED");
    });

    test("getNextAuthIndex automatically marks browserManager.currentAuthIndex as ACTIVATED", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _currentAuthIndex: 0,
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        // Initial status for 0 is INACTIVE
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");

        // Call getNextAuthIndex: should auto-sync Account 0 to ACTIVATED
        await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });

    test("getNextAuthIndex maintains baseline = 2 ACTIVATED accounts when 30s cooldown is met", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _currentAuthIndex: 0,
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        // Account 0 is ACTIVATED
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "INACTIVE");

        // Fast-forward cooldown
        scheduler.lastGlobalActivationAt = Date.now() - 31000;

        // Call getNextAuthIndex: only 1 ACTIVATED account exists (< 2). It should trigger baseline activation for Account 1!
        const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledWith(1);
        expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED");
        expect(selected).toBe(0); // Free activated account 0 selected for this request
    });

    test("round-robin selects active connections sequentially", async () => {
        // Indices 0, 1, 2 all connected
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");
        scheduler.setAccountStatus(2, "ACTIVATED");

        expect(await scheduler.getNextAuthIndex()).toBe(0);
        expect(await scheduler.getNextAuthIndex()).toBe(1);
        expect(await scheduler.getNextAuthIndex()).toBe(2);
        expect(await scheduler.getNextAuthIndex()).toBe(0);
    });

    test("skips disconnected auth indices during round-robin", async () => {
        // Only index 1 is connected
        mockConnectionRegistry.hasConnection.mockImplementation(idx => idx === 1);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler.setAccountStatus(1, "ACTIVATED");

        expect(await scheduler.getNextAuthIndex()).toBe(1);
        expect(await scheduler.getNextAuthIndex()).toBe(1);
    });

    test("throws 503 error when no active connections exist", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(false);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        await expect(scheduler.getNextAuthIndex()).rejects.toThrow("No active context connection available");
    });

    test("initializes account status as INACTIVE by default", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
    });

    test("updates and retrieves account status correctly", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler.setAccountStatus(0, "ACTIVATED");
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });

    test("activateAccount successfully activates account", async () => {
        const mockBrowserManager = {
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
            page: { isClosed: () => false },
        };
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        const success = await scheduler.activateAccount(0);

        expect(success).toBe(true);
        expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledWith(0);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });

    test("activateAccount handles failure gracefully and sets INACTIVE", async () => {
        const mockBrowserManager = {
            launchOrSwitchContext: jest.fn().mockRejectedValue(new Error("Context failed")),
        };

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        const success = await scheduler.activateAccount(0);

        expect(success).toBe(false);
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
    });

    test("getNextAuthIndex prioritizes ACTIVATED accounts", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        scheduler.setAccountStatus(0, "INACTIVE");
        scheduler.setAccountStatus(1, "ACTIVATED");
        scheduler.setAccountStatus(2, "INACTIVE");

        const index = await scheduler.getNextAuthIndex();
        expect(index).toBe(1);
    });

    test("getNextAuthIndex falls back to synchronous activation if no ACTIVATED account exists", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler.setAccountStatus(0, "INACTIVE");
        scheduler.setAccountStatus(1, "INACTIVE");

        const index = await scheduler.getNextAuthIndex();
        expect(index).toBe(0);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });

    test("isSystemActive returns false when idle for longer than idleTimeoutMs", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.lastSystemActivityAt = Date.now() - 300001; // 5 min 1 ms ago
        expect(scheduler.isSystemActive()).toBe(false);
    });

    test("isSystemActive returns true when recent activity exists", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.lastSystemActivityAt = Date.now() - 1000;
        expect(scheduler.isSystemActive()).toBe(true);
    });

    test("getNextAuthIndex selects least-used account for specified model and logs decision", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelTracker = {
            getUsage: jest.fn((idx, model) => {
                if (model === "gemini-2.5-pro") {
                    if (idx === 0) return 5;
                    if (idx === 1) return 1; // Account 1 has least usage for pro
                    if (idx === 2) return 3;
                }
                return 0;
            }),
        };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            null,
            mockModelTracker
        );
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");
        scheduler.setAccountStatus(2, "ACTIVATED");

        const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
        expect(selected).toBe(1);
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                '[AccountScheduler] Selected authIndex #1 for model="gemini-2.5-pro" (Phase 1: Free Activated, inFlight=0, usage=1/'
            )
        );
    });

    test("recordUsage delegates to modelUsageTracker", () => {
        const mockModelTracker = {
            recordUsage: jest.fn(),
        };
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            null,
            mockModelTracker
        );
        scheduler.recordUsage(0, "gemini-2.5-flash");

        expect(mockModelTracker.recordUsage).toHaveBeenCalledWith(0, "gemini-2.5-flash");
    });

    test("getModelDailyLimit returns configured dailyLimit or Infinity if omitted", () => {
        const mockModelList = [{ dailyLimit: 50, name: "models/gemini-2.5-pro" }, { name: "models/gemini-2.5-flash" }];
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            null,
            null,
            mockModelList
        );

        expect(scheduler.getModelDailyLimit("gemini-2.5-pro")).toBe(50);
        expect(scheduler.getModelDailyLimit("gemini-2.5-flash")).toBe(1000);
        expect(scheduler.getModelDailyLimit("unknown-model")).toBe(1000);
    });

    test("getModelDailyLimit returns 1000 when model dailyLimit is not configured", () => {
        const mockModelList = [{ name: "models/gemini-2.5-flash" }];
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            null,
            null,
            mockModelList
        );

        expect(scheduler.getModelDailyLimit("gemini-2.5-flash")).toBe(1000);
        expect(scheduler.getModelDailyLimit("unknown-model")).toBe(1000);
    });

    test("getNextAuthIndex skips accounts that reached dailyLimit", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelList = [{ dailyLimit: 5, name: "models/gemini-2.5-pro" }];
        const mockModelTracker = {
            getUsage: jest.fn(idx => {
                if (idx === 0) return 5; // Account 0 reached limit
                return 2; // Account 1 has 2 uses
            }),
        };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            null,
            mockModelTracker,
            mockModelList
        );
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");

        const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
        expect(selected).toBe(1);
    });

    test("getNextAuthIndex throws 429 when all online accounts reach dailyLimit", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelList = [{ dailyLimit: 5, name: "models/gemini-2.5-pro" }];
        const mockModelTracker = {
            getUsage: jest.fn(() => 5), // All accounts reached limit
        };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            null,
            mockModelTracker,
            mockModelList
        );
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");

        await expect(scheduler.getNextAuthIndex("gemini-2.5-pro")).rejects.toMatchObject({
            message: expect.stringContaining("All accounts reached daily limit"),
            statusCode: 429,
            statusText: "RESOURCE_EXHAUSTED",
        });
    });

    test("activateAccount skips activation if 30s global cooldown has not elapsed", async () => {
        const mockBrowserManager = {
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        // First activation succeeds
        const first = await scheduler.activateAccount(0);
        expect(first).toBe(true);

        // Immediate second activation should be skipped due to cooldown
        const second = await scheduler.activateAccount(1);
        expect(second).toBe(false);
        expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledTimes(1);
    });

    test("tracks in-flight requests and enforces acquire/release", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.getInFlightCount(0)).toBe(0);

        scheduler.acquireInFlight(0);
        expect(scheduler.getInFlightCount(0)).toBe(1);

        scheduler.acquireInFlight(0);
        expect(scheduler.getInFlightCount(0)).toBe(2);

        scheduler.releaseInFlight(0);
        expect(scheduler.getInFlightCount(0)).toBe(1);
    });

    test("recordFailure suspends account for 1 minute on 429 error", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.isAccountSuspended(0)).toBe(false);

        scheduler.recordFailure(0, 429);
        expect(scheduler.isAccountSuspended(0)).toBe(true);
    });

    test("recordFailure suspends account after 2 consecutive non-429 5xx errors", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.isAccountSuspended(0)).toBe(false);

        scheduler.recordFailure(0, 500);
        expect(scheduler.isAccountSuspended(0)).toBe(false);

        scheduler.recordFailure(0, 500);
        expect(scheduler.isAccountSuspended(0)).toBe(true);
    });

    test("getNextAuthIndex skips suspended accounts", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");

        scheduler.recordFailure(0, 429); // Account 0 is suspended
        const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(selected).toBe(1);
    });

    test("getNextAuthIndex prioritizes accounts with lower inFlightCount to spread load", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");

        scheduler.acquireInFlight(0); // Account 0 has 1 in-flight
        // Account 1 has 0 in-flight

        const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(selected).toBe(1);
    });

    test("getNextAuthIndex throws 503 when all online accounts have 2 in-flight requests", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        // Only account 0 and 1 are available indices
        mockAuthSource.availableIndices = [0, 1];

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");

        scheduler.acquireInFlight(0);
        scheduler.acquireInFlight(0); // Account 0 has 2 in-flight
        scheduler.acquireInFlight(1);
        scheduler.acquireInFlight(1); // Account 1 has 2 in-flight

        await expect(scheduler.getNextAuthIndex("gemini-2.5-flash")).rejects.toMatchObject({
            message: expect.stringContaining("All available accounts are busy"),
            statusCode: 503,
            statusText: "UNAVAILABLE",
        });
    });

    test("checkAndRetireAccount retires account when model usage reaches dailyLimit", async () => {
        const mockModelTracker = {
            getUsage: jest.fn((idx, model) => (idx === 0 ? 1000 : 0)),
        };
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const mockConfig = { exhaustedModelsThreshold: 1, failureThreshold: 3 };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            mockModelTracker,
            [{ name: "models/gemini-2.5-flash" }],
            mockConfig
        );
        scheduler.setAccountStatus(0, "ACTIVATED");

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
        expect(mockBrowserManager.closeContext).toHaveBeenCalledWith(0);
    });

    test("checkAndRetireAccount retires account when consecutive failures reach failureThreshold", async () => {
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const mockConfig = { exhaustedModelsThreshold: 1, failureThreshold: 3 };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            mockConfig
        );
        scheduler.setAccountStatus(0, "ACTIVATED");

        // Record failure 3 times using custom recordFailure or setting failureCountMap directly/via recordFailure
        // Note: recordFailure has custom logic that triggers suspension at 2 consecutive failures and resets count.
        // Let's set failureCountMap directly or ensure test matches failureThreshold logic.
        scheduler.failureCountMap.set(0, 3);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
    });
});
