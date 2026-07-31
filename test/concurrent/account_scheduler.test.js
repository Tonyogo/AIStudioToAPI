/* eslint-env jest */
const AccountScheduler = require("../../src/concurrent/AccountScheduler");

describe("AccountScheduler", () => {
    let mockAuthSource;
    let mockConnectionRegistry;
    let mockLogger;

    beforeEach(() => {
        mockAuthSource = {
            getAllAccounts: jest.fn().mockReturnValue([{ index: 0 }, { index: 1 }, { index: 2 }]),
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
    });

    test("round-robin selects active connections sequentially", () => {
        // Indices 0, 1, 2 all connected
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        expect(scheduler.getNextAuthIndex()).toBe(0);
        expect(scheduler.getNextAuthIndex()).toBe(1);
        expect(scheduler.getNextAuthIndex()).toBe(2);
        expect(scheduler.getNextAuthIndex()).toBe(0);
    });

    test("skips disconnected auth indices during round-robin", () => {
        // Only index 1 is connected
        mockConnectionRegistry.hasConnection.mockImplementation(idx => idx === 1);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        expect(scheduler.getNextAuthIndex()).toBe(1);
        expect(scheduler.getNextAuthIndex()).toBe(1);
    });

    test("throws 503 error when no active connections exist", () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(false);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        expect(() => scheduler.getNextAuthIndex()).toThrow("No active context connection available");
    });
});
