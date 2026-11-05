const backup = require("modules/backup");

/**
 * Backups: whether they are set up, where they go, every week on/off, the
 * apps and what of each is backed up, the last backup and restore, and the
 * running job with its progress. Never returns the passphrase. Not a user
 * action (the Admin asks every few seconds while a job runs).
 */
const backupStatus = async () => ({ message: "Backup status", result: await backup.status() });

module.exports = backupStatus;
