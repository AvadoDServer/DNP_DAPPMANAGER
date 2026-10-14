const docker = require("modules/docker");

// Time for registerHandler to write this action to the activity log
// (userActionLogs) and for the reply to reach the UI before the host goes
// down
const REBOOT_DELAY_MS = 2000;

/**
 * Reboots the host. Logged as a user action, so the activity log tells an
 * owner's reboot from a power loss or a crash (the Admin's diagnostics
 * report reads it).
 */
const rebootHost = async () => {
  // Not awaited: the command is killed by the reboot it triggers, so it
  // always "fails".
  setTimeout(() => {
    docker.rebootHost().catch(() => {});
  }, REBOOT_DELAY_MS);

  return {
    message: `rebooting host - please reconnect after restart`,
    logMessage: true,
    userAction: true
  };
};

rebootHost.REBOOT_DELAY_MS = REBOOT_DELAY_MS;

module.exports = rebootHost;
