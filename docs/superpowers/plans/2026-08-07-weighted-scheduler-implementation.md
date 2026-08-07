# Remaining Capacity Weighted Scheduling Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement remaining capacity weighted random selection in `AccountScheduler` to prevent under-utilization of higher-usage accounts when usage gaps exist.

**Architecture:** Replace deterministic usage sorting in `AccountScheduler.getNextAuthIndex` with a helper method `selectWeightedCandidate(candidates, limit)` that selects candidates based on probability proportional to remaining daily quota ($W_i = \max(1, \text{limit} - \text{usage}_i)$).

**Tech Stack:** Node.js (ES6 / CommonJS), Jest (Unit Testing), ESLint.

## Global Constraints

- **Language & Runtime:** Node.js CommonJS modules (`module.exports` / `require`).
- **Target File:** `src/concurrent/AccountScheduler.js`
- **Test File:** `test/concurrent/account_scheduler.test.js`
- **Code Quality:** `npm run lint:js` must pass with 0 errors.
- **Testing:** All Jest tests under `test/concurrent/` must pass.

---

### Task 1: Add `selectWeightedCandidate` helper method to `AccountScheduler`

**Files:**
- Modify: `src/concurrent/AccountScheduler.js:500-535`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Produces: `AccountScheduler.prototype.selectWeightedCandidate(candidates, limit)`
  - Parameter `candidates`: Array of candidate objects `{ idx, inFlight, order, usage }`
  - Parameter `limit`: Number representing daily limit for model
  - Returns: Selected candidate object or `null` if candidates array is empty/null.

- [ ] **Step 1: Write the failing unit tests for `selectWeightedCandidate`**

Add tests to `test/concurrent/account_scheduler.test.js`:

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "selectWeightedCandidate"`
Expected: FAIL with `scheduler.selectWeightedCandidate is not a function`.

- [ ] **Step 3: Implement `selectWeightedCandidate` in `AccountScheduler.js`**

Add the method to `src/concurrent/AccountScheduler.js`:

```javascript
    /**
     * Select a candidate using Weighted Random Selection based on remaining capacity
     * @param {Array<Object>} candidates - List of candidates { idx, inFlight, order, usage }
     * @param {number} limit - Daily limit for current model
     * @returns {Object|null} Selected candidate
     */
    selectWeightedCandidate(candidates, limit) {
        if (!candidates || candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];

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
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "selectWeightedCandidate"`
Expected: PASS with 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): add selectWeightedCandidate helper method to AccountScheduler"
```

---

### Task 2: Integrate `selectWeightedCandidate` into `getNextAuthIndex` & add statistical tests

**Files:**
- Modify: `src/concurrent/AccountScheduler.js:550-600`
- Test: `test/concurrent/account_scheduler.test.js`

**Interfaces:**
- Consumes: `selectWeightedCandidate(candidates, limit)` from Task 1
- Modifies: `getNextAuthIndex(modelName)` inside `AccountScheduler.js` to use `selectWeightedCandidate` for baseline candidate selection, Phase 1 (`activatedFree`), and Phase 2 (`activatedBusy`).

- [ ] **Step 1: Write statistical distribution unit test in `account_scheduler.test.js`**

Add test to `test/concurrent/account_scheduler.test.js`:

```javascript
    test("getNextAuthIndex distributes requests weighted by remaining capacity (statistical distribution test)", async () => {
        mockConnectionRegistry.hasConnection.mockReturnValue(true);
        const mockModelUsageTracker = {
            getUsage: jest.fn((authIndex) => (authIndex === 0 ? 100 : 900)),
        };
        const scheduler = new AccountScheduler(
            { availableIndices: [0, 1] },
            mockConnectionRegistry,
            mockLogger,
            mockBrowserManager,
            mockModelUsageTracker,
            [{ name: "models/gemini-2.5-pro", dailyLimit: 1000 }],
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/concurrent/account_scheduler.test.js -t "getNextAuthIndex distributes requests weighted"`
Expected: FAIL because `counts[1]` will be `0` (deterministic sorting always picks Account 0).

- [ ] **Step 3: Refactor `getNextAuthIndex` in `src/concurrent/AccountScheduler.js` to use `selectWeightedCandidate`**

In `src/concurrent/AccountScheduler.js`, replace the `usageSort` calls in baseline check, Phase 1, and Phase 2:

```javascript
        // Baseline Check: If activated count < maxContexts and inactive candidates exist and 30s cooldown met, trigger background baseline activation
        if (totalActivated < maxContexts && inactiveCandidates.length > 0 && canCooldown) {
            const baselineCandidate = this.selectWeightedCandidate(inactiveCandidates, limit);
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
            const selectedCandidate = this.selectWeightedCandidate(activatedFree, limit);
            const selectedIdx = selectedCandidate.idx;
            const selectedOrder = selectedCandidate.order;
            const weight = Math.max(1, limit - selectedCandidate.usage);
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 1: Free Activated, inFlight=0, usage=${selectedCandidate.usage}/${limit}, weight=${weight})`
                );
            }
            return selectedIdx;
        }

        // Phase 2: Reuse a lightly-busy ACTIVATED account (inFlight === 1)
        if (activatedBusy.length > 0) {
            const selectedCandidate = this.selectWeightedCandidate(activatedBusy, limit);
            const selectedIdx = selectedCandidate.idx;
            const selectedOrder = selectedCandidate.order;
            const weight = Math.max(1, limit - selectedCandidate.usage);
            this.currentIndex = (this.currentIndex + selectedOrder + 1) % total;

            if (this.logger && typeof this.logger.info === "function") {
                this.logger.info(
                    `[AccountScheduler] Selected authIndex #${selectedIdx} for model="${modelName}" (Phase 2: Lightly Busy, inFlight=1, usage=${selectedCandidate.usage}/${limit}, weight=${weight})`
                );
            }
            return selectedIdx;
        }
```

- [ ] **Step 4: Run all concurrent tests to verify they pass**

Run: `npx jest test/concurrent/`
Expected: PASS with 64 tests passing across 5 test suites.

- [ ] **Step 5: Run linter to check code style**

Run: `npm run lint:js`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/concurrent/AccountScheduler.js test/concurrent/account_scheduler.test.js
git commit -m "feat(concurrent): integrate remaining capacity weighted selection into getNextAuthIndex"
```
