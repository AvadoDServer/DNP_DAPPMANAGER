const fs = require("fs");
const getPath = require("utils/getPath");
const params = require("params");
const docker = require("modules/docker");
const dockerList = require("modules/dockerList");
const shell = require("utils/shell");
const logUi = require("utils/logUi");
const logs = require("logs.js")(module);
const { eventBus, eventBusTag } = require("eventBus");

/**
 * Consensus clients whose beacon database can be deleted while every
 * validator file stays. Exact folder names, no heuristics. Every package has
 * ONE named volume mounted at /data with a settings.json holding `network`
 * and `initial_state` (the checkpoint sync URL).
 * Keep in sync with the Admin table (health/clients.js, canResetBeacon).
 */
const tekuLike = title => ({
  title,
  paths: net => [`data-${net}/beacon`]
});
const BEACON_DATA = {
  "teku.avado.dnp.dappnode.eth": tekuLike("Teku"),
  "teku-gnosis.avado.dnp.dappnode.eth": tekuLike("Teku Gnosis"),
  "teku-holesky.avado.dnp.dappnode.eth": tekuLike("Teku Holesky"),
  "teku-prater.avado.dnp.dappnode.eth": tekuLike("Teku Prater"),
  "lighthouse.avado.dnp.dappnode.eth": tekuLike("Lighthouse"),
  "lighthouse-gnosis.avado.dnp.dappnode.eth": tekuLike("Lighthouse Gnosis"),
  "lighthouse-holesky.avado.dnp.dappnode.eth": tekuLike("Lighthouse Holesky"),
  // startNimbus.sh runs trustedNodeSync only when the db directory is missing
  "nimbus.avado.dnp.dappnode.eth": {
    title: "Nimbus",
    paths: net => [`data-${net}/db`]
  },
  "nimbus-holesky.avado.dnp.dappnode.eth": {
    title: "Nimbus Holesky",
    paths: net => [`data-${net}/db`]
  },
  "nimbus-prater.avado.dnp.dappnode.eth": {
    title: "Nimbus Prater",
    paths: net => [`data-${net}/db`]
  },
  // Prysm's --datadir=/data holds no keys. data-columns is the PeerDAS
  // column store (Fulu, Prysm v7), chain data like blobs.
  "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth": {
    title: "Prysm",
    paths: () => ["beaconchaindata", "blobs", "data-columns"]
  }
};

const HOUR = 60 * 60 * 1000;
const VOLUME_REGEX = /^[A-Za-z0-9_.-]+$/;
const NETWORK_REGEX = /^[a-z]+$/;

const dockerRun = (volume, readOnly, cmd) =>
  `docker run --rm -v ${volume}:/vol${readOnly ? ":ro" : ""} busybox ${cmd}`;
const quote = p => `'/vol/${p}'`;

function formatSize(bytes) {
  if (!bytes) return "0 GB";
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/**
 * Deletes ONLY the beacon database of a consensus client. Validator keys,
 * slashing protection and settings stay; the client resyncs from the
 * checkpoint sync URL in its settings.json.
 *
 * @param {string} id DNP .eth name, must be a key of BEACON_DATA
 */
const resetBeaconData = async ({ id }) => {
  const entry = BEACON_DATA[id];
  if (!id || !Object.prototype.hasOwnProperty.call(BEACON_DATA, id)) {
    throw Error(
      `${id} is not a consensus client this AVADO knows how to reset. Nothing was changed.`
    );
  }
  const { title } = entry;
  const log = message => logUi({ id, name: id, message });

  // 1. Find the container and its single named volume
  const dnpList = await dockerList.listContainers();
  const dnp = (dnpList || []).find(c => c.name === id);
  if (!dnp) {
    throw Error(`${title} is not installed. Nothing was changed.`);
  }
  const volumes = (dnp.volumes || []).filter(v => v.type === "volume");
  if (volumes.length !== 1 || !VOLUME_REGEX.test(volumes[0].name || "")) {
    throw Error(
      `${title} does not store its data in the way this tool expects. Nothing was changed.`
    );
  }
  const volume = volumes[0].name;

  // 2. Compose file must exist before we stop anything (cheap, so first)
  const dcPath = getPath.dockerComposeSmart(id, params);
  if (!fs.existsSync(dcPath)) {
    throw Error(`${title} is missing its configuration. Nothing was changed.`);
  }

  // 3. Read settings.json BEFORE touching anything
  log("Checking settings");
  let settings;
  try {
    const raw = await shell(
      dockerRun(volume, true, "cat /vol/settings.json"),
      { timeout: 5 * 60 * 1000 }
    );
    settings = JSON.parse(raw);
  } catch (e) {
    logs.error(`resetBeaconData ${id}: cannot read settings.json: ${e.message}`);
    throw Error(
      `Could not read the settings of ${title}. Nothing was changed.`
    );
  }
  if (!settings || typeof settings !== "object") {
    throw Error(
      `Could not read the settings of ${title}. Nothing was changed.`
    );
  }
  const initialState =
    typeof settings.initial_state === "string"
      ? settings.initial_state.trim()
      : "";
  if (!initialState) {
    throw Error(
      `${title} has no checkpoint sync address, so it would have to download the whole chain from the beginning (days). Nothing was deleted. Set a checkpoint sync address in its settings first.`
    );
  }
  const network = settings.network;
  if (typeof network !== "string" || !NETWORK_REGEX.test(network)) {
    throw Error(
      `The network of ${title} is not set correctly in its settings. Nothing was changed.`
    );
  }

  // 4. Which of the paths exist
  const paths = entry.paths(network);
  const existing = async () => {
    const out = await shell(
      dockerRun(
        volume,
        true,
        `sh -c 'ls -d ${paths.map(p => `/vol/${p}`).join(" ")} 2>/dev/null; true'`
      )
    );
    return out
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("/vol/"))
      .map(l => l.slice("/vol/".length))
      .filter(p => paths.includes(p));
  };
  const toDelete = await existing();
  if (toDelete.length === 0) {
    throw Error(
      `There is no beacon data to delete for ${title}. Nothing was changed.`
    );
  }

  // 5. Size (best effort; du over a big database takes a while)
  log("Measuring the beacon data");
  let freedBytes = 0;
  try {
    const out = await shell(
      dockerRun(volume, true, `du -sk ${toDelete.map(quote).join(" ")}`),
      { timeout: 30 * 60 * 1000 }
    );
    freedBytes = out
      .split("\n")
      .map(l => parseInt(l.trim().split(/\s+/)[0], 10))
      .filter(n => Number.isFinite(n))
      .reduce((a, b) => a + b * 1024, 0);
  } catch (e) {
    logs.warn(`resetBeaconData ${id}: could not measure size: ${e.message}`);
  }
  const sizeText = freedBytes ? `${formatSize(freedBytes)} of ` : "";

  // 6. Stop, delete, start. Once the stop has run, always start again, and
  // never let a failed start hide the error that came before it.
  log(`Stopping ${title}`);
  await docker.compose.stop(dcPath, { timeout: 300 });
  let error = null;
  try {
    await docker.compose.rm(dcPath);
    log(`Deleting ${sizeText}beacon data. This can take several minutes`);
    // The throwaway container gets a name: when the shell times out only the
    // docker client is killed, so the container is removed by name before the
    // client starts again on top of a delete that is still running.
    const rmName = `reset-beacon-${Date.now()}`;
    try {
      await shell(
        `docker run --rm --name ${rmName} -v ${volume}:/vol busybox rm -rf ${toDelete
          .map(quote)
          .join(" ")}`,
        { timeout: HOUR }
      );
    } catch (e) {
      logs.error(`resetBeaconData ${id}: delete failed: ${e.message}`);
      await shell(`docker rm -f ${rmName}`).catch(() => {});
      throw Error(
        `Deleting the beacon data of ${title} failed. ${title} is being started again.`
      );
    }
    let left;
    try {
      left = await existing();
    } catch (e) {
      logs.error(`resetBeaconData ${id}: verify failed: ${e.message}`);
      throw Error(
        `Could not check the beacon data of ${title} after deleting it. ${title} is being started again.`
      );
    }
    if (left.length > 0) {
      throw Error(
        `Some beacon data of ${title} could not be deleted. ${title} is being started again.`
      );
    }
  } catch (e) {
    error = e;
  }

  log(`Starting ${title}`);
  let startError = null;
  try {
    // docker.safe.compose.up swallows most errors, so check the container
    await docker.safe.compose.up(dcPath);
    const after = (await dockerList.listContainers()) || [];
    const started = after.find(c => c.name === id);
    if (!started || !started.running) {
      startError = Error(`${title} did not start. Open it in My DApps and press Start.`);
    }
  } catch (e) {
    logs.error(`resetBeaconData ${id}: start failed: ${e.message}`);
    startError = Error(`${title} did not start. Open it in My DApps and press Start.`);
  }
  eventBus.emit(eventBusTag.emitPackages);

  if (error && startError) {
    throw Error(`${error.message.replace(/ is being started again\.$/, ".")} ${startError.message}`);
  }
  if (error) throw error;
  if (startError) {
    throw Error(`Deleted ${sizeText}beacon data from ${title}, but ${startError.message}`);
  }

  return {
    message: `Deleted ${sizeText}beacon data from ${title}. It is syncing again from its checkpoint.`,
    result: { deleted: toDelete, freedBytes },
    logMessage: true,
    userAction: true
  };
};

module.exports = resetBeaconData;
module.exports.BEACON_DATA = BEACON_DATA;
