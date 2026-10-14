const dns = require("dns");
const jayson = require("jayson");
const params = require("params");
const db = require("db");
const ipfs = require("modules/ipfs");
const ipfsNode = require("modules/ipfsNode");
const dockerList = require("modules/dockerList");
const http = require("./http");
const { scrub } = require("./scrub");
const { withTimeout, errorMessage } = require("./timeout");

/**
 * The path from this box to the internet and to the AVADO store, checked
 * from inside the DAPPMANAGER container.
 */

const DNS_NAMES = ["bo.ava.do", "iso.ava.do"];
const INTERNET_URLS = ["https://bo.ava.do/"];
const DNS_TIMEOUT = 5000;
const INTERNET_TIMEOUT = 5000;
const CATALOGUE_TIMEOUT = 8000;
const IPFS_API_TIMEOUT = 5000;

const since = t0 => Date.now() - t0;

async function timed(fn, ms) {
  const t0 = Date.now();
  try {
    const extra = await withTimeout(fn(), ms, `timed out after ${Math.round(ms / 1000)} s`);
    return Object.assign({ ok: true, ms: since(t0) }, extra || {});
  } catch (e) {
    return { ok: false, ms: since(t0), error: errorMessage(e) };
  }
}

/** { "bo.ava.do": { ok, ms, error? }, ... } */
async function checkDns() {
  const results = await Promise.all(
    DNS_NAMES.map(name => timed(() => dns.promises.lookup(name).then(() => null), DNS_TIMEOUT))
  );
  const resolves = {};
  DNS_NAMES.forEach((name, i) => (resolves[name] = results[i]));
  return { resolves };
}

/** { "https://bo.ava.do/": { ok, status, ms, error? } } */
async function checkInternet() {
  const results = await Promise.all(
    INTERNET_URLS.map(url =>
      timed(async () => ({ status: await http.head(url, INTERNET_TIMEOUT) }), INTERNET_TIMEOUT + 500)
    )
  );
  const out = {};
  INTERNET_URLS.forEach((url, i) => (out[url] = Object.assign({ status: null }, results[i])));
  return out;
}

const peerIdOf = addr => {
  const m = String(addr || "").match(/\/p2p\/([^/]+)$/);
  return m ? m[1] : null;
};

/**
 * The IPFS core container (ipfsNode.readHealth) and its peers, with the
 * AVADO store nodes among them
 * @param {function} onError (message) for a part that could not be read
 */
async function readIpfsStore(onError = () => {}) {
  const [health, peers] = await Promise.all([
    ipfsNode.readHealth().catch(e => {
      onError(`ipfs: ${errorMessage(e)}`);
      return null;
    }),
    ipfsNode.api("swarm/peers", IPFS_API_TIMEOUT).catch(e => {
      onError(`ipfs peers: ${errorMessage(e)}`);
      return null;
    })
  ]);
  const storeIds = (params.IPFS_STORE_PEERS || []).map(peerIdOf).filter(Boolean);
  const list = peers && Array.isArray(peers.Peers) ? peers.Peers : peers ? [] : null;
  const connectedIds = new Set((list || []).map(p => p && p.Peer));
  const h = health || {};
  return {
    running: health ? health.running : null,
    restarting: health ? health.restarting : null,
    restartCount: health ? health.restartCount : null,
    restartsLastHour: health ? health.restartsLastHour : null,
    startedAt: health ? health.startedAt : null,
    peers: list ? list.length : null,
    storePeersConnected: list ? storeIds.filter(id => connectedIds.has(id)).length : null,
    storePeersTotal: storeIds.length,
    lastLogLines: (h.lastLogLines || []).map(scrub)
  };
}

const rpcClient = () => jayson.client.https({ host: "rpc.ava.do" });

function storeGetUpdates(request) {
  return new Promise((resolve, reject) => {
    rpcClient().request("store.getUpdates", request, (err, response) => {
      if (err) return reject(err);
      if (!response || response.error) {
        return reject(Error((response && response.error && response.error.message) || "empty answer"));
      }
      resolve(response.result);
    });
  });
}

/**
 * The fetch behind "Can't check for updates": rpc.ava.do names the store
 * this box sees (store.getUpdates, as the auto-updater asks), the catalogue
 * itself comes through our IPFS module. ok=true means updates can be checked.
 * @returns {Promise<{ ok, ms, error? }>}
 */
function checkCatalogue() {
  return timed(async () => {
    let hash;
    try {
      const packages = await dockerList.listContainers();
      const result = await storeGetUpdates({
        packages: packages.map(p => ({ name: p.name, version: p.version })),
        nodeid: await db.get("address")
      });
      hash = JSON.parse(result).hash;
    } catch (e) {
      throw Error(`rpc.ava.do: ${errorMessage(e)}`);
    }
    if (!hash) throw Error("rpc.ava.do: no store hash in the answer");
    let store;
    try {
      store = JSON.parse(await ipfs.cat(hash));
    } catch (e) {
      throw Error(`IPFS: ${errorMessage(e)}`);
    }
    if (!store || !Array.isArray(store.packages)) throw Error("IPFS: the catalogue has no packages");
    return null;
  }, CATALOGUE_TIMEOUT);
}

module.exports = {
  DNS_NAMES,
  INTERNET_URLS,
  checkDns,
  checkInternet,
  readIpfsStore,
  checkCatalogue
};
