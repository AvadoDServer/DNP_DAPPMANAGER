const backup = require("modules/backup");

/**
 * Disks plugged into the AVADO that can hold backups (USB disks and sticks,
 * or a disk labelled AVADO…). The box's own disk is never listed.
 * @returns {object} result: { disks: [{ id, name, model, size, fsName, usable, reason }] }
 */
const backupTargets = async () => ({ message: "Backup disks", result: await backup.listTargets() });

module.exports = backupTargets;
