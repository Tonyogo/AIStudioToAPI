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
