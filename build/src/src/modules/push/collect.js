"use strict";
const shellExec = require("utils/shell");
const http = require("modules/diagnostics/http");
const { getClient } = require("modules/diagnostics/clients");

/**
 * What the push alert watcher reads on the box. Every reader returns null
 * (or leaves a client out) when it cannot read something: an alert is only
 * ever raised on data that was actually seen.
 */

const MONITOR_PORT = 9999;
const TIMEOUT_MS = 8000;
const MAX_KEYS_CHECKED = 64;
const PUBKEY = /^0x[0-9a-f]{96}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ZERO_ADDRESS = /^0x0{40}$/i;
const SAYS_NOT_SET = /fee.?recipient|suggested/i;
const ON_CHAIN = /^(active|exited)_/;
const ACTIVE = /^active_(ongoing|exiting)$/;
const SLOTS_PER_EPOCH = 32;

// Lazy: the getDiagnostics call pulls in docker and the rest of the box
const getDiagnostics = (...args) => require("calls/getDiagnostics")(...args);

/** Containers with their programs (the Admin's light variant, shared cache) */
async function readContainers() {
  const res = await getDiagnostics({ host: false, network: false, logs: false, clients: false });
  return (res && res.result && res.result.containers) || null;
}

/** Used share of the disk the packages live on, in % (same as getStats) */
async function readDiskPct() {
  const out = await shellExec(`df / | awk 'NR==2 { print $5}'`, true);
  const n = parseFloat(String(out || "").replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

/* ---------------- validator clients ---------------- */

async function getJson(url, init = {}) {
  const res = await http.request(url, Object.assign({ timeout: TIMEOUT_MS, headers: { Accept: "application/json" } }, init));
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Running validator clients with where to reach their keymanager (the
 * package's monitor on :9999 adds the token) and their beacon node.
 * Teku, Nimbus and Lighthouse are both in one container; Prysm's keys are
 * in eth2validator and its beacon node is prysm-beacon-chain-<network>.
 */
function validatorClients(containers) {
  const running = (containers || []).filter(c => c && c.state === "running" && c.ip);
  const out = [];
  for (const c of running) {
    const client = getClient(c.id);
    if (!client || !client.keymanager) continue;
    let beaconIp = null;
    let beaconPort = client.port;
    if (client.role === "beacon") beaconIp = c.ip;
    else if (client.role === "validator") {
      const beacon = running.find(b => {
        const bc = getClient(b.id);
        return bc && bc.role === "beacon" && bc.client === client.client && bc.network === client.network;
      });
      if (beacon) {
        beaconIp = beacon.ip;
        beaconPort = getClient(beacon.id).port;
      }
    }
    out.push({
      name: c.id,
      keymanager: `http://${c.ip}:${MONITOR_PORT}/keymanager`,
      beacon: beaconIp && beaconPort ? `http://${beaconIp}:${beaconPort}` : null
    });
  }
  return out;
}

async function listKeys(client) {
  const list = await getJson(`${client.keymanager}/eth/v1/keystores`);
  if (list.status !== 200 || !list.body || !Array.isArray(list.body.data)) return null;
  const pubkeys = list.body.data
    .map(k => k && (k.validating_pubkey || k.pubkey))
    .filter(pk => typeof pk === "string" && PUBKEY.test(pk))
    .map(pk => pk.toLowerCase());
  return pubkeys.length === list.body.data.length ? pubkeys : null;
}

/** [{ index, pubkey, status }] the beacon node knows; null when unreadable */
async function beaconValidators(client, pubkeys) {
  if (!client.beacon || !pubkeys.length) return null;
  try {
    const r = await getJson(`${client.beacon}/eth/v1/beacon/states/head/validators?id=${pubkeys.join(",")}`);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.data)) return null;
    return r.body.data
      .filter(v => v && v.validator && typeof v.validator.pubkey === "string")
      .map(v => ({ index: String(v.index), pubkey: v.validator.pubkey.toLowerCase(), status: String(v.status || "") }));
  } catch (e) {
    return null;
  }
}

/**
 * One client's fee recipients, the same rules as the Admin's
 * health/feeRecipients.js: { validators, checked, missing } or null.
 */
async function readClientFeeRecipients(client) {
  try {
    const pubkeys = await listKeys(client);
    if (!pubkeys) return null;
    const sample = pubkeys.slice(0, MAX_KEYS_CHECKED);
    const notSet = [];
    const zero = [];
    for (const pk of sample) {
      const r = await getJson(`${client.keymanager}/eth/v1/validator/${pk}/feerecipient`);
      const message = r.body && typeof r.body.message === "string" ? r.body.message : "";
      if ((r.status === 404 || r.status === 500) && SAYS_NOT_SET.test(message)) {
        notSet.push(pk);
        continue;
      }
      const address = r.status === 200 && r.body && r.body.data ? r.body.data.ethaddress : undefined;
      if (typeof address !== "string" || !ADDRESS.test(address)) return null;
      if (ZERO_ADDRESS.test(address)) zero.push(pk);
    }
    let missing = 0;
    if (notSet.length) {
      const again = await listKeys(client);
      if (!again) return null;
      const still = new Set(again);
      missing += notSet.filter(pk => still.has(pk)).length;
    }
    if (zero.length) {
      const known = await beaconValidators(client, zero);
      if (known) {
        const onChain = new Set(known.filter(v => ON_CHAIN.test(v.status)).map(v => v.pubkey));
        missing += zero.filter(pk => onChain.has(pk)).length;
      }
    }
    return { validators: pubkeys.length, checked: sample.length, missing };
  } catch (e) {
    return null;
  }
}

async function readFeeRecipients(containers) {
  const out = {};
  for (const client of validatorClients(containers)) {
    const r = await readClientFeeRecipients(client);
    if (r) out[client.name] = r;
  }
  return out;
}

/**
 * Whether the client's active validators attested in the last finished
 * epoch, from the beacon node's standard liveness API
 * (POST /eth/v1/validator/liveness/{epoch}). Skipped while the beacon node
 * is syncing. { epoch, active, missed } or null.
 */
async function readClientLiveness(client) {
  try {
    if (!client.beacon) return null;
    const sync = await getJson(`${client.beacon}/eth/v1/node/syncing`);
    const data = sync.body && sync.body.data;
    if (sync.status !== 200 || !data || data.is_syncing !== false) return null;
    const headSlot = Number(data.head_slot);
    if (!Number.isFinite(headSlot) || headSlot < 2 * SLOTS_PER_EPOCH) return null;
    const pubkeys = await listKeys(client);
    if (!pubkeys || !pubkeys.length) return null;
    const known = await beaconValidators(client, pubkeys.slice(0, MAX_KEYS_CHECKED));
    if (!known) return null;
    const active = known.filter(v => ACTIVE.test(v.status));
    if (!active.length) return null;
    const epoch = Math.floor(headSlot / SLOTS_PER_EPOCH) - 1;
    const r = await getJson(`${client.beacon}/eth/v1/validator/liveness/${epoch}`, {
      method: "POST",
      body: active.map(v => v.index)
    });
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.data)) return null;
    const live = new Set(r.body.data.filter(d => d && (d.is_live === true || d.is_live === "true")).map(d => String(d.index)));
    const answered = new Set(r.body.data.map(d => d && String(d.index)));
    const checked = active.filter(v => answered.has(v.index));
    if (!checked.length) return null;
    return { epoch, active: checked.length, missed: checked.filter(v => !live.has(v.index)).length };
  } catch (e) {
    return null;
  }
}

async function readLiveness(containers) {
  const out = {};
  for (const client of validatorClients(containers)) {
    const r = await readClientLiveness(client);
    if (r) out[client.name] = r;
  }
  return out;
}

module.exports = {
  readContainers,
  readDiskPct,
  validatorClients,
  readClientFeeRecipients,
  readFeeRecipients,
  readClientLiveness,
  readLiveness
};
