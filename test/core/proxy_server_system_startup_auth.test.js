/* eslint-env jest */
const ProxyServerSystem = require("../../src/core/ProxyServerSystem");

describe("ProxyServerSystem startup auth index resolution", () => {
    let system;

    afterEach(() => {
        if (system?.staleQueueCleanupInterval) {
            clearInterval(system.staleQueueCleanupInterval);
        }
    });

    test("initializes authStateTracker and attaches it to browserManager", () => {
        system = new ProxyServerSystem();
        expect(system.authStateTracker).toBeDefined();
        expect(system.browserManager.authStateTracker).toBe(system.authStateTracker);
    });

    test("resolves startup order using authStateTracker with persisted index", async () => {
        system = new ProxyServerSystem();
        system._startHttpServer = jest.fn().mockResolvedValue();
        system._startWebSocketServer = jest.fn().mockResolvedValue();
        system.authSource.availableIndices = [0, 1, 2];
        system.authSource.getRotationIndices = () => [0, 1, 2];
        system.authSource.getCanonicalIndex = idx => idx;

        system.browserManager.preloadContextPool = jest.fn().mockResolvedValue({ firstReady: 2 });
        system.browserManager.launchOrSwitchContext = jest.fn().mockResolvedValue();

        jest.spyOn(system.authStateTracker, "getLastAuthIndex").mockReturnValue(2);

        await system.start(0); // Pass env initial index 0, but persisted 2 should take precedence

        expect(system.browserManager.preloadContextPool).toHaveBeenCalledWith([2, 0, 1], expect.any(Number));
        expect(system.browserManager.launchOrSwitchContext).toHaveBeenCalledWith(2);
    });

    test("resolves fallback when persisted index is unavailable", async () => {
        system = new ProxyServerSystem();
        system._startHttpServer = jest.fn().mockResolvedValue();
        system._startWebSocketServer = jest.fn().mockResolvedValue();
        system.authSource.availableIndices = [0, 2, 4];
        system.authSource.getRotationIndices = () => [0, 2, 4];
        system.authSource.getCanonicalIndex = idx => idx;

        system.browserManager.preloadContextPool = jest.fn().mockResolvedValue({ firstReady: 4 });
        system.browserManager.launchOrSwitchContext = jest.fn().mockResolvedValue();

        // Persisted was 3, but 3 is gone -> next candidate is 4
        jest.spyOn(system.authStateTracker, "getLastAuthIndex").mockReturnValue(3);

        await system.start(0);

        expect(system.browserManager.preloadContextPool).toHaveBeenCalledWith([4, 0, 2], expect.any(Number));
        expect(system.browserManager.launchOrSwitchContext).toHaveBeenCalledWith(4);
    });

    test("resolves env initial index when no persisted index exists", async () => {
        system = new ProxyServerSystem();
        system._startHttpServer = jest.fn().mockResolvedValue();
        system._startWebSocketServer = jest.fn().mockResolvedValue();
        system.authSource.availableIndices = [0, 1, 2];
        system.authSource.getRotationIndices = () => [0, 1, 2];
        system.authSource.getCanonicalIndex = idx => idx;

        system.browserManager.preloadContextPool = jest.fn().mockResolvedValue({ firstReady: 1 });
        system.browserManager.launchOrSwitchContext = jest.fn().mockResolvedValue();

        jest.spyOn(system.authStateTracker, "getLastAuthIndex").mockReturnValue(null);

        await system.start(1);

        expect(system.browserManager.preloadContextPool).toHaveBeenCalledWith([1, 0, 2], expect.any(Number));
        expect(system.browserManager.launchOrSwitchContext).toHaveBeenCalledWith(1);
    });

    test("resolves default first index when neither persisted nor valid env exists", async () => {
        system = new ProxyServerSystem();
        system._startHttpServer = jest.fn().mockResolvedValue();
        system._startWebSocketServer = jest.fn().mockResolvedValue();
        system.authSource.availableIndices = [1, 2];
        system.authSource.getRotationIndices = () => [1, 2];
        system.authSource.getCanonicalIndex = idx => idx;

        system.browserManager.preloadContextPool = jest.fn().mockResolvedValue({ firstReady: 1 });
        system.browserManager.launchOrSwitchContext = jest.fn().mockResolvedValue();

        jest.spyOn(system.authStateTracker, "getLastAuthIndex").mockReturnValue(null);

        await system.start(null);

        expect(system.browserManager.preloadContextPool).toHaveBeenCalledWith([1, 2], expect.any(Number));
        expect(system.browserManager.launchOrSwitchContext).toHaveBeenCalledWith(1);
    });
});
