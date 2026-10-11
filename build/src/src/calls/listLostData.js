const lostData = require("modules/lostData");

/**
 * Scans every installed non-core package for data in Docker volumes that no
 * container uses (see modules/lostData). Read-only.
 *
 * @returns {object} result: LostDataEntry[], only packages with candidates
 * LostDataEntry = { package, title, live: [{ name, mountPath }],
 *   candidates: [{ name, anonymous, createdAt, entries, sizeKb, target }],
 *   recovered: [{ volume, at }] }
 */
const listLostData = async () => {
  const entries = await lostData.scan();
  const result = entries.filter(e => e.candidates.length > 0);
  return {
    message: result.length
      ? `Found data in unused volumes for ${result.length} package(s)`
      : "No data found in unused volumes",
    result
  };
};

module.exports = listLostData;
