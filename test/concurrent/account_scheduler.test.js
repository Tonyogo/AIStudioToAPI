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
        expect(mockBrowserManager._sendActiveTrigger).toHaveBeenCalled();
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

    test("getNextAuthIndex selects least-used account for specified model", async () => {
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
        expect(scheduler.getModelDailyLimit("gemini-2.5-flash")).toBe(Infinity);
        expect(scheduler.getModelDailyLimit("unknown-model")).toBe(Infinity);
    });

    test("getNextAuthIndex skips accounts that reached dailyLimit", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelList = [{ name: "models/gemini-2.5-pro", dailyLimit: 5 }];
        const mockModelTracker = {
            getUsage: jest.fn((idx, model) => {
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
        const mockModelList = [{ name: "models/gemini-2.5-pro", dailyLimit: 5 }];
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
});
