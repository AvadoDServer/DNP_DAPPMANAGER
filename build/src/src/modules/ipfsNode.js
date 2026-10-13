const axios = require("axios");
const params = require("params");
const shell = require("utils/shell");
const logs = require("logs.js")(module);

/**
 * The IPFS core package as a container: its state for the Admin's health
 * check (getIpfsHealth) and the HTTP API helpers resetIpfsData uses once IPFS
 * is started again.
 *
 * The package (AVADO-DNP-ipfs, build/start_ipfs) initialises a new repo by
 * itself when /data/ipfs holds no `migrate3` marker, and applies its config
 * (API and gateway addresses, routing, connection manager, StorageMax,
 * profile) on every start. A new repo has a new peer id, no pins and the
 * default bootstrap list; the DAPPMANAGER pins again what it downloads.
 */

const IPFS_ID = "ipfs.dnp.dappnode.eth";
const CONTAINER = `${params.CONTAINER_CORE_NAME_PREFIX}${IPFS_ID}`;
const DATA_MOUNT = "/data/ipfs";
// The data volume as compose names it: dncore_ipfsdnpdappnodeeth_data. The
// export volume (…_export) never matches.
const DATA_VOLUME_REGEX = /^[a-z0-9]+_ipfsdnpdappnodeeth_data$/;

const HOUR = 60 * 60 * 1000;
const LOG_LINES = 10;
const LOG_LINE_MAX = 300;

const apiUrl = path => `http://${params.IPFS}:5001/api/v0/${path}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * POST to the IPFS HTTP API (kubo only answers POST)
 * @returns {Promise<object>} the parsed answer
 */
async function api(path, timeout = 10 * 1000) {
  const res = await axios.post(apiUrl(path), null, { timeout });
  return res.data;
}

/**
 * Waits until the IPFS API answers `id`, for at most `limitMs`
 * @returns {Promise<boolean>} true once it answered
 */
async function waitForApi(limitMs = 120 * 1000, everyMs = 3000) {
  const until = Date.now() + limitMs;
  for (;;) {
    try {
      const id = await api("id", 5000);
      if (id && id.ID) return true;
    } catch (e) {
      // not up yet
    }
    if (Date.now() + everyMs > until) return false;
    await sleep(everyMs);
  }
}

/**
 * Connects to the AVADO nodes that hold the store's packages
 * (params.IPFS_STORE_PEERS). Without this a new repo finds them through the
 * DHT only, which can take hours for a fresh hash. Best effort.
 * @returns {Promise<number>} how many answered
 */
async function connectStorePeers() {
  let connected = 0;
  for (const addr of params.IPFS_STORE_PEERS || []) {
    try {
      await api(`swarm/connect?arg=${encodeURIComponent(addr)}`, 20 * 1000);
      connected++;
    } catch (e) {
      logs.warn(`ipfsNode: cannot connect to ${addr}: ${e.message}`);
    }
  }
  return connected;
}

/**
 * @returns {Promise<number|null>} peers IPFS is connected to, null when unknown
 */
async function countPeers() {
  try {
    const res = await api("swarm/peers", 10 * 1000);
    return Array.isArray(res && res.Peers) ? res.Peers.length : 0;
  } catch (e) {
    logs.warn(`ipfsNode: cannot list peers: ${e.message}`);
    return null;
  }
}

// Docker's RestartCount, sampled on every readHealth: { at, containerId, restartCount }
let samples = [];
// When readHealth first found no IPFS container (ms), null while there is one.
// An update or a restart of IPFS leaves it absent for a few seconds; the
// Admin only reports it missing once this is old enough.
let missingSince = null;

/**
 * Restarts in the last hour, from the samples of the same container (a new
 * container starts counting at 0 again). 0 until a second sample exists.
 */
function restartsLastHour(containerId, restartCount, now) {
  samples = samples.filter(s => now - s.at <= HOUR);
  samples.push({ at: now, containerId, restartCount });
  const same = samples.filter(s => s.containerId === containerId);
  const oldest = Math.min(...same.map(s => s.restartCount));
  return Math.max(restartCount - oldest, 0);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const logLines = out =>
  String(out || "")
    .split("\n")
    .map(l => l.replace(ANSI, "").trim())
    .filter(Boolean)
    .slice(-LOG_LINES)
    .map(l => (l.length > LOG_LINE_MAX ? `${l.slice(0, LOG_LINE_MAX)}…` : l));

/**
 * The IPFS container's state. Cheap: one `docker inspect`, plus the last log
 * lines only when it is not healthy.
 * @returns {Promise<object>} { exists, running, restarting, restartCount,
 *   restartsLastHour, startedAt, lastLogLines, missingSince }
 *   missingSince: ISO date this process first found no container, null
 *   while there is one
 */
async function readHealth({ now = Date.now() } = {}) {
  let info;
  try {
    const out = await shell(`docker inspect ${CONTAINER}`, { timeout: 30 * 1000 });
    info = (JSON.parse(out) || [])[0];
  } catch (e) {
    if (/no such (object|container)/i.test(`${e.message} ${e.stderr || ""}`)) {
      if (missingSince === null) missingSince = now;
      return {
        exists: false,
        missingSince: new Date(missingSince).toISOString(),
        running: false,
        restarting: false,
        restartCount: 0,
        restartsLastHour: 0,
        startedAt: null,
        lastLogLines: []
      };
    }
    throw e;
  }
  if (!info || !info.State) throw Error("Unexpected docker inspect output");
  missingSince = null;
  const state = info.State;
  const restartCount = Number(info.RestartCount) || 0;
  const restarting = state.Restarting === true || state.Status === "restarting";
  const running = state.Running === true && !restarting;
  const lastHour = restartsLastHour(info.Id, restartCount, now);
  let lastLogLines = [];
  if (restarting || !running || lastHour > 0) {
    try {
      lastLogLines = logLines(
        await shell(`docker logs --tail ${LOG_LINES} ${CONTAINER} 2>&1`, {
          timeout: 30 * 1000
        })
      );
    } catch (e) {
      logs.warn(`ipfsNode: cannot read logs: ${e.message}`);
    }
  }
  return {
    exists: true,
    running,
    restarting,
    restartCount,
    restartsLastHour: lastHour,
    startedAt: state.StartedAt || null,
    lastLogLines,
    missingSince: null
  };
}

// Tests only
function _resetSamples() {
  samples = [];
  missingSince = null;
}

module.exports = {
  IPFS_ID,
  CONTAINER,
  DATA_MOUNT,
  DATA_VOLUME_REGEX,
  api,
  waitForApi,
  connectStorePeers,
  countPeers,
  readHealth,
  logLines,
  _resetSamples
};
