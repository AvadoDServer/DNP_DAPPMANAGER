"use strict";
const { getClient } = require("modules/diagnostics/clients");

/**
 * The problems that are worth a push alert, worked out from what the box
 * reads itself (modules/push/collect.js). Pure functions, no I/O.
 *
 * They are the server-side twins of the Admin's "What we found" findings and
 * keep their ids, so an alert and the Home finding name the same thing:
 *   process-down:<pkg>          (Admin rules/processes.js processDown,
 *                                appCrashLooping and rules/apps.js
 *                                appRestarting, for chain clients only)
 *   disk-high                   (Admin rules/storage.js diskHigh, critical
 *                                level only: 90 % and more)
 *   fee-recipient-missing:<pkg> (Admin rules/validators.js; the Admin cannot
 *                                read the clients from the browser, the box
 *                                can)
 *   missed-attestations:<pkg>   (Admin rules/chain.js reads Prometheus
 *                                validator-monitor counters, which AVADO
 *                                clients do not export; the box asks the
 *                                beacon node's standard liveness API instead)
 *
 * Each alert: { id, title, body, url, confirmRuns }. `url` is an Admin route
 * (opened when the owner taps the alert). `confirmRuns`: how many watcher
 * runs in a row must see it before it is sent, so a client restarting for
 * an update does not wake anyone up.
 */

const PROCESS_FAILED = new Set(["FATAL", "BACKOFF", "EXITED"]);
const CRASH_LOOP_RESTARTS = 3;
const CRASH_LOOP_UPTIME_S = 3600;
const DISK_ALERT_PCT = 90;

const CLIENT_LABELS = {
  teku: "Teku",
  nimbus: "Nimbus",
  lighthouse: "Lighthouse",
  prysm: "Prysm",
  geth: "Geth",
  nethermind: "Nethermind"
};
const NETWORK_LABELS = { holesky: "Holesky", goerli: "Goerli", gnosis: "Gnosis", hoodi: "Hoodi" };

/** "Teku", "Teku (Holesky)", "Prysm validator" */
function clientLabel(name) {
  const c = getClient(name);
  if (!c) return String(name || "").split(".")[0];
  let label = CLIENT_LABELS[c.client] || c.client;
  if (c.role === "validator") label += " validator";
  if (c.network && c.network !== "mainnet") label += ` (${NETWORK_LABELS[c.network] || c.network})`;
  return label;
}

function isDown(c) {
  if (!c || !getClient(c.id)) return false;
  if (c.state === "restarting") return true;
  if (c.state === "running" && (c.processes || []).some(p => p && PROCESS_FAILED.has(p.state))) return true;
  if (c.restartCount >= CRASH_LOOP_RESTARTS && typeof c.uptimeSeconds === "number" && c.uptimeSeconds < CRASH_LOOP_UPTIME_S) return true;
  return false;
}

/** Chain clients that crashed, keep restarting or whose program failed */
function clientsDown(containers) {
  return (containers || []).filter(isDown).map(c => {
    const label = clientLabel(c.id);
    const role = getClient(c.id).role;
    return {
      id: `process-down:${c.id}`,
      title: `${label} has stopped working`,
      body:
        role === "execution"
          ? "Your validators cannot do their work until it runs again. Open AVADO to restart it."
          : "Your validators miss rewards until it runs again. Open AVADO to restart it.",
      url: `/packages/${c.id}`,
      confirmRuns: 2
    };
  });
}

/** "93%" or 93 -> 93; anything else -> null */
function parsePercent(value) {
  const n = typeof value === "number" ? value : parseFloat(String(value || "").replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

function diskHigh(diskPct) {
  const pct = parsePercent(diskPct);
  if (pct === null || pct < DISK_ALERT_PCT) return [];
  return [
    {
      id: "disk-high",
      title: `Your AVADO's disk is ${Math.round(pct)}% full`,
      body: "When it is full, your clients stop and your validators go offline. Open AVADO to free up space.",
      url: "/system/storage",
      confirmRuns: 1
    }
  ];
}

/** feeRecipients: { pkg: { validators, checked, missing } } */
function feeRecipientMissing(feeRecipients) {
  return Object.entries(feeRecipients || {})
    .filter(([, r]) => r && r.validators > 0 && r.missing > 0)
    .map(([name, r]) => ({
      id: `fee-recipient-missing:${name}`,
      title: `Validators in ${clientLabel(name)} have no fee recipient`,
      body: `${r.missing} validator${r.missing === 1 ? "" : "s"} would lose the fees of the blocks they propose. Open AVADO to set your address.`,
      url: `/packages/${name}`,
      confirmRuns: 1
    }));
}

/**
 * liveness: { pkg: { epoch, active, missed } } for this run and the run
 * before (`previous`). Alerted when validators missed in two different
 * epochs in a row: one missed attestation now and then is normal.
 */
function missedAttestations(liveness, previous) {
  const out = [];
  for (const [name, now] of Object.entries(liveness || {})) {
    const before = (previous || {})[name];
    if (!now || !before || !(now.missed > 0) || !(before.missed > 0) || now.epoch === before.epoch) continue;
    const missed = Math.max(now.missed, before.missed);
    out.push({
      id: `missed-attestations:${name}`,
      title: `Your validators in ${clientLabel(name)} are missing attestations`,
      body: `${missed} of ${now.active} validator${now.active === 1 ? "" : "s"} missed their last attestations. Open AVADO to find the cause.`,
      url: "/help/attestations",
      confirmRuns: 1
    });
  }
  return out;
}

function allFindings({ containers, diskPct, feeRecipients, liveness, previousLiveness }) {
  return [
    ...clientsDown(containers),
    ...diskHigh(diskPct),
    ...feeRecipientMissing(feeRecipients),
    ...missedAttestations(liveness, previousLiveness)
  ];
}

module.exports = {
  DISK_ALERT_PCT,
  clientLabel,
  clientsDown,
  diskHigh,
  feeRecipientMissing,
  missedAttestations,
  allFindings,
  parsePercent
};
