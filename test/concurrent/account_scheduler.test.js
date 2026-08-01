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
});
