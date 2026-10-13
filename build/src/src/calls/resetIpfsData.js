const fs = require("fs");
const getPath = require("utils/getPath");
const params = require("params");
const docker = require("modules/docker");
const dockerList = require("modules/dockerList");
const operations = require("modules/operations");
const ipfsNode = require("modules/ipfsNode");
const shell = require("utils/shell");
const logUi = require("utils/logUi");
const logs = require("logs.js")(module);
const { eventBus, eventBusTag } = require("eventBus");

const { IPFS_ID, CONTAINER, DATA_MOUNT, DATA_VOLUME_REGEX } = ipfsNode;

const MEASURE_TIMEOUT = 30 * 60 * 1000;
const EMPTY_TIMEOUT = 60 * 60 * 1000;
const START_WAIT = 120 * 1000;

const NOT_STARTED =
  "IPFS storage was emptied but IPFS did not start again. Restart your AVADO or contact AVADO support.";

// Why another operation blocks the reset, in plain words
const BUSY = {
  installPackage: "An app is being installed or updated.",
  resetBeaconData: "Free up space is running on a consensus client.",
  recoverLostData: "Data is being recovered for an app."
};

const assertVolume = volume => {
  if (!DATA_VOLUME_REGEX.test(volume || "")) throw Error("unexpected volume name");
};

// Every busybox run gets a name: when the shell times out only the docker
// client is killed, and the container is then removed by name.
const sizeCommand = (name, volume) => {
  assertVolume(volume);
  return `docker run --rm --name ${name} -v ${volume}:/v:ro busybox du -sk /v`;
};
// Deletes every entry of the volume root, hidden ones included, and keeps
// the volume itself (its name, and the compose project it belongs to).
// A pattern that matches nothing stays literal; rm -f ignores it.
const emptyCommand = (name, volume) => {
  assertVolume(volume);
  return `docker run --rm --name ${name} -v ${volume}:/v busybox sh -c 'rm -rf /v/* /v/.[!.]* /v/..?*'`;
};
// Prints what is left in the volume root (nothing once it is empty)
const leftCommand = (name, volume) => {
  assertVolume(volume);
  return `docker run --rm --name ${name} -v ${volume}:/v:ro busybox ls -A /v`;
};

let seq = 0;
const runName = kind => `ipfs-reset-${kind}-${Date.now()}-${++seq}`;

async function runNamed(kind, build, volume, timeout) {
  const name = runName(kind);
  try {
    return await shell(build(name, volume), { timeout });
  } catch (e) {
    await shell(`docker rm -f ${name}`).catch(() => {});
    throw e;
  }
}

const formatKb = kb => {
  if (!kb) return "0 GB";
  const gb = (kb * 1024) / 1e9;
  if (gb < 0.1) return `${Math.max(Math.round((kb * 1024) / 1e6), 1)} MB`;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
};

/**
 * Empties the IPFS core package's data volume and starts IPFS on a new,
 * empty repo. For a box whose IPFS keeps restarting because its repo is
 * damaged (often after a sudden power loss): with IPFS down nothing can be
 * installed or updated.
 *
 * Deleted: only the contents of the IPFS data volume (the downloaded
 * package files IPFS caches, its pins and its peer identity). Kept: the
 * volume itself, the IPFS export volume, every package and its data.
 *
 * Refused while an install or update, a beacon reset, a lost-data recovery
 * or another IPFS reset runs (modules/operations); installs are refused
 * while it runs. Safe to call again after a failure.
 *
 * @returns {object} result: { removedKb, restarted, peersConnected,
 *   storePeersConnected }
 *   removedKb: size of what was deleted (null when it could not be measured)
 *   restarted: IPFS answered within 2 minutes of being started again
 *   peersConnected: IPFS peers at the end (null when unknown)
 *   storePeersConnected: AVADO store nodes connected (params.IPFS_STORE_PEERS)
 */
const resetIpfsData = async () => {
  if (operations.isRunning("resetIpfsData")) {
    throw Error("Resetting the IPFS storage is already running.");
  }
  const busy = operations.list().find(op => BUSY[op.kind]);
  if (busy) {
    throw Error(`${BUSY[busy.kind]} Try again when it is done. Nothing was changed.`);
  }
  return operations.track("resetIpfsData", IPFS_ID, reset);
};

async function reset() {
  const log = message => logUi({ id: IPFS_ID, name: IPFS_ID, message });

  // 1. The container, its data volume and its compose file
  const dnp = ((await dockerList.listContainers()) || []).find(
    c => c.name === IPFS_ID && c.isCore
  );
  if (!dnp) {
    throw Error("IPFS is not installed on this AVADO, so there is nothing to reset. Nothing was changed.");
  }
  const mounts = (dnp.volumes || []).filter(
    v => v.type === "volume" && v.mountPath === DATA_MOUNT
  );
  if (mounts.length !== 1 || !DATA_VOLUME_REGEX.test(mounts[0].name || "")) {
    throw Error("IPFS does not store its data in the way this tool expects. Nothing was changed.");
  }
  const volume = mounts[0].name;
  const dcPath = getPath.dockerCompose(IPFS_ID, params, true);
  if (!fs.existsSync(dcPath)) {
    throw Error("IPFS is missing its configuration. Nothing was changed.");
  }

  // 2.-3. Stop, measure, empty. Once the stop has been sent, IPFS is always
  // started again, and a failed start never hides the error before it.
  let error = null;
  let removedKb = null;
  try {
    log("Stopping IPFS");
    try {
      await docker.compose.stop(dcPath, { timeout: 300 });
      // Only this container; never `compose down` (it can remove networks)
      await shell(`docker rm -f ${CONTAINER}`, { timeout: 5 * 60 * 1000 });
    } catch (e) {
      logs.error(`resetIpfsData: stop failed: ${e.message}`);
      throw Error("IPFS could not be stopped. Nothing was deleted; IPFS is being started again.");
    }

    log("Measuring the IPFS storage");
    try {
      const out = await runNamed("du", sizeCommand, volume, MEASURE_TIMEOUT);
      const kb = parseInt(String(out).trim().split(/\s+/)[0], 10);
      removedKb = Number.isFinite(kb) ? kb : null;
    } catch (e) {
      logs.warn(`resetIpfsData: could not measure ${volume}: ${e.message}`);
    }

    log("Deleting the IPFS storage");
    try {
      await runNamed("rm", emptyCommand, volume, EMPTY_TIMEOUT);
    } catch (e) {
      logs.error(`resetIpfsData: emptying ${volume} failed: ${e.message}`);
      throw Error("Deleting the IPFS storage failed. IPFS is being started again.");
    }
    let left;
    try {
      left = await runNamed("ls", leftCommand, volume, MEASURE_TIMEOUT);
    } catch (e) {
      logs.error(`resetIpfsData: checking ${volume} failed: ${e.message}`);
      throw Error("Could not check the IPFS storage after deleting it. IPFS is being started again.");
    }
    if (String(left || "").trim()) {
      logs.error(`resetIpfsData: left in ${volume}: ${String(left).trim().split("\n").slice(0, 5).join(", ")}`);
      throw Error("Some of the IPFS storage could not be deleted. IPFS is being started again.");
    }
    logs.info(`resetIpfsData: emptied ${volume}, ${removedKb === null ? "size unknown" : `${removedKb} KB`}`);
  } catch (e) {
    error = e;
  }

  // 4. Start, wait for the API, reconnect to the store nodes
  log("Starting IPFS");
  let startError = null;
  let restarted = false;
  let peersConnected = null;
  let storePeersConnected = 0;
  try {
    await docker.compose.up(dcPath);
  } catch (e) {
    logs.error(`resetIpfsData: start failed: ${e.message}`);
    startError = e;
  }
  if (!startError) {
    restarted = await ipfsNode.waitForApi(START_WAIT);
    if (restarted) {
      log("Connecting to the AVADO store");
      storePeersConnected = await ipfsNode.connectStorePeers();
      peersConnected = await ipfsNode.countPeers();
    } else {
      const after = ((await dockerList.listContainers().catch(() => [])) || []).find(
        c => c.name === IPFS_ID
      );
      // Not there or exited: it did not start. Running: still starting.
      if (!after || !after.running) startError = Error("IPFS is not running");
      logs.warn(`resetIpfsData: IPFS did not answer within ${START_WAIT / 1000} s (state ${after ? after.state : "missing"})`);
    }
  }
  eventBus.emit(eventBusTag.emitPackages);

  if (error && startError) {
    const before = error.message
      .replace(/\s*IPFS is being started again\.$/, "")
      .replace(/;$/, ".");
    throw Error(`${before} IPFS did not start again. Restart your AVADO or contact AVADO support.`);
  }
  if (error) throw error;
  if (startError) throw Error(NOT_STARTED);

  const deleted =
    removedKb === null
      ? "Deleted the IPFS storage."
      : `Deleted ${formatKb(removedKb)} of IPFS storage.`;
  return {
    message: restarted
      ? `${deleted} IPFS is running again.`
      : `${deleted} IPFS is still starting.`,
    result: { removedKb, restarted, peersConnected, storePeersConnected },
    logMessage: true,
    userAction: true
  };
}

module.exports = resetIpfsData;
module.exports.sizeCommand = sizeCommand;
module.exports.emptyCommand = emptyCommand;
module.exports.leftCommand = leftCommand;
