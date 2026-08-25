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

    describe("acquireNextAuthIndex", () => {
        test("returns authIndex immediately when account is free", async () => {
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
            scheduler.setAccountStatus(0, "ACTIVATED");

            const authIndex = await scheduler.acquireNextAuthIndex("gemini-2.5-flash");
            expect(authIndex).toBe(0);
            expect(scheduler.getInFlightCount(0)).toBe(1);
        });

        test("polls and resolves when account becomes free within timeout", async () => {
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            mockAuthSource.availableIndices = [0];
            const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
            scheduler.setAccountStatus(0, "ACTIVATED");

            // Lock account 0 completely
            scheduler.acquireInFlight(0);
            scheduler.acquireInFlight(0);

            // Release in-flight after 100ms
            setTimeout(() => {
                scheduler.releaseInFlight(0);
                scheduler.releaseInFlight(0);
            }, 100);

            const authIndex = await scheduler.acquireNextAuthIndex("gemini-2.5-flash", { timeoutMs: 1000 });
            expect(authIndex).toBe(0);
        });

        test("throws 503 error after timeout if all accounts remain busy", async () => {
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            mockAuthSource.availableIndices = [0];
            const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
            scheduler.setAccountStatus(0, "ACTIVATED");

            // Lock account 0 completely
            scheduler.acquireInFlight(0);
            scheduler.acquireInFlight(0);

            await expect(scheduler.acquireNextAuthIndex("gemini-2.5-flash", { timeoutMs: 100 })).rejects.toMatchObject({
                message: expect.stringContaining("All available accounts are busy"),
                statusCode: 503,
            });
        });

        test("aborts immediately when signal is triggered during poll sleep", async () => {
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            mockAuthSource.availableIndices = [0];
            const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
            scheduler.setAccountStatus(0, "ACTIVATED");

            scheduler.acquireInFlight(0);
            scheduler.acquireInFlight(0);

            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);

            await expect(
                scheduler.acquireNextAuthIndex("gemini-2.5-flash", { signal: controller.signal, timeoutMs: 2000 })
            ).rejects.toThrow();
        });
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

    test("_moveToFront elevates specified authIndex to the head of activeQueue", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        scheduler._refreshActiveQueue(); // activeQueue becomes [0, 1, 2]
        expect(scheduler.activeQueue).toEqual([0, 1, 2]);

        scheduler._moveToFront(2);
        expect(scheduler.activeQueue).toEqual([2, 0, 1]);

        // Subsequent _moveToFront calls
        scheduler._moveToFront(1);
        expect(scheduler.activeQueue).toEqual([1, 2, 0]);
    });

    test("rebalanceConcurrentPool prioritizes currentAuthIndex and loaded contexts over candidate accounts", async () => {
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { maxContexts: 2 }
        );
        scheduler._refreshActiveQueue(); // [0, 1, 2]

        // Contexts Map currently holds #0 and #2
        mockBrowserManager.contexts = new Map([
            [0, { page: {} }],
            [2, { page: {} }],
        ]);
        mockBrowserManager._currentAuthIndex = 2; // Current active account is #2
        mockBrowserManager._closeContextForPoolIfPossible = jest.fn();
        mockBrowserManager._preloadBackgroundContexts = jest.fn();

        await scheduler.rebalanceConcurrentPool();

        // Verify context #2 is NOT closed
        expect(mockBrowserManager._closeContextForPoolIfPossible).not.toHaveBeenCalledWith(2, expect.any(String));
        // Verify preloading does not pull in #1 at the expense of closing #2
        expect(mockBrowserManager._closeContextForPoolIfPossible).not.toHaveBeenCalled();
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
            mockModelTracker,
            [],
            { concurrentSchedulingStrategy: "weighted" }
        );
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");
        scheduler.setAccountStatus(2, "ACTIVATED");

        jest.spyOn(Math, "random").mockReturnValue(0.4);

        const selected = await scheduler.getNextAuthIndex("gemini-2.5-pro");
        expect(selected).toBe(1);
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                '[AccountScheduler] Selected authIndex #1 for model="gemini-2.5-pro" (Phase 1: Free Activated, strategy="weighted", inFlight=0, usage=1/'
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
            mockModelList,
            { concurrentSchedulingStrategy: "weighted" }
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

    test("recordFailure increments failure count on 429 error without suspension", () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(scheduler.failureCountMap.get(0) || 0).toBe(0);

        scheduler.recordFailure(0, 429);
        expect(scheduler.failureCountMap.get(0)).toBe(1);
    });

    test("recordFailure accumulates consecutive non-429 failures smoothly and triggers retirement on threshold", async () => {
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const mockConfig = { failureThreshold: 3 };

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

        // First 403 failure
        scheduler.recordFailure(0, 403);
        expect(scheduler.failureCountMap.get(0)).toBe(1);

        // Second 403 failure - should NOT reset to 0
        scheduler.recordFailure(0, 403);
        expect(scheduler.failureCountMap.get(0)).toBe(2);

        // Third 403 failure
        scheduler.recordFailure(0, 403);
        expect(scheduler.failureCountMap.get(0)).toBe(3);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.getAccountStatus(0)).toBe("RETIRED");
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

    test("checkAndRetireAccount does NOT retire account when model usage reaches dailyLimit", async () => {
        const mockModelTracker = {
            getUsage: jest.fn(idx => (idx === 0 ? 1000 : 0)),
        };
        const mockBrowserManager = {
            closeContext: jest.fn().mockResolvedValue(),
            launchOrSwitchContext: jest.fn().mockResolvedValue(),
        };
        const mockConfig = { failureThreshold: 3 };

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
        expect(retired).toBe(false);
        expect(scheduler.getAccountStatus(0)).toBe("ACTIVATED");
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

        // Set up RETIRED status, failure counts
        scheduler.accountStatusMap.set(0, { lastActivatedAt: Date.now(), status: "RETIRED" });
        scheduler.accountStatusMap.set(1, { lastActivatedAt: Date.now(), status: "ACTIVATED" });
        scheduler.failureCountMap.set(0, 3);
        scheduler.failureCountMap.set(1, 1);

        // Force getBeijingCycleKey to return a new cycle key on next call
        jest.spyOn(scheduler, "getBeijingCycleKey").mockReturnValue("2026-08-05_15:00");

        // Calling getAccountStatus should trigger the rollover check
        const status0 = scheduler.getAccountStatus(0);
        expect(status0).toBe("INACTIVE"); // Account 0 retired -> inactive
        expect(scheduler.getAccountStatus(1)).toBe("ACTIVATED"); // Account 1 activated -> remains activated

        // Failures should be cleared
        expect(scheduler.failureCountMap.get(0)).toBeUndefined();
        expect(scheduler.failureCountMap.get(1)).toBeUndefined();
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
            { concurrentSchedulingStrategy: "weighted", maxContexts: 2 }
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

    test("checkAndRetireAccount immediately retires account when receiving HTTP 429 status code", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 429);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.retireAndReplaceAccount).toHaveBeenCalledWith(0, "received immediate switch status code 429");
    });

    test("checkAndRetireAccount immediately retires account when receiving HTTP 503 status code", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 503);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.retireAndReplaceAccount).toHaveBeenCalledWith(0, "received immediate switch status code 503");
    });

    test("checkAndRetireAccount does NOT immediately retire account on 500 error if failure threshold is not reached", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 500);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(false);
        expect(scheduler.retireAndReplaceAccount).not.toHaveBeenCalled();
    });

    test("checkAndRetireAccount respects custom immediateSwitchStatusCodes config", async () => {
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            [],
            { immediateSwitchStatusCodes: [403] }
        );
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 403);

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(true);
        expect(scheduler.retireAndReplaceAccount).toHaveBeenCalledWith(0, "received immediate switch status code 403");
    });

    test("recordSuccess clears lastStatusCodeMap and resets failure state", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        jest.spyOn(scheduler, "retireAndReplaceAccount").mockResolvedValue();

        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.recordFailure(0, 500);
        expect(scheduler.lastStatusCodeMap.get(0)).toBe(500);

        scheduler.recordSuccess(0);
        expect(scheduler.lastStatusCodeMap.get(0)).toBeUndefined();

        const retired = await scheduler.checkAndRetireAccount(0);
        expect(retired).toBe(false);
    });

    test("getSchedulingStrategy resolves strategy in correct hierarchy order (model config > global config > default)", () => {
        const mockModelList = [
            { name: "models/gemini-2.5-pro", schedulingStrategy: "round-robin" },
            { name: "models/gemini-2.5-flash" },
        ];
        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            null,
            mockModelList,
            { concurrentSchedulingStrategy: "weighted" }
        );

        // 1. Model override in models.json -> "round-robin"
        expect(scheduler.getSchedulingStrategy("gemini-2.5-pro")).toBe("round-robin");

        // 2. Model without override falls back to global config -> "weighted"
        expect(scheduler.getSchedulingStrategy("gemini-2.5-flash")).toBe("weighted");

        // 3. Without global config or model override -> defaults to "least-used"
        const defaultScheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(defaultScheduler.getSchedulingStrategy("gemini-2.5-flash")).toBe("least-used");
    });

    test("getNextAuthIndex uses model-specific round-robin strategy correctly", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelTracker = {
            getUsage: jest.fn(authIndex => (authIndex === 0 ? 900 : 100)), // Account 0 has higher usage
        };
        const mockModelList = [{ name: "models/gemini-2.5-pro", schedulingStrategy: "round-robin" }];

        const scheduler = new AccountScheduler(
            mockAuthSource,
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            mockModelTracker,
            mockModelList
        );
        scheduler.setAccountStatus(0, "ACTIVATED");
        scheduler.setAccountStatus(1, "ACTIVATED");
        scheduler.setAccountStatus(2, "ACTIVATED");

        // With round-robin strategy, candidates order ascending selection occurs sequentially (0 -> 1 -> 2 -> 0)
        // regardless of Account 0 having higher usage
        expect(await scheduler.getNextAuthIndex("gemini-2.5-pro")).toBe(0);
        expect(await scheduler.getNextAuthIndex("gemini-2.5-pro")).toBe(1);
        expect(await scheduler.getNextAuthIndex("gemini-2.5-pro")).toBe(2);
        expect(await scheduler.getNextAuthIndex("gemini-2.5-pro")).toBe(0);
    });

    describe("Active Queue and LRU Updates (Task 1)", () => {
        test("AccountScheduler LRU activeQueue helper methods _moveToFront and _moveToBack", () => {
            const mockAuthSource = { availableIndices: [0, 1, 2] };
            const scheduler = new AccountScheduler(mockAuthSource, {});
            scheduler._refreshActiveQueue(); // activeQueue = [0, 1, 2]

            scheduler._moveToFront(2);
            expect(scheduler.activeQueue).toEqual([2, 0, 1]);

            scheduler._moveToFront(1);
            expect(scheduler.activeQueue).toEqual([1, 2, 0]);

            scheduler._moveToBack(1);
            expect(scheduler.activeQueue).toEqual([2, 0, 1]);
        });

        test("_refreshActiveQueue synchronizes activeQueue with current auth indices and retains existing LRU order", () => {
            const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

            // 1. Initial refresh initializes queue
            scheduler._refreshActiveQueue();
            expect(scheduler.activeQueue).toEqual([0, 1, 2]);

            // 2. Modify LRU order manually
            scheduler.activeQueue = [1, 2, 0];

            // 3. Refresh with same available indices should preserve LRU order
            scheduler._refreshActiveQueue();
            expect(scheduler.activeQueue).toEqual([1, 2, 0]);

            // 4. Shrink/grow available indices: [0, 2, 3] (removes 1, adds 3)
            mockAuthSource.availableIndices = [0, 2, 3];
            scheduler._refreshActiveQueue();
            // Should filter out 1, preserve remaining LRU [2, 0], and append 3 to the end
            expect(scheduler.activeQueue).toEqual([2, 0, 3]);
        });

        test("getNextAuthIndex moves selected index to the front of activeQueue in Phase 1 and Phase 2", async () => {
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);

            // Phase 1 path (Free Activated, inFlight === 0)
            scheduler.setAccountStatus(0, "ACTIVATED");
            scheduler.setAccountStatus(1, "ACTIVATED");
            scheduler.setAccountStatus(2, "ACTIVATED");

            scheduler._refreshActiveQueue();
            expect(scheduler.activeQueue).toEqual([0, 1, 2]);

            // Select next (Round Robin selects candidate 0)
            const firstSelected = await scheduler.getNextAuthIndex();
            expect(firstSelected).toBe(0);
            expect(scheduler.activeQueue).toEqual([0, 1, 2]); // 0 was already at front

            // Advance currentIndex so index 1 is selected next
            const secondSelected = await scheduler.getNextAuthIndex();
            expect(secondSelected).toBe(1);
            // 1 is moved to the front: [1, 0, 2]
            expect(scheduler.activeQueue).toEqual([1, 0, 2]);

            // Phase 2 path (Lightly busy, inFlight === 1)
            // Make all activated busy so we trigger Phase 2 path
            scheduler.acquireInFlight(0);
            scheduler.acquireInFlight(1);
            scheduler.acquireInFlight(2);

            const thirdSelected = await scheduler.getNextAuthIndex();
            expect(thirdSelected).toBe(2);
            // 2 is moved to the front: [2, 1, 0]
            expect(scheduler.activeQueue).toEqual([2, 1, 0]);
        });

        test("retireAndReplaceAccount moves retired index to the end of activeQueue", async () => {
            const scheduler = new AccountScheduler(
                mockAuthSource,
                mockConnectionRegistry,
                mockLogger,
                mockBrowserManager
            );
            jest.spyOn(scheduler, "rebalanceConcurrentPool").mockResolvedValue();

            scheduler._refreshActiveQueue();
            expect(scheduler.activeQueue).toEqual([0, 1, 2]);

            // Move 1 to the front of queue to set up state
            scheduler.activeQueue = [1, 0, 2];

            await scheduler.retireAndReplaceAccount(1, "test failure");
            expect(scheduler.getAccountStatus(1)).toBe("RETIRED");
            // 1 should be moved to the end of the activeQueue
            expect(scheduler.activeQueue).toEqual([0, 2, 1]);
        });

        test("LRU activeQueue correctly tracks selection and retirement priorities", async () => {
            const scheduler = new AccountScheduler(
                { availableIndices: [0, 1, 2] },
                mockConnectionRegistry,
                mockLogger,
                mockBrowserManager
            );

            // Queue starts initialized in original order
            scheduler._refreshActiveQueue();
            expect(scheduler.activeQueue).toEqual([0, 1, 2]);

            // 1. Retirement moves element to end
            await scheduler.retireAndReplaceAccount(1, "test");
            expect(scheduler.activeQueue).toEqual([0, 2, 1]);

            // 2. Selection moves element to front
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            scheduler.setAccountStatus(0, "ACTIVATED");
            scheduler.setAccountStatus(2, "ACTIVATED");
            // Force select candidate (with random mocking for predictability)
            jest.spyOn(Math, "random").mockReturnValue(0);
            const selected = await scheduler.getNextAuthIndex();
            expect(selected).toBe(0);
            expect(scheduler.activeQueue[0]).toBe(0); // 0 is now first

            Math.random.mockRestore();
        });

        test("rebalanceConcurrentPool correctly partitions activeQueue into targets preserving LRU order", async () => {
            const scheduler = new AccountScheduler(
                { availableIndices: [0, 1, 2] },
                mockConnectionRegistry,
                mockLogger,
                mockBrowserManager,
                null,
                [],
                { maxContexts: 2 }
            );

            // Assume Account 1 is retired, Account 0 and 2 are healthy
            scheduler.setAccountStatus(0, "ACTIVATED");
            scheduler.setAccountStatus(1, "RETIRED");
            scheduler.setAccountStatus(2, "ACTIVATED");

            // Force queue order: [0, 2, 1]
            scheduler.activeQueue = [0, 2, 1];

            // Trigger rebalance: healthy are [0, 2], retired is [1]
            // priorityQueue = [0, 2, 1] -> slice(0, maxContexts=2) -> targets Set should contain {0, 2}
            await scheduler.rebalanceConcurrentPool();
            expect(scheduler.getAccountStatus(0)).not.toBe("RETIRED");
            expect(scheduler.getAccountStatus(2)).not.toBe("RETIRED");
        });

        test("all accounts retired resurrects in fair round-robin order based on earliest retirement", async () => {
            const scheduler = new AccountScheduler(
                { availableIndices: [0, 1, 2] },
                mockConnectionRegistry,
                mockLogger,
                mockBrowserManager,
                null,
                [],
                { maxContexts: 1 }
            );

            // 1. Retire Account 0 first, then Account 1, then Account 2
            await scheduler.retireAndReplaceAccount(0, "limit");
            await scheduler.retireAndReplaceAccount(1, "limit");
            await scheduler.retireAndReplaceAccount(2, "limit");

            // The queue order must be [0, 1, 2] since they retired sequentially, meaning Account 0 is earliest-retired
            // With maxContexts=1, targets should be {0}.
            // Account 0 is reactivated/resurrected back to INACTIVE
            expect(scheduler.getAccountStatus(0)).toBe("INACTIVE");
            expect(scheduler.getAccountStatus(1)).toBe("RETIRED");
            expect(scheduler.getAccountStatus(2)).toBe("RETIRED");

            // Clear mock calls
            scheduler.rebalanceConcurrentPool = jest.fn();

            // 2. Suppose Account 0 is selected and then retired again
            // Queue was [0, 1, 2] (or [1, 2, 0] after retirement of 0).
            // Let's force queue order [1, 2, 0] and set all to RETIRED again.
            scheduler.activeQueue = [1, 2, 0];
            scheduler.setAccountStatus(0, "RETIRED");
            scheduler.setAccountStatus(1, "RETIRED");
            scheduler.setAccountStatus(2, "RETIRED");

            // Let's run a real rebalance call.
            // It partitions healthy [] and retired [1, 2, 0] in that LRU order.
            // With maxContexts=1, targets should be {1} (earliest retired in current queue).
            // So Account 1 should be resurrected to INACTIVE!
            const realScheduler = new AccountScheduler(
                { availableIndices: [0, 1, 2] },
                mockConnectionRegistry,
                mockLogger,
                mockBrowserManager,
                null,
                [],
                { maxContexts: 1 }
            );
            realScheduler.activeQueue = [1, 2, 0];
            realScheduler.setAccountStatus(0, "RETIRED");
            realScheduler.setAccountStatus(1, "RETIRED");
            realScheduler.setAccountStatus(2, "RETIRED");

            await realScheduler.rebalanceConcurrentPool();
            expect(realScheduler.getAccountStatus(1)).toBe("INACTIVE"); // Resurrected!
            expect(realScheduler.getAccountStatus(2)).toBe("RETIRED");
            expect(realScheduler.getAccountStatus(0)).toBe("RETIRED");
        });
    });

    test("rebalanceConcurrentPool skips execution when already rebalancing", async () => {
        const scheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
        scheduler._isRebalancing = true;

        await scheduler.rebalanceConcurrentPool();

        expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("Rebalance already in progress"));
    });

    describe("BrowserManager rebalanceContextPool delegation", () => {
        test("delegates rebalanceContextPool to accountScheduler when registered", async () => {
            const BrowserManager = require("../../src/core/BrowserManager");
            const bm = new BrowserManager(mockLogger, { maxContexts: 2 }, mockAuthSource);

            const mockScheduler = {
                rebalanceConcurrentPool: jest.fn().mockResolvedValue(undefined),
            };

            bm.setAccountScheduler(mockScheduler);

            await bm.rebalanceContextPool();

            expect(mockScheduler.rebalanceConcurrentPool).toHaveBeenCalledTimes(1);
        });
    });

    describe("Disabled Accounts Handling", () => {
        test("_getAccountIndices filters out disabledIndices and expiredIndices", () => {
            const authSource = {
                availableIndices: [0, 1, 2, 3],
                disabledIndices: [1],
                expiredIndices: [2],
            };
            const scheduler = new AccountScheduler(authSource, mockConnectionRegistry, mockLogger);
            expect(scheduler._getAccountIndices()).toEqual([0, 3]);
        });

        test("rebalanceConcurrentPool skips disabled accounts and closes excess context if active", async () => {
            const authSource = {
                availableIndices: [0, 1, 2],
                disabledIndices: [1],
                isDisabled: jest.fn(idx => idx === 1),
                isExpired: jest.fn(() => false),
            };
            const mockBrowserManager = {
                _closeContextForPoolIfPossible: jest.fn(),
                _preloadBackgroundContexts: jest.fn(),
                contexts: new Map([
                    [0, {}],
                    [1, {}], // Account 1 is open in context but is disabled
                ]),
            };

            const scheduler = new AccountScheduler(
                authSource,
                mockConnectionRegistry,
                mockLogger,
                mockBrowserManager,
                null,
                [],
                { maxContexts: 2 }
            );

            await scheduler.rebalanceConcurrentPool();

            // Account 1 should be excluded from targets, so browserManager should close context 1
            expect(mockBrowserManager._closeContextForPoolIfPossible).toHaveBeenCalledWith(1, "rebalance_retired");
        });

        test("getNextAuthIndex skips disabled accounts even if available in authSource", async () => {
            mockConnectionRegistry.hasConnection.mockReturnValue(true);
            const authSource = {
                availableIndices: [0, 1],
                disabledIndices: [1],
                isDisabled: jest.fn(idx => idx === 1),
                isExpired: jest.fn(() => false),
            };

            const scheduler = new AccountScheduler(authSource, mockConnectionRegistry, mockLogger, mockBrowserManager);
            scheduler.setAccountStatus(0, "ACTIVATED");
            scheduler.setAccountStatus(1, "ACTIVATED");

            // Even if index 1 is ACTIVATED, getNextAuthIndex gets candidate indices from _getAccountIndices
            // which excludes index 1
            const selected = await scheduler.getNextAuthIndex("gemini-2.5-flash");
            expect(selected).toBe(0);
        });
    });
});
