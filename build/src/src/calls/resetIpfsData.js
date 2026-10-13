const fs = require("fs");
const path = require("path");
const db = require("db");
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

const { IPFS_ID, DATA_MOUNT, DATA_VOLUME_REGEX } = ipfsNode;

// Measuring is best effort and the confirm promises "a few minutes"
const MEASURE_TIMEOUT = 5 * 60 * 1000;
const CHECK_TIMEOUT = 5 * 60 * 1000;
const EMPTY_TIMEOUT = 60 * 60 * 1000;
const START_WAIT = 120 * 1000;

// db key, set while a reset runs: a DAPPMANAGER that starts and finds it
// set was stopped in the middle of one (recoverInterruptedReset)
const RUNNING_KEY = "ipfsResetRunning";
// start_ipfs (AVADO-DNP-ipfs) wipes the repo and runs `ipfs init` when this
// file is missing, so deleting it first makes any interrupted reset end in
// a clean new repo on the next start
const MARKER = "/v/migrate3";

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
// Deletes only the init marker: from here on IPFS starts on a new repo
const markerCommand = (name, volume) => {
  assertVolume(volume);
  return `docker run --rm --name ${name} -v ${volume}:/v busybox rm -f ${MARKER}`;
};
// Deletes every entry of the volume root, hidden ones included (the marker
// first), and keeps the volume itself (its name, and the compose project it
// belongs to). A pattern that matches nothing stays literal; rm -f ignores it.
const emptyCommand = (name, volume) => {
  assertVolume(volume);
  return `docker run --rm --name ${name} -v ${volume}:/v busybox sh -c 'rm -f ${MARKER}; rm -rf /v/* /v/.[!.]* /v/..?*'`;
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

// The data volume compose uses for IPFS: <project>_ipfsdnpdappnodeeth_data,
// with the project named the way modules/docker names it (legacy v1 rule)
const expectedVolume = dcPath =>
  `${path
    .basename(path.dirname(path.resolve(dcPath)))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}_ipfsdnpdappnodeeth_data`;

async function volumeExists(volume) {
  try {
    const out = await shell(`docker volume inspect --format '{{.Name}}' ${volume}`, {
      timeout: 60 * 1000
    });
    return String(out).trim() === volume;
  } catch (e) {
    if (/no such volume/i.test(`${e.message} ${e.stderr || ""}`)) return false;
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

  // 1. The compose file, the container (it can be missing, e.g. after an
  // interrupted update) and its data volume
  const dcPath = getPath.dockerCompose(IPFS_ID, params, true);
  if (!fs.existsSync(dcPath)) {
    throw Error("IPFS is missing its configuration. Nothing was changed.");
  }
  const dnp = ((await dockerList.listContainers()) || []).find(
    c => c.name === IPFS_ID && c.isCore
  );
  let volume;
  if (dnp) {
    const mounts = (dnp.volumes || []).filter(
      v => v.type === "volume" && v.mountPath === DATA_MOUNT
    );
    if (mounts.length !== 1 || !DATA_VOLUME_REGEX.test(mounts[0].name || "")) {
      throw Error("IPFS does not store its data in the way this tool expects. Nothing was changed.");
    }
    volume = mounts[0].name;
  } else {
    volume = expectedVolume(dcPath);
    if (!DATA_VOLUME_REGEX.test(volume)) {
      throw Error("IPFS does not store its data in the way this tool expects. Nothing was changed.");
    }
    let found;
    try {
      found = await volumeExists(volume);
    } catch (e) {
      logs.error(`resetIpfsData: cannot check ${volume}: ${e.message}`);
      throw Error("Could not check the IPFS storage. Nothing was changed.");
    }
    if (!found) volume = null;
    logs.warn(`resetIpfsData: no IPFS container; ${volume ? `emptying ${volume}` : "no data volume either"}, then starting it`);
  }

  // Remembered until IPFS has been started again (recoverInterruptedReset).
  // Without it an interrupted reset could leave IPFS stopped: no reset then.
  try {
    await db.set(RUNNING_KEY, { at: new Date().toISOString() });
  } catch (e) {
    logs.error(`resetIpfsData: cannot write ${RUNNING_KEY}: ${e.message}`);
    throw Error("Could not prepare the reset. Nothing was changed.");
  }

  // 2.-3. Stop, delete the init marker, measure, empty. The container is
  // stopped, never removed: a stopped restart:always container comes back
  // when Docker starts, so a power cut leaves IPFS in place. Once the stop
  // has been sent IPFS is always started again, and a failed start never
  // hides the error before it.
  let error = null;
  let removedKb = null;
  try {
    if (dnp) {
      log("Stopping IPFS");
      try {
        await docker.compose.stop(dcPath, { timeout: 300 });
      } catch (e) {
        logs.error(`resetIpfsData: stop failed: ${e.message}`);
        throw Error("IPFS could not be stopped. Nothing was deleted; IPFS is being started again.");
      }
    }

    if (volume) {
      log("Deleting the IPFS storage");
      try {
        await runNamed("marker", markerCommand, volume, CHECK_TIMEOUT);
      } catch (e) {
        logs.error(`resetIpfsData: deleting ${MARKER} in ${volume} failed: ${e.message}`);
        throw Error("Deleting the IPFS storage failed. IPFS is being started again.");
      }

      try {
        const out = await runNamed("du", sizeCommand, volume, MEASURE_TIMEOUT);
        const kb = parseInt(String(out).trim().split(/\s+/)[0], 10);
        removedKb = Number.isFinite(kb) ? kb : null;
      } catch (e) {
        logs.warn(`resetIpfsData: could not measure ${volume}: ${e.message}`);
      }

      try {
        await runNamed("rm", emptyCommand, volume, EMPTY_TIMEOUT);
      } catch (e) {
        logs.error(`resetIpfsData: emptying ${volume} failed: ${e.message}`);
        throw Error("Deleting the IPFS storage failed. IPFS is being started again.");
      }
      let left;
      try {
        left = await runNamed("ls", leftCommand, volume, CHECK_TIMEOUT);
      } catch (e) {
        logs.error(`resetIpfsData: checking ${volume} failed: ${e.message}`);
        throw Error("Could not check the IPFS storage after deleting it. IPFS is being started again.");
      }
      if (String(left || "").trim()) {
        logs.error(`resetIpfsData: left in ${volume}: ${String(left).trim().split("\n").slice(0, 5).join(", ")}`);
        throw Error("Some of the IPFS storage could not be deleted. IPFS is being started again.");
      }
      logs.info(`resetIpfsData: emptied ${volume}, ${removedKb === null ? "size unknown" : `${removedKb} KB`}`);
    }
  } catch (e) {
    error = e;
  }

  // 4. Start (up -d starts the stopped container, or creates a missing
  // one), wait for the API, reconnect to the store nodes
  log("Starting IPFS");
  const started = await startAndWait(log);
  await db.remove(RUNNING_KEY).catch(e =>
    logs.warn(`resetIpfsData: cannot clear ${RUNNING_KEY}: ${e.message}`)
  );
  eventBus.emit(eventBusTag.emitPackages);
  const startError = started.error;
  const { restarted, peersConnected, storePeersConnected } = started;

  if (error && startError) {
    const before = error.message
      .replace(/\s*IPFS is being started again\.$/, "")
      .replace(/;$/, ".");
    throw Error(`${before} IPFS did not start again. Restart your AVADO or contact AVADO support.`);
  }
  if (error) throw error;
  if (startError) throw Error(NOT_STARTED);

  const deleted = !volume
    ? "IPFS was set up again."
    : removedKb === null
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

/**
 * compose up -d, then up to 2 minutes for the API. IPFS counts as started
 * only when its container is in state "running" afterwards (not
 * "restarting" or "created", which dockerList also calls running).
 * @returns {Promise<{ error, restarted, peersConnected, storePeersConnected }>}
 */
async function startAndWait(log = () => {}) {
  const res = { error: null, restarted: false, peersConnected: null, storePeersConnected: 0 };
  const dcPath = getPath.dockerCompose(IPFS_ID, params, true);
  try {
    await docker.compose.up(dcPath);
  } catch (e) {
    logs.error(`resetIpfsData: start failed: ${e.message}`);
    res.error = e;
    return res;
  }
  const answered = await ipfsNode.waitForApi(START_WAIT);
  const after = ((await dockerList.listContainers().catch(() => [])) || []).find(
    c => c.name === IPFS_ID
  );
  const state = after ? after.state : "missing";
  if (state !== "running") {
    logs.error(`resetIpfsData: IPFS is not running after the start (state ${state})`);
    res.error = Error(`IPFS is ${state}`);
    return res;
  }
  if (!answered) {
    logs.warn(`resetIpfsData: IPFS did not answer within ${START_WAIT / 1000} s`);
    return res;
  }
  res.restarted = true;
  log("Connecting to the AVADO store");
  res.storePeersConnected = await ipfsNode.connectStorePeers();
  res.peersConnected = await ipfsNode.countPeers();
  return res;
}

/**
 * At DAPPMANAGER start: a reset that this process's predecessor did not
 * finish (it was restarted, or updated, in the middle) left IPFS stopped,
 * and a stopped container is not started again by its restart policy until
 * Docker itself restarts. Removes any busybox of that reset still running
 * and starts IPFS. The init marker was deleted first, so IPFS sets up a new
 * repo by itself.
 */
async function recoverInterruptedReset() {
  let pending;
  try {
    pending = await db.get(RUNNING_KEY);
  } catch (e) {
    logs.warn(`resetIpfsData: cannot read ${RUNNING_KEY}: ${e.message}`);
    return false;
  }
  if (!pending) return false;
  logs.warn(`resetIpfsData: a reset started ${pending.at || "earlier"} did not finish; starting IPFS`);
  try {
    const ids = String(await shell("docker ps -aq --filter name=ipfs-reset-"))
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^[0-9a-f]+$/.test(l));
    if (ids.length) await shell(`docker rm -f ${ids.join(" ")}`);
  } catch (e) {
    logs.warn(`resetIpfsData: cannot remove leftover reset containers: ${e.message}`);
  }
  const started = await operations.track("resetIpfsData", IPFS_ID, () => startAndWait());
  if (started.error) logs.error(`resetIpfsData: IPFS did not start after an interrupted reset`);
  await db.remove(RUNNING_KEY).catch(() => {});
  eventBus.emit(eventBusTag.emitPackages);
  return true;
}

module.exports = resetIpfsData;
module.exports.sizeCommand = sizeCommand;
module.exports.emptyCommand = emptyCommand;
module.exports.leftCommand = leftCommand;
module.exports.markerCommand = markerCommand;
module.exports.recoverInterruptedReset = recoverInterruptedReset;
module.exports.RUNNING_KEY = RUNNING_KEY;
