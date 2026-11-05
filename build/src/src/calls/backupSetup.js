const backup = require("modules/backup");

/**
 * Sets where the backups go and the passphrase that encrypts them, and opens
 * (or makes) the backup there. The passphrase is never logged (registerHandler
 * hides it) and never returned.
 *
 * @param {object} target { type: "usb", id } (id from backupTargets) or
 *   { type: "smb", host, share, folder, username, password, domain }
 * @param {string} passphrase at least 10 characters
 * @param {boolean} weekly back up every week
 */
const backupSetup = async ({ target, passphrase, weekly } = {}) => {
  const result = await backup.setup({ target, passphrase, weekly });
  return { message: "Backups set up", result, logMessage: true, userAction: true };
};

module.exports = backupSetup;
