const fs = require("fs");
const { promisify } = require("util");
const params = require("params");
const logSafeObjects = require("utils/logSafeObjects");

/**
 * Returns the user action logs. This logs are stored in a different
 * file and format, and are meant to ease user support
 * The list is ordered from newest to oldest
 * - Newest log has index = 0
 * - If the param fromLog is out of bounds, the result will be an empty array: []
 *
 * @param {number} fromLog, default value = 0
 * @param {number} numLogs, default value = 50
 * @returns {string} logs, stringified userActionLog JSON objects appended on new lines
 * To parse, by newline and then parse each line individually.
 * userActionLog = {
 *   level: "info" | "error", {string}
 *   event: "installPackage.dnp.dappnode.eth", {string}
 *   message: "Successfully install DNP", {string} Returned message from the call function
 *   result: { data: "contents" }, {*} Returned result from the call function
 *   kwargs: { id: "dnpName" }, {object} RPC key-word arguments
 *   // Only if error
 *   message: e.message, {string}
 *   stack.e.stack {string}
 * }
 */

const getUserActionLogs = async ({ fromLog = 0, numLogs = 50 }) => {
  const { userActionLogsFilename } = params;

  if (!fs.existsSync(userActionLogsFilename)) {
    return {
      message: "userActionLogs are empty, returning an empty string",
      result: ""
    };
  }

  const userActionLogs = await promisify(fs.readFile)(userActionLogsFilename, {
    encoding: "utf8"
  });

  /**
   * The userActionLogs file can grow a lot. Only a part of it will be returned
   * The client can specify which part of the file wants
   * - reverse the array so the 0 index corresponds to the latest log
   * - do not parse the logs to save resources
   */
  const userActionLogsSelected = (userActionLogs || "")
    .split(/\r?\n/)
    .reverse()
    .slice(fromLog, fromLog + numLogs)
    .map(hideOldSecrets)
    .join("\n");

  return {
    message: "Got userActionLogs",
    result: userActionLogsSelected
  };
};

/**
 * Lines written before 10.0.57 can hold env values (installPackage's
 * userSetEnvs, updatePackageEnv's envs) and secrets: hide them in what is
 * returned, as new lines are hidden when written. A line that is not JSON
 * is returned as it is.
 *
 * @param {string} line one stringified userActionLog
 * @returns {string}
 */
function hideOldSecrets(line) {
  if (!line || line[0] !== "{") return line;
  let log;
  try {
    log = JSON.parse(line);
  } catch (e) {
    return line;
  }
  const kwargs = logSafeObjects(log.kwargs);
  const result = logSafeObjects(log.result);
  if (kwargs === log.kwargs && result === log.result) return line;
  const safe = Object.assign({}, log);
  if (kwargs !== undefined) safe.kwargs = kwargs;
  if (result !== undefined) safe.result = result;
  return JSON.stringify(safe);
}

module.exports = getUserActionLogs;
