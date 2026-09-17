/* eslint-env jest */
const BrowserManager = require("../../src/core/BrowserManager");

describe("BrowserManager AuthStateTracker integration", () => {
    test("calls saveLastAuthIndex when _activateContext is executed", () => {
        const mockLogger = { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() };
        const mockConfig = { maxContexts: 1 };
        const mockAuthSource = { availableIndices: [0, 1], getRotationIndices: () => [0, 1] };
        const manager = new BrowserManager(mockLogger, mockConfig, mockAuthSource);

        const mockTracker = { saveLastAuthIndex: jest.fn() };
        manager.setAuthStateTracker(mockTracker);

        const mockContext = {};
        const mockPage = { isClosed: () => false };

        // Stub internal helper methods that interact with browser
        manager._startHealthMonitor = jest.fn();
        manager._startBackgroundWakeup = jest.fn();
        manager._sendActiveTrigger = jest.fn();

        manager._activateContext(mockContext, mockPage, 2);

        expect(manager.currentAuthIndex).toBe(2);
        expect(mockTracker.saveLastAuthIndex).toHaveBeenCalledWith(2);
    });

    test("handles saveLastAuthIndex errors gracefully without throwing", () => {
        const mockLogger = { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() };
        const mockConfig = { maxContexts: 1 };
        const mockAuthSource = { availableIndices: [0, 1], getRotationIndices: () => [0, 1] };
        const manager = new BrowserManager(mockLogger, mockConfig, mockAuthSource);

        const mockTracker = {
            saveLastAuthIndex: jest.fn().mockImplementation(() => {
                throw new Error("Disk full");
            }),
        };
        manager.setAuthStateTracker(mockTracker);

        const mockContext = {};
        const mockPage = { isClosed: () => false };

        manager._startHealthMonitor = jest.fn();
        manager._startBackgroundWakeup = jest.fn();
        manager._sendActiveTrigger = jest.fn();

        expect(() => {
            manager._activateContext(mockContext, mockPage, 3);
        }).not.toThrow();
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to persist auth state for account #3")
        );
    });
});
