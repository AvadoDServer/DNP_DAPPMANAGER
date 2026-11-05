const backup = require("modules/backup");

/**
 * Restores apps from a backup. The passphrase is checked first (a wrong one
 * is answered at once); then the apps are stopped, their current data is
 * moved aside (never deleted), the backup is put back and the apps start
 * again. Apps with validator keys stay stopped, and their keys are never
 * restored onto an app that has keys already or keys another app on this
 * AVADO runs.
 *
 * @param {object} target where the backup is
 * @param {string} repo backup id of the AVADO that made it
 * @param {string} run which backup
 * @param {string} passphrase
 * @param {Array<{ name, items }>} apps
 * @param {boolean} confirmValidators owner confirmed the old box is off or its keys removed
 */
const backupRestore = async (kwargs = {}) => {
  const result = await backup.startRestore(kwargs);
  return { message: "Restore started", result, logMessage: true, userAction: true };
};

module.exports = backupRestore;
