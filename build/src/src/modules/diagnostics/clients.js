const http = require("./http");
const { errorMessage } = require("./timeout");

/**
 * AVADO client packages: which role they play, the port their API listens on
 * inside the container, where their settings file is and whether their
 * monitor (port 9999) proxies the validator keymanager API (/keymanager/*).
 *
 * Read from the package repos in ~/Documents/GitHub on 2026-10-14
 * (AVADO-DNP-<repo> or dappnode-geth at the commit named). The same files
 * hold for every network variant of a package unless an entry says
 * otherwise. Reth, Erigon and Besu have no AVADO package repo there, so they
 * are not listed: their ports are not guessed.
 *
 * role "beacon" for Teku, Nimbus and Lighthouse means beacon node AND
 * validator client in one container: they also get a validator count.
 */

const MONITOR_PORT = 9999;

const TEKU = {
  role: "beacon",
  client: "teku",
  // AVADO-DNP-Teku@0b791d9 build/teku-config.template: rest-api-port: 5051
  port: 5051,
  // build/supervisord.conf: startTeku.sh /data/settings.json
  settingsPath: "/data/settings.json",
  // build/monitor/server.ts: server.get('/keymanager/*') ... server.listen(9999)
  keymanager: true
};
const NIMBUS = {
  role: "beacon",
  client: "nimbus",
  // AVADO-DNP-Nimbus@1ebe5d1 build/startNimbus.sh: --rest-port=5052
  port: 5052,
  // build/supervisord.conf: startNimbus.sh /data/settings.json
  settingsPath: "/data/settings.json",
  // build/server/server.ts: .get('/keymanager/:path(.*)') ... app.listen({ port: 9999 })
  keymanager: true
};
const LIGHTHOUSE = {
  role: "beacon",
  client: "lighthouse",
  // AVADO-DNP-Lighthouse@42109e4 build/startLighthouse.sh: --http-port=5052
  port: 5052,
  // build/supervisord.conf: startLighthouse.sh /data/settings.json bn|vc
  settingsPath: "/data/settings.json",
  // build/server/server.ts: .get('/keymanager/:path(.*)') ... app.listen({ port: 9999 })
  keymanager: true
};
const PRYSM_BEACON = {
  role: "beacon",
  client: "prysm",
  // AVADO-DNP-Prysm-beacon-chain@22a9f5b build/startPrysmBeaconchain.sh: --http-port=3500
  port: 3500,
  // build/supervisord.conf: startPrysmBeaconchain.sh /data/settings.json
  settingsPath: "/data/settings.json",
  // build/monitor/server.ts proxies /keymanager/* to eth2validator, not to
  // itself: the keys are counted on the validator app
  keymanager: false
};
const PRYSM_VALIDATOR = {
  role: "validator",
  client: "prysm",
  // No beacon or JSON-RPC API: its own health is the keymanager answering
  port: null,
  // AVADO-DNP-Prysm-validator@0624a79 build/files/start.sh: SETTINGSFILE=/root/settings.json
  settingsPath: "/root/settings.json",
  // build/monitor/server.ts: server.get('/keymanager/*') -> localhost:7500 ... server.listen(9999)
  keymanager: true
};
const NETHERMIND = {
  role: "execution",
  client: "nethermind",
  // AVADO-DNP-Nethermind@ad8dd94 build/start.sh: --JsonRpc.Enabled=true
  // --JsonRpc.Host=0.0.0.0 on Nethermind's default port 8545, the port
  // build/nginx.conf proxies to (proxy_pass http://localhost:8545)
  port: 8545,
  // No settings.json: configured by environment variables
  settingsPath: null,
  keymanager: false
};

const GETH = {
  role: "execution",
  client: "geth",
  // dappnode-geth@d2235aa build/files/start.sh: --http --http.addr="0.0.0.0"
  // on Geth's default port 8545, the port build/files/nginx.conf proxies to
  // (proxy_pass http://localhost:8545) and docker-compose-*.yml publish
  port: 8545,
  // No settings.json: configured by environment variables
  settingsPath: null,
  keymanager: false
};

const entry = (name, base, network) => Object.assign({ name, network }, base);

// Package names from each repo's dappnode_package-<network>.json. Prater is
// the retired Goerli testnet (called "goerli" like the Admin's table).
const CLIENTS = [
  // dappnode-geth build/dappnode_package-{mainnet,holesky,goerli}.json
  entry("ethchain-geth.public.dappnode.eth", GETH, "mainnet"),
  entry("holesky-geth.avado.dnp.dappnode.eth", GETH, "holesky"),
  entry("goerli-geth.avado.dnp.dappnode.eth", GETH, "goerli"),
  entry("avado-dnp-nethermind.public.dappnode.eth", NETHERMIND, "mainnet"),
  entry("nethermind-gnosis.avado.dnp.dappnode.eth", NETHERMIND, "gnosis"),
  entry("nethermind-goerli.avado.dnp.dappnode.eth", NETHERMIND, "goerli"),
  entry("teku.avado.dnp.dappnode.eth", TEKU, "mainnet"),
  entry("teku-gnosis.avado.dnp.dappnode.eth", TEKU, "gnosis"),
  entry("teku-holesky.avado.dnp.dappnode.eth", TEKU, "holesky"),
  entry("teku-prater.avado.dnp.dappnode.eth", TEKU, "goerli"),
  entry("nimbus.avado.dnp.dappnode.eth", NIMBUS, "mainnet"),
  entry("nimbus-holesky.avado.dnp.dappnode.eth", NIMBUS, "holesky"),
  entry("nimbus-prater.avado.dnp.dappnode.eth", NIMBUS, "goerli"),
  entry("lighthouse.avado.dnp.dappnode.eth", LIGHTHOUSE, "mainnet"),
  entry("lighthouse-gnosis.avado.dnp.dappnode.eth", LIGHTHOUSE, "gnosis"),
  entry("lighthouse-holesky.avado.dnp.dappnode.eth", LIGHTHOUSE, "holesky"),
  entry("lighthouse-prater.avado.dnp.dappnode.eth", LIGHTHOUSE, "goerli"),
  entry("prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth", PRYSM_BEACON, "mainnet"),
  entry("prysm-beacon-chain-prater.avado.dnp.dappnode.eth", PRYSM_BEACON, "goerli"),
  // dappnode_package-mainnet.json and -prater.json both name it eth2validator
  entry("eth2validator.avado.dnp.dappnode.eth", PRYSM_VALIDATOR, "mainnet")
];

const byName = {};
for (const c of CLIENTS) byName[c.name] = c;

const getClient = name => byName[name] || null;

const num = v => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" && /^0x/i.test(v) ? parseInt(v, 16) : Number(v);
  return Number.isFinite(n) ? n : null;
};

// The auto-updater's chain watcher counts a node within 60 blocks as synced
const MIN_BLOCK_DIFF_SYNC = 60;

/**
 * Beacon node API: /eth/v1/node/syncing, /version, /peer_count
 */
async function probeBeacon(base, timeout) {
  const [syncing, version, peers] = await Promise.all(
    ["syncing", "version", "peer_count"].map(p =>
      http.getJson(`${base}/eth/v1/node/${p}`, timeout).then(
        r => ({ data: r && r.data }),
        e => ({ error: errorMessage(e) })
      )
    )
  );
  const api = { reachable: !syncing.error || !version.error || !peers.error };
  if (version.data && version.data.version) api.version = version.data.version;
  if (syncing.data) {
    const d = syncing.data;
    api.syncing = {
      isSyncing: d.is_syncing === true,
      headSlot: num(d.head_slot),
      syncDistance: num(d.sync_distance),
      isOptimistic: d.is_optimistic === true,
      elOffline: d.el_offline === true
    };
  }
  if (peers.data) api.peers = num(peers.data.connected);
  const firstError = syncing.error || version.error || peers.error;
  if (firstError) api.error = firstError;
  return api;
}

/**
 * Execution JSON-RPC: eth_syncing, eth_blockNumber, net_peerCount,
 * web3_clientVersion
 */
async function probeExecution(url, timeout) {
  const [syncing, block, peers, version] = await Promise.all(
    ["eth_syncing", "eth_blockNumber", "net_peerCount", "web3_clientVersion"].map(m =>
      http.jsonRpc(url, m, [], timeout).then(
        result => ({ result }),
        e => ({ error: errorMessage(e) })
      )
    )
  );
  const api = { reachable: !syncing.error || !block.error };
  if (typeof version.result === "string") api.version = version.result;
  if (!syncing.error && !block.error) {
    const current = num(block.result);
    if (syncing.result && typeof syncing.result === "object") {
      const s = syncing.result;
      const cur = num(s.currentBlock);
      const high = num(s.highestBlock);
      api.syncing = {
        currentBlock: cur,
        highestBlock: high,
        startingBlock: num(s.startingBlock),
        synced: cur !== null && high !== null ? high - cur <= MIN_BLOCK_DIFF_SYNC : false
      };
    } else {
      api.syncing = { currentBlock: current, highestBlock: current, startingBlock: null, synced: true };
    }
  }
  if (!peers.error) api.peers = num(peers.result);
  const firstError = syncing.error || block.error || peers.error;
  if (firstError) api.error = firstError;
  return api;
}

/** Validator keys through the monitor's keymanager proxy */
async function countValidators(ip, timeout) {
  const res = await http.getJson(`http://${ip}:${MONITOR_PORT}/keymanager/eth/v1/keystores`, timeout);
  if (!res || !Array.isArray(res.data)) throw Error("unexpected keymanager answer");
  return { count: res.data.length };
}

/**
 * One installed client package's own view
 * @param {object} client a CLIENTS entry
 * @param {object} container from containers.formatContainer (with .ip, .running)
 * @param {function} onError (message)
 */
async function probeClient(client, container, { timeout = 4000, onError = () => {} } = {}) {
  const out = {
    id: client.name,
    role: client.role,
    client: client.client,
    network: client.network,
    api: { reachable: false },
    validators: null
  };
  if (!container.running) {
    out.api.error = "the container is not running";
    return out;
  }
  if (!container.ip) {
    out.api.error = "the container has no address on the AVADO network";
    return out;
  }
  const [api, validators] = await Promise.all([
    client.port
      ? client.role === "execution"
        ? probeExecution(`http://${container.ip}:${client.port}`, timeout)
        : probeBeacon(`http://${container.ip}:${client.port}`, timeout)
      : Promise.resolve(null),
    client.keymanager
      ? countValidators(container.ip, timeout).catch(e => {
          onError(`validators ${client.name}: ${errorMessage(e)}`);
          return null;
        })
      : Promise.resolve(null)
  ]);
  if (api) out.api = api;
  else out.api = validators ? { reachable: true } : { reachable: false, error: "the keymanager does not answer" };
  out.validators = validators;
  return out;
}

module.exports = { CLIENTS, getClient, probeClient, probeBeacon, probeExecution, countValidators };
