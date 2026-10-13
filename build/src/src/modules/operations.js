/**
 * Long operations running in this process, so that one that must run alone
 * (resetIpfsData) can refuse to start while another one runs, and the
 * others can refuse while it runs.
 *
 * In memory only: a DAPPMANAGER restart ends every operation anyway.
 *
 * Kinds in use: installPackage (installs, updates, core updates and the
 * auto-updater), resetBeaconData, recoverLostData, resetIpfsData.
 */

const logs = require("logs.js")(module);

const running = new Map();
let seq = 0;

// An install is not counted as running any more after this long: an IPFS
// download that stalls after its first chunk never times out, and it would
// otherwise block resetIpfsData until the DAPPMANAGER restarts. The longest
// legitimate install is a multi-GB image over a slow line plus loading it
// into Docker on a busy disk; two hours leaves room for that.
const MAX_AGE = { installPackage: 2 * 60 * 60 * 1000 };

const IPFS_ID = "ipfs.dnp.dappnode.eth";

/**
 * Registers an operation as running.
 * @param {string} kind e.g. "installPackage"
 * @param {string} [id] package it runs on, if any
 * @returns {function} call it once the operation has ended (safe to call twice)
 */
function begin(kind, id = null) {
  const token = ++seq;
  running.set(token, { kind, id, since: Date.now(), maxAge: MAX_AGE[kind] || null });
  return () => {
    running.delete(token);
  };
}

/**
 * @param {string} [kind] only operations of this kind
 * @param {string} [id] only operations on this package
 * @returns {Array<{kind, id, since}>} operations running now
 */
function list(kind, id, { now = Date.now() } = {}) {
  return [...running.values()]
    .filter(op => {
      if (!op.maxAge || now - op.since <= op.maxAge) return true;
      if (!op.expiredLogged) {
        op.expiredLogged = true;
        logs.warn(`operations: ${op.kind} ${op.id || ""} has run for more than ${Math.round(op.maxAge / 60000)} minutes, no longer counted as running`);
      }
      return false;
    })
    .map(({ kind, id, since }) => ({ kind, id, since }))
    .filter(op => (!kind || op.kind === kind) && (id === undefined || op.id === id));
}

/**
 * @returns {boolean} an operation of `kind` (on `id`, when given) runs
 */
function isRunning(kind, id) {
  return list(kind, id).length > 0;
}

/**
 * Throws when `id` is the IPFS package and its storage is being reset: a
 * start, restart, stop or removal of IPFS must wait for resetIpfsData.
 */
function assertNotIpfsReset(id) {
  if (id === IPFS_ID && isRunning("resetIpfsData")) {
    throw Error("The IPFS storage is being reset. Try again when it is done. Nothing was changed.");
  }
}

/**
 * Runs `fn` registered as `kind` (on `id`), ending it however `fn` ends.
 */
async function track(kind, id, fn) {
  const end = begin(kind, id);
  try {
    return await fn();
  } finally {
    end();
  }
}

// Tests only
function _reset() {
  running.clear();
}

module.exports = {
  begin,
  list,
  isRunning,
  track,
  assertNotIpfsReset,
  MAX_AGE,
  _reset
};
