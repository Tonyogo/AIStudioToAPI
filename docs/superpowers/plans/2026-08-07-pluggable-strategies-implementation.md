# Pluggable Scheduling Strategies Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor candidate selection in `AccountScheduler` into a pluggable Strategy Pattern (`src/concurrent/strategies/`) supporting `weighted`, `round-robin`, and `least-used` strategies with hierarchical configuration resolution.

**Architecture:** Create individual strategy modules in `src/concurrent/strategies/` managed by a central factory (`index.js`). `AccountScheduler` resolves strategy name via priority (1. model override -> 2. global config/env -> 3. "weighted") and delegates candidate selection to the factory.

**Tech Stack:** Node.js (CommonJS), Jest (Unit Testing), ESLint.

## Global Constraints

- **Language & Runtime:** Node.js CommonJS modules (`module.exports` / `require`).
- **Target Directory:** `src/concurrent/strategies/` and `src/concurrent/AccountScheduler.js`.
- **Test Files:** `test/concurrent/strategies.test.js` and `test/concurrent/account_scheduler.test.js`.
- **Code Quality:** `npx eslint src/concurrent/ test/concurrent/` must pass with 0 errors.
- **Testing:** All Jest tests under `test/concurrent/` must pass.

---

### Task 1: Create strategy modules and factory in `src/concurrent/strategies/`

**Files:**
- Create: `src/concurrent/strategies/weighted.js`
- Create: `src/concurrent/strategies/round-robin.js`
- Create: `src/concurrent/strategies/least-used.js`
- Create: `src/concurrent/strategies/index.js`
- Test: `test/concurrent/strategies.test.js`

**Interfaces:**
- Produces: `src/concurrent/strategies/index.js`
  - Function: `selectCandidate(strategyName, candidates, context)`
  - Parameter `strategyName`: string (e.g., `"weighted"`, `"round-robin"`, `"least-used"`)
  - Parameter `candidates`: Array of `{ idx, inFlight, order, usage }`
  - Parameter `context`: `{ limit, modelName }`
  - Returns: Selected candidate object or `null`

- [ ] **Step 1: Write failing unit tests for strategy modules in `test/concurrent/strategies.test.js`**

Create `test/concurrent/strategies.test.js`:

```javascript
/* eslint-env jest */
const { selectCandidate, STRATEGIES } = require("../../src/concurrent/strategies");
const weighted = require("../../src/concurrent/strategies/weighted");
const roundRobin = require("../../src/concurrent/strategies/round-robin");
const leastUsed = require("../../src/concurrent/strategies/least-used");

describe("Scheduling Strategies", () => {
    const candidateA = { idx: 0, inFlight: 0, order: 0, usage: 100 };
    const candidateB = { idx: 1, inFlight: 0, order: 1, usage: 900 };
    const candidateC = { idx: 2, inFlight: 0, order: 2, usage: 500 };
    const candidates = [candidateA, candidateB, candidateC];

    describe("weighted strategy", () => {
        test("returns null for empty candidates", () => {
            expect(weighted([], { limit: 1000 })).toBeNull();
        });

        test("returns the single candidate if candidates length is 1", () => {
            expect(weighted([candidateA], { limit: 1000 })).toBe(candidateA);
        });

        test("selects candidate proportional to remaining capacity weight", () => {
            jest.spyOn(Math, "random").mockReturnValue(0.1);
            expect(weighted([candidateA, candidateB], { limit: 1000 })).toBe(candidateA);

            Math.random.mockReturnValue(0.95);
            expect(weighted([candidateA, candidateB], { limit: 1000 })).toBe(candidateB);

            Math.random.mockRestore();
        });
    });

    describe("round-robin strategy", () => {
        test("returns candidate with smallest order index", () => {
            const unordered = [candidateC, candidateA, candidateB];
            expect(roundRobin(unordered, {})).toBe(candidateA);
        });
    });

    describe("least-used strategy", () => {
        test("returns candidate with lowest usage count", () => {
            const unordered = [candidateB, candidateC, candidateA];
            expect(leastUsed(unordered, {})).toBe(candidateA);
        });

        test("falls back to order ascending when usage is equal", () => {
            const c1 = { idx: 0, inFlight: 0, order: 0, usage: 100 };
            const c2 = { idx: 1, inFlight: 0, order: 1, usage: 100 };
            expect(leastUsed([c2, c1], {})).toBe(c1);
        });
    });

    describe("strategy factory (index.js)", () => {
        test("selectCandidate dispatches to correct strategy function", () => {
            const unordered = [candidateB, candidateC, candidateA];
            expect(selectCandidate("round-robin", unordered)).toBe(candidateA);
            expect(selectCandidate("least-used", unordered)).toBe(candidateA);
        });

        test("falls back to weighted strategy for unknown strategy name", () => {
            jest.spyOn(Math, "random").mockReturnValue(0);
            expect(selectCandidate("unknown_strategy", [candidateA, candidateB], { limit: 1000 })).toBe(candidateA);
            Math.random.mockRestore();
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/strategies.test.js`
Expected: FAIL with `Cannot find module '../../src/concurrent/strategies'`.

- [ ] **Step 3: Implement `weighted.js` in `src/concurrent/strategies/weighted.js`**

Create `src/concurrent/strategies/weighted.js`:

```javascript
/**
 * Remaining capacity weighted random selection strategy
 * @param {Array<Object>} candidates - [{ idx, inFlight, order, usage }]
 * @param {Object} context - { limit }
 * @returns {Object|null}
 */
module.exports = function selectWeightedCandidate(candidates, context = {}) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const limit = typeof context?.limit === "number" ? context.limit : 1000;
    const weights = candidates.map(c => Math.max(1, limit - (c.usage || 0)));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    let random = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
        random -= weights[i];
        if (random <= 0) {
            return candidates[i];
        }
    }
    return candidates[candidates.length - 1];
};
```

- [ ] **Step 4: Implement `round-robin.js` in `src/concurrent/strategies/round-robin.js`**

Create `src/concurrent/strategies/round-robin.js`:

```javascript
/**
 * Round-robin candidate selection strategy (order ascending)
 * @param {Array<Object>} candidates - [{ idx, inFlight, order, usage }]
 * @returns {Object|null}
 */
module.exports = function selectRoundRobinCandidate(candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const sorted = [...candidates].sort((a, b) => (a.order || 0) - (b.order || 0));
    return sorted[0];
};
```

- [ ] **Step 5: Implement `least-used.js` in `src/concurrent/strategies/least-used.js`**

Create `src/concurrent/strategies/least-used.js`:

```javascript
/**
 * Least-used candidate selection strategy (usage ascending, secondary order ascending)
 * @param {Array<Object>} candidates - [{ idx, inFlight, order, usage }]
 * @returns {Object|null}
 */
module.exports = function selectLeastUsedCandidate(candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const sorted = [...candidates].sort((a, b) => {
        const uA = a.usage || 0;
        const uB = b.usage || 0;
        if (uA !== uB) {
            return uA - uB;
        }
        return (a.order || 0) - (b.order || 0);
    });
    return sorted[0];
};
```

- [ ] **Step 6: Implement factory registry in `src/concurrent/strategies/index.js`**

Create `src/concurrent/strategies/index.js`:

```javascript
const weighted = require("./weighted");
const roundRobin = require("./round-robin");
const leastUsed = require("./least-used");

const STRATEGIES = {
    "least-used": leastUsed,
    "round-robin": roundRobin,
    "weighted": weighted,
};

function selectCandidate(strategyName, candidates, context = {}) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const strategyKey = typeof strategyName === "string" ? strategyName.trim().toLowerCase() : "weighted";
    const strategyFn = STRATEGIES[strategyKey] || STRATEGIES["weighted"];
    return strategyFn(candidates, context);
}

module.exports = {
    STRATEGIES,
    selectCandidate,
};
```

- [ ] **Step 7: Run strategy unit tests and verify they pass**

Run: `npx jest test/concurrent/strategies.test.js`
Expected: PASS for all strategy tests.

- [ ] **Step 8: Commit strategy modules**

```bash
git add src/concurrent/strategies/ test/concurrent/strategies.test.js
git commit -m "feat(concurrent): implement pluggable strategy modules in src/concurrent/strategies/"
```

---

### Task 2: Integrate strategy factory and resolution into `AccountScheduler.js`

**Files:**
- Modify: `src/concurrent/AccountScheduler.js`
- Modify: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `src/concurrent/strategies` (`selectCandidate`)
- Modifies: `AccountScheduler.js`
  - Adds `getSchedulingStrategy(modelName)`
  - Refactors `selectWeightedCandidate` to call `selectCandidate(this.getSchedulingStrategy(modelName), candidates, context)`
  - Updates log messages in `getNextAuthIndex` to include active strategy name.

- [ ] **Step 1: Write unit tests for strategy resolution in `test/concurrent/account_scheduler.test.js`**

Add tests to `test/concurrent/account_scheduler.test.js`:

```javascript
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
            { concurrentSchedulingStrategy: "least-used" }
        );

        // 1. Model override in models.json -> "round-robin"
        expect(scheduler.getSchedulingStrategy("gemini-2.5-pro")).toBe("round-robin");

        // 2. Model without override falls back to global config -> "least-used"
        expect(scheduler.getSchedulingStrategy("gemini-2.5-flash")).toBe("least-used");

        // 3. Without global config or model override -> defaults to "weighted"
        const defaultScheduler = new AccountScheduler(mockAuthSource, mockConnectionRegistry, mockLogger);
        expect(defaultScheduler.getSchedulingStrategy("gemini-2.5-flash")).toBe("weighted");
    });

    test("getNextAuthIndex uses model-specific round-robin strategy correctly", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelTracker = {
            getUsage: jest.fn((authIndex) => (authIndex === 0 ? 900 : 100)), // Account 0 has higher usage
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "getSchedulingStrategy"`
Expected: FAIL with `scheduler.getSchedulingStrategy is not a function`.

- [ ] **Step 3: Refactor `AccountScheduler.js` to use `src/concurrent/strategies`**

In `src/concurrent/AccountScheduler.js`:

Import `selectCandidate` at top of file:
```javascript
const { selectCandidate } = require("./strategies");
```

Add `getSchedulingStrategy(modelName)` method:
```javascript
    /**
     * Resolve scheduling strategy name for a given model
     * Priority: 1. Model override in models.json -> 2. Global config/env -> 3. "weighted"
     * @param {string} modelName
     * @returns {string} Strategy name ("weighted" | "round-robin" | "least-used")
     */
    getSchedulingStrategy(modelName) {
        if (modelName && Array.isArray(this.modelList)) {
            const match = this.modelList.find(m => {
                if (!m || !m.name) return false;
                const cleanName = m.name.replace("models/", "");
                return cleanName === modelName || m.name === modelName;
            });
            if (match && typeof match.schedulingStrategy === "string" && match.schedulingStrategy.trim() !== "") {
                return match.schedulingStrategy.trim().toLowerCase();
            }
        }

        const globalStrategy =
            this.config?.concurrentSchedulingStrategy || process.env.CONCURRENT_SCHEDULING_STRATEGY;
        if (typeof globalStrategy === "string" && globalStrategy.trim() !== "") {
            return globalStrategy.trim().toLowerCase();
        }

        return "weighted";
    }
```

Update `selectWeightedCandidate` to delegate to `selectCandidate` for backwards compatibility:
```javascript
    /**
     * Select a candidate using configured strategy
     * @param {Array<Object>} candidates - List of candidates { idx, inFlight, order, usage }
     * @param {number} limit - Daily limit for current model
     * @param {string} [modelName=null] - Model name
     * @returns {Object|null} Selected candidate
     */
    selectWeightedCandidate(candidates, limit, modelName = null) {
        const strategyName = this.getSchedulingStrategy(modelName);
        return selectCandidate(strategyName, candidates, { limit, modelName });
    }
```

Update `getNextAuthIndex` in `AccountScheduler.js`:
```javascript
        const strategyName = this.getSchedulingStrategy(modelName);
        const strategyContext = { limit, modelName };

        // Baseline Check
        if (totalActivated < maxContexts && inactiveCandidates.length > 0 && canCooldown) {
            const baselineCandidate = selectCandidate(strategyName, inactiveCandidates, strategyContext);
            const baselineIndex = inactiveCandidates.indexOf(baselineCandidate);
            if (baselineIndex > -1) {
                inactiveCandidates.splice(baselineIndex, 1);
            }
            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Activated accounts count (${totalActivated}) < maxContexts (${maxContexts}), activating authIndex #${baselineCandidate.idx} for baseline...`
                );
            }
            const activated = await this.activateAccount(baselineCandidate.idx);
            if (activated) {
                activatedFree.push(baselineCandidate);
            }
        }

        // Phase 1: Use an absolutely free ACTIVATED account (inFlight === 0)
        if (activatedFree.length > 0) {
            const selectedCandidate = selectCandidate(strategyName, activatedFree, strategyContext);
            const selectedIdx = selectedCandidate.idx;
            const selectedOrder = selectedCandidate.order;
            const weight = Math.max(1, limit - selectedCandidate.usage);
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 1: Free Activated, strategy="${strategyName}", inFlight=0, usage=${selectedCandidate.usage}/${limit}, weight=${weight})`
                );
            }
            return selectedIdx;
        }

        // Phase 2: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
        if (activatedBusy.length > 0) {
            const selectedCandidate = selectCandidate(strategyName, activatedBusy, strategyContext);
            const selectedIdx = selectedCandidate.idx;
            const selectedOrder = selectedCandidate.order;
            const weight = Math.max(1, limit - selectedCandidate.usage);
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 2: Lightly Busy, strategy="${strategyName}", inFlight=1, usage=${selectedCandidate.usage}/${limit}, weight=${weight})`
                );
            }
            return selectedIdx;
        }
```

- [ ] **Step 4: Run all concurrent tests to verify they pass**

Run: `npx jest test/concurrent/`
Expected: PASS for all 74+ tests.

- [ ] **Step 5: Run ESLint to verify zero lint errors**

Run: `npx eslint src/concurrent/ test/concurrent/`
Expected: 0 errors, 0 warnings.

- [ ] **Step 6: Commit changes**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): integrate pluggable scheduling strategy architecture into AccountScheduler"
```
