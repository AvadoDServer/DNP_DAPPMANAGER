const ipfsNode = require("modules/ipfsNode");
const operations = require("modules/operations");

/**
 * State of the IPFS core container, for the Admin's "IPFS keeps restarting"
 * check (polled every few minutes). Read-only and cheap: one `docker
 * inspect`, plus `docker logs --tail 10` only when IPFS is not healthy.
 *
 * @returns {object} result: { exists, running, restarting, restartCount,
 *   restartsLastHour, startedAt, lastLogLines, missingSince, resetRunning }
 *   missingSince: ISO date this process first found no IPFS container,
 *     null while there is one (a restart or update of IPFS removes it for a
 *     few seconds)
 *   restartCount: Docker's count since the container was created
 *   restartsLastHour: counted from earlier calls of this DAPPMANAGER
 *     process (0 until a second call)
 *   lastLogLines: up to 10 trimmed lines, [] while IPFS is healthy
 *   resetRunning: resetIpfsData is running now
 */
const getIpfsHealth = async () => {
  const health = await ipfsNode.readHealth();
  const result = Object.assign({}, health, {
    resetRunning: operations.isRunning("resetIpfsData")
  });
  return {
    message: result.restarting
      ? "IPFS is restarting"
      : result.running
      ? "IPFS is running"
      : "IPFS is not running",
    result
  };
};

module.exports = getIpfsHealth;
