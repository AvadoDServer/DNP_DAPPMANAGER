const lostData = require("modules/lostData");

/**
 * Same scan as listLostData, for one package. Read-only.
 *
 * @param {string} id DNP .eth name
 * @returns {object} result: LostDataEntry, `candidates: []` when there are
 * none (also for core packages and packages that are not installed).
 * `recovered` lists volumes recoverLostData already copied from.
 */
const findLostData = async ({ id }) => {
  if (!id) throw Error("kwarg id must be defined");
  const entries = await lostData.scan({ id });
  const result = entries.find(e => e.package === id) || {
    package: id,
    live: [],
    candidates: [],
    recovered: []
  };
  return {
    message: result.candidates.length
      ? `Found data for ${id} in ${result.candidates.length} unused volume(s)`
      : `No data found for ${id} in unused volumes`,
    result
  };
};

module.exports = findLostData;
