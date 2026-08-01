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

    test("round-robin selects active connections sequentially", () => {
        // Indices 0, 1, 2 all connected
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        expect(scheduler.getNextAuthIndex()).toBe(0);
        expect(scheduler.getNextAuthIndex()).toBe(1);
        expect(scheduler.getNextAuthIndex()).toBe(2);
        expect(scheduler.getNextAuthIndex()).toBe(0);
    });

    test("skips disconnected auth indices during round-robin", () => {
        // Only index 1 is connected
        mockConnectionRegistry.hasConnection.mockImplementation(idx => idx === 1);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        expect(scheduler.getNextAuthIndex()).toBe(1);
        expect(scheduler.getNextAuthIndex()).toBe(1);
    });

    test("throws 503 error when no active connections exist", () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(false);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        expect(() => scheduler.getNextAuthIndex()).toThrow("No active context connection available");
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
});
