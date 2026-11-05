const backup = require("modules/backup");
const logs = require("logs.js")(module);

/**
 * "Every week": once an hour, back up when the last good backup is a week
 * old (or there is none) and the backup disk or NAS is there. When the disk
 * is missing it tries again an hour later; the Admin shows the note.
 * At start: unpause apps and remove helpers a DAPPMANAGER restart left.
 */
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

async function tick({ now = Date.now(), status = backup.status, start = backup.startBackup, setNote } = {}) {
  const s = await status();
  if (!s.setUp || !s.weekly || (s.job && !s.job.done)) return "skip";
  const last = s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : 0;
  if (now - last < WEEK - HOUR) return "notYet";
  try {
    await start({ reason: "weekly" });
    return "started";
  } catch (e) {
    if (setNote) setNote(e.message);
    logs.info(`weekly backup not started: ${e.message}`);
    return "failed";
  }
}

if (process.env.TEST !== "true") {
  setTimeout(() => {
    backup.cleanupAfterRestart().catch(e => logs.warn(`backup cleanup: ${e.message}`));
  }, 5 * 1000);
  setTimeout(function loop() {
    tick({ setNote: backup.setWeeklyNote }).catch(e => logs.warn(`weekly backup: ${e.message}`));
    setTimeout(loop, HOUR);
  }, 10 * 60 * 1000);
}

module.exports = { tick };
