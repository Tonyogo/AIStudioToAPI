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
