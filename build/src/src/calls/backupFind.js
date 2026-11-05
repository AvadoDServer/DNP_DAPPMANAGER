const backup = require("modules/backup");

/**
 * The backups on a USB disk or NAS folder, of this AVADO and of others
 * (dates, apps, sizes, from the plain list next to each backup). Needs no
 * passphrase and opens nothing.
 * @param {object} [target] as for backupSetup; the set-up place when left out
 */
const backupFind = async ({ target } = {}) => ({ message: "Backups found", result: await backup.find({ target }) });

module.exports = backupFind;
