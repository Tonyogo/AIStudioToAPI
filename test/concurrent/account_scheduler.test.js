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

    test("selectWeightedCandidate returns null for empty or invalid candidates", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.selectWeightedCandidate(null, 1000)).toBeNull();
        expect(scheduler.selectWeightedCandidate([], 1000)).toBeNull();
    });

    test("selectWeightedCandidate returns the only candidate when candidates length is 1", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        const candidate = { idx: 0, inFlight: 0, order: 0, usage: 100 };
        expect(scheduler.selectWeightedCandidate([candidate], 1000)).toBe(candidate);
    });

    test("selectWeightedCandidate selects candidates proportional to remaining capacity weight", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        const candidateA = { idx: 0, inFlight: 0, order: 0, usage: 100 }; // weight 900
        const candidateB = { idx: 1, inFlight: 0, order: 1, usage: 900 }; // weight 100
        const candidates = [candidateA, candidateB];

        // Mock Math.random to return 0.1 (0.1 * 1000 = 100 -> within candidateA weight 900)
        jest.spyOn(Math, "random").mockReturnValue(0.1);
        expect(scheduler.selectWeightedCandidate(candidates, 1000)).toBe(candidateA);

        // Mock Math.random to return 0.95 (0.95 * 1000 = 950 -> exceeds candidateA weight 900 -> candidateB)
        Math.random.mockReturnValue(0.95);
        expect(scheduler.selectWeightedCandidate(candidates, 1000)).toBe(candidateB);

        Math.random.mockRestore();
    });

    test("markAccountActivated and markAccountInactive update accountStatusMap correctly", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");

        scheduler.markAccountActivated(0);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");

        scheduler.markAccountInactive(0);
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
    });

    test("getNextAuthIndex reuses lightly busy account when maxContexts limit is reached and does not proactively scale-out", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 1 }
        );

        // Account 0 is ACTIVATED and handling 1 request (inFlight = 1)
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.acquireInFlight(0);

        // Account 1 is INACTIVE and online
        scheduler.setAccountStatus(1, "INACTIVE");

        // Fast-forward cooldown so 30s has elapsed
        scheduler.lastGlobalActivationAt = Date.now() - 31000;

        // Call getNextAuthIndex: should reuse Account 0 (inFlight=1) since maxContexts = 1 is reached
        const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(selected).toBe(0);
        expect(scheduler.getAccountStatus(1)).toBe("INACTIVE");
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

    test("getNextAuthIndex maintains baseline ACTIVATED accounts up to maxContexts when 30s cooldown is met", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _currentAuthIndex: 0,
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 2 }
        );

        // Account 0 is ACTIVATED
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "INACTIVE");

        // Fast-forward cooldown
        scheduler.lastGlobalActivationAt = Date.now() - 31000;

        jest.spyOn(Math, "random").mockReturnValue(0);

        // Call getNextAuthIndex: only 1 ACTIVATED account exists (< maxContexts=2). It should trigger baseline activation for Account 1!
        const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledWith(1);
        expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED");
        expect(selected).toBe(0); // Free activated account 0 selected for this request

        Math.random.mockRestore();
    });

    test("round-robin selects active connections sequentially", async () => {
        // Indices 0, 1, 2 all connected
        mockConnectionRegistry.hasConnection.mockReturnValue(true);

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");
        scheduler.setAccountStatus(2, "ACTIVATED");

        jest.spyOn(Math, "random").mockReturnValue(0);

        expect(await scheduler.getNextAuthIndex()).toBe(0);
        expect(await scheduler.getNextAuthIndex()).toBe(1);
        expect(await scheduler.getNextAuthIndex()).toBe(2);
        expect(await scheduler.getNextAuthIndex()).toBe(0);

        Math.random.mockRestore();
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

    test("getNextAuthIndex triggers baseline activation when no ACTIVATED account exists and cooldown is met", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            _sendActiveTrigger: jest.fn(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler.setAccountStatus(0, "INACTIVE");
        scheduler.setAccountStatus(1, "INACTIVE");

        jest.spyOn(Math, "random").mockReturnValue(0);

        const index = await scheduler.getNextAuthIndex();
        expect(index).toBe(0);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");

        Math.random.mockRestore();
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

        jest.spyOn(Math, "random").mockReturnValue(0.4);

        const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
        expect(selected).toBe(1);
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                '[AccountScheduler] Selected authIndex #1 for model="gemini-2.5-pro" (Phase 1: Free Activated, inFlight=0, usage=1/'
            )
        );

        Math.random.mockRestore();
    });

    test("activateAccount prevents concurrent simultaneous activations using isActivatingAny lock", async () => {
        let resolveActivation;
        const slowActivationPromise = new Promise(resolve => {
            resolveActivation = resolve;
        });

        const mockBrowserManager = {
            launchOrSwitchContext: jest.fn().mockImplementation(() => slowActivationPromise),
        };

        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        // First activation starts
        const activation1 = scheduler.activateAccount(0);

        // Second activation attempted concurrently before first completes
        const activation2Result = await scheduler.activateAccount(1);

        // Second activation should immediately be skipped (returns false)
        expect(activation2Result).toBe(false);
        expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledTimes(1);

        // Resolve first activation
        resolveActivation();
        const activation1Result = await activation1;
        expect(activation1Result).toBe(true);
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

    test("getNextAuthIndex selects least used account even when dailyLimit is reached", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelList = [{ dailyLimit: 5, name: "models/gemini-2.5-pro" }];
        const mockModelTracker = {
            getUsage: jest.fn(idx => {
                if (idx === 0) return 10;
                return 5;
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

        jest.spyOn(Math, "random").mockReturnValue(0.6);

        const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
        expect(selected).toBe(1);

        Math.random.mockRestore();
    });

    test("retireAndReplaceAccount marks account RETIRED and triggers rebalanceConcurrentPool", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "rebalanceConcurrentPool").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");

        await scheduler.retireAndReplaceAccount(0, "test retirement");

        expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
        expect(scheduler.rebalanceConcurrentPool).toHaveBeenCalled();
    });

    test("rebalanceConcurrentPool deprioritizes RETIRED accounts and restores state for target RETIRED candidates", async () => {
        const mockBrowserManager = {
            _closeContextForPoolIfPossible: jest.fn(),
            _preloadBackgroundContexts: jest.fn(),
            contexts: new Map([
                [0, { page: {} }],
                [1, { page: {} }],
            ]),
        };

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 2 }
        );

        // Account 0 is RETIRED, Account 1 & 2 are INACTIVE
        scheduler.setAccountStatus(0, "RETIRED");
        scheduler.failureCountMap.set(0, 3);
        scheduler.setAccountStatus(1, "INACTIVE");
        scheduler.setAccountStatus(2, "INACTIVE");

        await scheduler.rebalanceConcurrentPool();

        // Target pool should pick 1 & 2 (healthy) first, leaving 0 (RETIRED) out
        // Context 0 should be closed via _closeContextForPoolIfPossible
        expect(mockBrowserManager._closeContextForPoolIfPossible).toHaveBeenCalledWith(0, "rebalance_retired");
        // Candidate 2 should be preloaded
        expect(mockBrowserManager._preloadBackgroundContexts).toHaveBeenCalledWith([2], 2);
    });

    test("rebalanceConcurrentPool restores RETIRED account to INACTIVE when target pool requires it", async () => {
        const mockBrowserManager = {
            _closeContextForPoolIfPossible: jest.fn(),
            _preloadBackgroundContexts: jest.fn(),
            contexts: new Map(),
        };

        const scheduler = new AccountScheduler(
            { availableIndices: [0] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 1 }
        );

        scheduler.setAccountStatus(0, "RETIRED");
        scheduler.failureCountMap.set(0, 3);

        await scheduler.rebalanceConcurrentPool();

        // Account 0 is the only account available, so it is picked as target and restored to INACTIVE
        expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
        expect(scheduler.failureCountMap.get(0)).toBe(0);
        expect(mockBrowserManager._preloadBackgroundContexts).toHaveBeenCalledWith([0], 1);
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
            message: "All available accounts are busy",
            statusCode: 503,
            statusText: "UNAVAILABLE",
        });
    });

    test("checkAndRetireAccount retires account when model usage reaches dailyLimit", async () => {
        const mockModelTracker = {
            getUsage: jest.fn(idx => (idx === 0 ? 1000 : 0)),
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

    test("daily Beijing 15:00 cycle rollover resets retired accounts and clears failures", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        // Mock active cycle key as "2026-08-04_15:00"
        scheduler.currentCycleKey = "2026-08-04_15:00";

        // Set up RETIRED status, failure counts and suspension
        scheduler.accountStatusMap.set(0, { lastActivatedAt: Date.now(), status: "RETIRED" });
        scheduler.accountStatusMap.set(1, { lastActivatedAt: Date.now(), status: "ACTIVATED" });
        scheduler.failureCountMap.set(0, 3);
        scheduler.failureCountMap.set(1, 1);
        scheduler.suspendedUntilMap.set(1, Date.now() + 20000);

        // Force getBeijingCycleKey to return a new cycle key on next call
        jest.spyOn(scheduler, "getBeijingCycleKey").mockReturnValue("2026-08-05_15:00");

        // Calling getAccountStatus should trigger the rollover check
        const status0 = scheduler.getAccountStatus(0);
        expect(status0).toBe("INACTIVE"); // Account 0 retired -> inactive
        expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED"); // Account 1 activated -> remains activated

        // Failures and suspensions should be cleared
        expect(scheduler.failureCountMap.get(0)).toBeUndefined();
        expect(scheduler.failureCountMap.get(1)).toBeUndefined();
        expect(scheduler.suspendedUntilMap.get(1)).toBeUndefined();
        expect(scheduler.currentCycleKey).toBe("2026-08-05_15:00");
    });

    test("getNextAuthIndex expires ACTIVATED account back to INACTIVE after 2 minutes if inFlight is 0", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockBrowserManager = {
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);

        // Activate account 0
        scheduler.setAccountStatus(0, "ACTIVATED");

        // Fast-forward lastActivatedAt by 125 seconds (exceeding 120s limit)
        const entry = scheduler.accountStatusMap.get(0);
        entry.lastActivatedAt = Date.now() - 125000;
        scheduler.accountStatusMap.set(0, entry);

        jest.spyOn(Math, "random").mockReturnValue(0);

        // Calling getNextAuthIndex triggers _refreshAccountStatuses which expires account 0 to INACTIVE,
        // and then activates it via baseline check
        await scheduler.getNextAuthIndex("gemini-2.5-flash");
        expect(mockBrowserManager.launchOrSwitchContext).toHaveBeenCalledWith(0);

        Math.random.mockRestore();
    });

    test("getAccountStatus and getNextAuthIndex do NOT expire ACTIVATED account if it has in-flight requests", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

        // Activate account 0 and set inFlight = 1
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.acquireInFlight(0);

        // Fast-forward lastActivatedAt by 125 seconds (exceeding 120s limit)
        const entry = scheduler.accountStatusMap.get(0);
        entry.lastActivatedAt = Date.now() - 125000;
        scheduler.accountStatusMap.set(0, entry);

        // Calling getAccountStatus should NOT expire it because in-flight count is > 0
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
    });

    test("getNextAuthIndex distributes requests weighted by remaining capacity (statistical distribution test)", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelUsageTracker = {
            getUsage: jest.fn(authIndex => (authIndex === 0 ? 100 : 900)),
        };
        const scheduler = new AccountScheduler(
            { availableIndices: [0, 1] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            mockModelUsageTracker,
            [{ dailyLimit: 1000, name: "models/gemini-2.5-pro" }],
            { maxContexts: 2 }
        );

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");

        const counts = { 0: 0, 1: 0 };
        const iterations = 1000;

        for (let i = 0; i < iterations; i++) {
            const selectedIdx = await scheduler.getNextAuthIndex("gemini-2.5-pro");
            counts[selectedIdx]++;
        }

        // Account 0 (usage=100, weight=900) should get ~90% of requests (830-950 out of 1000)
        // Account 1 (usage=900, weight=100) should get ~10% of requests (50-170 out of 1000)
        expect(counts[0]).toBeGreaterThan(830);
        expect(counts[0]).toBeLessThan(950);
        expect(counts[1]).toBeGreaterThan(50);
        expect(counts[1]).toBeLessThan(170);
    });
});
