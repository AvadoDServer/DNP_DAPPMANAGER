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

const running = new Map();
let seq = 0;

/**
 * Registers an operation as running.
 * @param {string} kind e.g. "installPackage"
 * @param {string} [id] package it runs on, if any
 * @returns {function} call it once the operation has ended (safe to call twice)
 */
function begin(kind, id = null) {
  const token = ++seq;
  running.set(token, { kind, id, since: Date.now() });
  return () => {
    running.delete(token);
  };
}

/**
 * @param {string} [kind] only operations of this kind
 * @param {string} [id] only operations on this package
 * @returns {Array<{kind, id, since}>} operations running now
 */
function list(kind, id) {
  return [...running.values()].filter(
    op => (!kind || op.kind === kind) && (id === undefined || op.id === id)
  );
}

/**
 * @returns {boolean} an operation of `kind` (on `id`, when given) runs
 */
function isRunning(kind, id) {
  return list(kind, id).length > 0;
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
  _reset
};
