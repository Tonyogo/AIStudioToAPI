/**
 * Remaining capacity weighted random selection strategy
 * @param {Array<Object>} candidates - [{ idx, inFlight, order, usage }]
 * @param {Object} context - { limit }
 * @returns {Object|null}
 */
module.exports = function selectWeightedCandidate(candidates, context = {}) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const limit = typeof context?.limit === "number" ? context.limit : 100;
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
