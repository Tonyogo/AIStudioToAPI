# Design Spec: Pluggable Scheduling Strategies Architecture for Concurrent Subsystem

**Date:** 2026-08-07  
**Status:** Approved  
**Target Files:**
- `src/concurrent/strategies/index.js`
- `src/concurrent/strategies/weighted.js`
- `src/concurrent/strategies/round-robin.js`
- `src/concurrent/strategies/least-used.js`
- `src/concurrent/AccountScheduler.js`  
**Test Files:**
- `test/concurrent/strategies.test.js`
- `test/concurrent/account_scheduler.test.js`

---

## 1. Problem Statement & Background

Currently, candidate selection in `AccountScheduler` hardcodes `selectWeightedCandidate` (capacity-weighted random selection). To support additional selection algorithms (e.g. pure round-robin across models, strictly least-used) and future custom strategies, the scheduling architecture needs to be refactored into a pluggable Strategy Pattern.

---

## 2. Proposed Architecture: Pluggable Strategy Pattern

Extract candidate selection algorithms into isolated strategy modules inside `src/concurrent/strategies/` managed by a central factory registry.

```text
src/
└── concurrent/
    └── strategies/
        ├── index.js          # Factory registry & entry point
        ├── round-robin.js    # Pure sequential round-robin selection (default)
        ├── weighted.js       # Remaining capacity weighted selection
        └── least-used.js     # Strictly least-used selection (ascending usage)
```

---

## 3. Detailed Specification

### 3.1 Strategy Modules & Interface Contract

Each strategy file (`weighted.js`, `round-robin.js`, `least-used.js`) exports a single function matching this signature:

```javascript
/**
 * Select a candidate account from an array of eligible candidate objects
 * @param {Array<Object>} candidates - List of candidates [{ idx, inFlight, order, usage }]
 * @param {Object} context - Strategy context { limit, modelName }
 * @returns {Object|null} Selected candidate object
 */
module.exports = function selectCandidate(candidates, context) { ... };
```

#### Strategy Behavior Specs
1. **`weighted.js`**: Calculates weight $W_i = \max(1, limit - usage_i)$ and selects probabilistically via cumulative subtraction on $R = \text{Math.random()} \times \sum W_i$.
2. **`round-robin.js`**: Sorts candidates by `order` ascending and selects `candidates[0]`.
3. **`least-used.js`**: Sorts candidates by `usage` ascending (secondary by `order` ascending) and selects `candidates[0]`.

### 3.2 Strategy Factory Registry (`src/concurrent/strategies/index.js`)

```javascript
const weighted = require("./weighted");
const roundRobin = require("./round-robin");
const leastUsed = require("./least-used");

const STRATEGIES = {
    "weighted": weighted,
    "round-robin": roundRobin,
    "least-used": leastUsed,
};

function selectCandidate(strategyName, candidates, context = {}) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const strategyKey = typeof strategyName === "string" ? strategyName.toLowerCase() : "round-robin";
    const strategyFn = STRATEGIES[strategyKey] || STRATEGIES["round-robin"];
    return strategyFn(candidates, context);
}

module.exports = {
    selectCandidate,
    STRATEGIES,
};
```

### 3.3 Hierarchical Strategy Resolution in `AccountScheduler.js`

Add method `getSchedulingStrategy(modelName)` to `AccountScheduler.js`:

```javascript
/**
 * Resolve scheduling strategy name for a given model
 * Priority: 1. Model override in models.json -> 2. Global config/env -> 3. "round-robin"
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

    const globalStrategy = this.config?.concurrentSchedulingStrategy || process.env.CONCURRENT_SCHEDULING_STRATEGY;
    if (typeof globalStrategy === "string" && globalStrategy.trim() !== "") {
        return globalStrategy.trim().toLowerCase();
    }

    return "round-robin";
}
```

### 3.4 Integration into `getNextAuthIndex`

Replace calls to `this.selectWeightedCandidate` in `AccountScheduler.js` with `selectCandidate(strategyName, candidates, { limit, modelName })` from `src/concurrent/strategies`:

```javascript
const { selectCandidate } = require("./strategies");

// Inside getNextAuthIndex:
const strategyName = this.getSchedulingStrategy(modelName);
const context = { limit, modelName };

// Baseline activation:
const baselineCandidate = selectCandidate(strategyName, inactiveCandidates, context);

// Phase 1 (activatedFree):
const selectedCandidate = selectCandidate(strategyName, activatedFree, context);

// Phase 2 (activatedBusy):
const selectedCandidate = selectCandidate(strategyName, activatedBusy, context);
```

Update log messages to record active strategy:
```text
[AccountScheduler] Selected authIndex #1 for model="gemini-2.5-pro" (Phase 1: Free Activated, strategy="round-robin", inFlight=0, usage=100/1000)
```

---

## 4. Verification & Testing Plan

1. **Unit Tests (`test/concurrent/strategies.test.js`)**:
   - Test each strategy module (`weighted`, `round-robin`, `least-used`) directly.
   - Test `strategies/index.js` factory fallback for unknown strategy names.
2. **Unit Tests (`test/concurrent/account_scheduler.test.js`)**:
   - Test `getSchedulingStrategy` resolution hierarchy (model override > global config > default).
   - Test `getNextAuthIndex` under `round-robin` and `least-used` strategies.
   - Verify all 72 existing concurrent unit tests continue to pass.
3. **ESLint**:
   - `npx eslint src/concurrent/ test/concurrent/` (0 errors).
