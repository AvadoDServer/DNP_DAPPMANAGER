/**
 * Copies of call arguments and results that are safe to log: the activity log
 * (userActionLogs, also sent to the Admin and kept on disk) and log lines.
 * The original objects are never changed, so the real values still reach the
 * handler, the .env files and the docker-compose.
 *
 * - Env values: everything under a key that ends in "envs" (installPackage's
 *   userSetEnvs = { dnpName: { NAME: value } }, updatePackageEnv's
 *   envs = { NAME: value }) becomes "********". The env NAMES and the package
 *   names stay. All values, not only secret-looking ones: a setup field such as
 *   Tailscale's TS_AUTHKEY has a name no rule would guess.
 * - Secret-named keys at any depth (currentPassword, keystorePassword,
 *   passphrase, secret, mnemonic, privateKey, apiKey, token, authorization,
 *   authKey): the value becomes "********".
 *
 * Adapted from DAppNode's logSafeObjects (dappnode/DNP_DAPPMANAGER,
 * packages/logger/src/logSafeObjects.ts, GPL-3.0), which hides secret-named
 * keys recursively. The env rule is AVADO's.
 */

const HIDDEN = "********";

const SECRET_KEY = /pass(word|phrase)?$|password|passphrase|secret|mnemonic|private.?key|api.?key|auth.?key|token|authorization|bearer/i;
const ENVS_KEY = /envs$/i;

const isPlainObject = value =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Every value replaced, every key kept. An env list in the manifest style,
 * ["NAME=value"], keeps its names: ["NAME=********"].
 */
function hideAllValues(value) {
  if (Array.isArray(value)) {
    return value.map(item =>
      typeof item === "string" && item.includes("=")
        ? `${item.split("=")[0]}=${HIDDEN}`
        : hideAllValues(item)
    );
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) out[key] = hideAllValues(value[key]);
    return out;
  }
  // Nothing to hide in an unset value; it tells whoever reads that it was empty
  if (value === undefined || value === null) return value;
  return HIDDEN;
}

/**
 * @param {*} value kwargs, a result or any value
 * @returns {*} the same value if it holds nothing to hide, otherwise a copy
 */
function logSafeObjects(value) {
  if (Array.isArray(value)) {
    const out = value.map(logSafeObjects);
    return out.some((item, i) => item !== value[i]) ? out : value;
  }
  if (!isPlainObject(value)) return value;
  let out = null;
  for (const key of Object.keys(value)) {
    const item = value[key];
    let safe;
    if (ENVS_KEY.test(key)) safe = hideAllValues(item);
    else if (SECRET_KEY.test(key) && item !== undefined && item !== null) safe = HIDDEN;
    else safe = logSafeObjects(item);
    if (safe !== item) {
      if (!out) out = Object.assign({}, value);
      out[key] = safe;
    }
  }
  return out || value;
}

/**
 * The names of an envs object, for a log line: "NAME_A, NAME_B"
 * @param {object} envs { NAME: value }
 * @returns {string}
 */
function envNames(envs) {
  const names = isPlainObject(envs) ? Object.keys(envs) : [];
  return names.length ? names.join(", ") : "(none)";
}

module.exports = logSafeObjects;
module.exports.logSafeObjects = logSafeObjects;
module.exports.envNames = envNames;
module.exports.HIDDEN = HIDDEN;
