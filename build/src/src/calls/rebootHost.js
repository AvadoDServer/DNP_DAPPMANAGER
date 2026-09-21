const docker = require("modules/docker");

/**
 * Reboots the host
 */
const rebootHost = async () => {
  // Not awaited: the reply must reach the UI before the host goes down. The
  // command is killed by the reboot it triggers, so it always "fails".
  docker.rebootHost().catch(() => {});

  return {
    message: `rebooting host - please reconnect after restart`
  };
};

module.exports = rebootHost;
