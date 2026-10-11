const lostData = require("modules/lostData");

/**
 * Scans every installed non-core package for data in Docker volumes that no
 * container uses (see modules/lostData). Read-only. Only name-matched
 * candidates (confidence "high").
 *
 * @returns {object} result: LostDataEntry[], only packages with candidates
 * LostDataEntry = { package, title, live: [{ name, mountPath }],
 *   candidates: [{ name, anonymous, confidence, createdAt, entries, sizeKb,
 *   target }],
 *   recovered: [{ volume, at }] }
 */
const listLostData = async () => {
  // Anonymous volumes (confidence "low") are never a Home finding: they are
  // only shown on the package page (findLostData)
  const entries = await lostData.scan({ includeAnonymous: false });
  const result = entries
    .map(e =>
      Object.assign({}, e, {
        candidates: e.candidates.filter(c => c.confidence === "high")
      })
    )
    .filter(e => e.candidates.length > 0);
  return {
    message: result.length
      ? `Found data in unused volumes for ${result.length} package(s)`
      : "No data found in unused volumes",
    result
  };
};

module.exports = listLostData;
