"use strict";
const logs = require("logs.js")(module);
const push = require("modules/push");
const collect = require("modules/push/collect");
const { allFindings } = require("modules/push/findings");

/**
 * Push alerts watcher. Does nothing at all while no phone has alerts on.
 *
 * Every 5 minutes: containers and their programs, the disk, and whether the
 * validators attested in the last epoch. Every hour: the fee recipients
 * (up to 64 requests per validator client). An alert goes to every phone
 * when a finding first appears (after `confirmRuns` runs in a row), and
 * again once a day while it is still there. A finding that goes away is
 * forgotten, so it alerts again if it comes back.
 *
 * State (DNCORE/push/state.json): { findings: { id: { seenRuns, firstSeenAt,
 * lastSentAt } }, liveness: { pkg: { epoch, active, missed } } }
 */

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;
const FEE_RECIPIENT_EVERY_MS = 60 * 60 * 1000;
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

let feeRecipients = {};
let feeRecipientsAt = 0;
let running = false;

/**
 * Pure: which findings to send now, and the next state.
 * @returns {object} { toSend: [finding], state }
 */
function decide(findings, state, now = Date.now()) {
  const prev = (state && state.findings) || {};
  const next = {};
  const toSend = [];
  for (const f of findings) {
    const p = prev[f.id] || { seenRuns: 0, firstSeenAt: new Date(now).toISOString(), lastSentAt: null };
    const entry = { seenRuns: p.seenRuns + 1, firstSeenAt: p.firstSeenAt, lastSentAt: p.lastSentAt };
    const confirmed = entry.seenRuns >= (f.confirmRuns || 1);
    const due = !entry.lastSentAt || now - Date.parse(entry.lastSentAt) >= REMIND_AFTER_MS;
    if (confirmed && due) {
      toSend.push(f);
      entry.lastSentAt = new Date(now).toISOString();
    }
    next[f.id] = entry;
  }
  return { toSend, state: Object.assign({}, state, { findings: next }) };
}

async function runOnce(now = Date.now()) {
  if (running) return null;
  if (!push.listSubscriptions().length) return null;
  running = true;
  try {
    const state = push.readJson("state.json", {});
    const containers = await collect.readContainers().catch(e => {
      logs.warn(`Push alerts: could not read the containers: ${e.message}`);
      return null;
    });
    const diskPct = await collect.readDiskPct().catch(() => null);
    if (containers && now - feeRecipientsAt >= FEE_RECIPIENT_EVERY_MS) {
      feeRecipients = await collect.readFeeRecipients(containers).catch(() => ({}));
      feeRecipientsAt = now;
    }
    const liveness = containers ? await collect.readLiveness(containers).catch(() => ({})) : {};
    const findings = allFindings({
      containers,
      diskPct,
      feeRecipients,
      liveness,
      previousLiveness: state.liveness
    });
    // Without the containers this run, keep the client findings as they were
    // instead of forgetting them (a slow docker must not re-alert later)
    let kept = findings;
    if (!containers) {
      const prev = (state && state.findings) || {};
      kept = findings.concat(
        Object.keys(prev)
          .filter(id => id.startsWith("process-down:") && !findings.some(f => f.id === id))
          .map(id => ({ id, confirmRuns: Infinity }))
      );
    }
    const { toSend, state: nextState } = decide(kept, state, now);
    nextState.liveness = Object.assign({}, state.liveness, liveness);
    for (const f of toSend) {
      const r = await push.sendToAll({ title: f.title, body: f.body, url: f.url, tag: f.id });
      logs.info(`Push alert "${f.id}" sent to ${r.sent} device${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}`);
    }
    push.writeJson("state.json", nextState);
    return { findings: kept.map(f => f.id), sent: toSend.map(f => f.id) };
  } finally {
    running = false;
  }
}

function safeRun() {
  runOnce().catch(e => logs.error(`Push alerts watcher: ${e.stack || e.message}`));
}

if (!process.env.TEST) {
  setTimeout(safeRun, FIRST_RUN_MS);
  setInterval(safeRun, INTERVAL_MS);
}

// Tests only
function _reset() {
  feeRecipients = {};
  feeRecipientsAt = 0;
  running = false;
}

module.exports = { decide, runOnce, REMIND_AFTER_MS, _reset };
