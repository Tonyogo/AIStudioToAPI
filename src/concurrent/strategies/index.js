const weighted = require("./weighted");
const roundRobin = require("./round-robin");
const leastUsed = require("./least-used");

const STRATEGIES = {
    "least-used": leastUsed,
    "round-robin": roundRobin,
    weighted,
};

function selectCandidate(strategyName, candidates, context = {}) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const strategyKey = typeof strategyName === "string" ? strategyName.trim().toLowerCase() : "weighted";
    const strategyFn = STRATEGIES[strategyKey] || STRATEGIES["weighted"];
    return strategyFn(candidates, context);
}

module.exports = {
    selectCandidate,
    STRATEGIES,
};
