const backup = require("modules/backup");

/**
 * Starts a backup now. Answers once it has started; backupStatus shows the
 * progress and the result.
 */
const backupNow = async () => {
  const result = await backup.startBackup({ reason: "now" });
  return { message: "Backup started", result, logMessage: true, userAction: true };
};

module.exports = backupNow;
