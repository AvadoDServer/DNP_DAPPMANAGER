const backup = require("modules/backup");

/**
 * Every week on/off, and per app whether it is backed up and whether its
 * large items (photo libraries) are.
 * @param {boolean} weekly
 * @param {object} apps { "<name>": { included, includeLarge } }
 */
const backupOptions = async ({ weekly, apps } = {}) => {
  const result = await backup.setOptions({ weekly, apps });
  return { message: "Backup options saved", result, logMessage: true, userAction: true };
};

module.exports = backupOptions;
