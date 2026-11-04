const fs = require("fs");
const getPath = require("utils/getPath");

/**
 * Secret setup fields: the env values a package's manifest marks as secret
 * never leave the DAPPMANAGER. The Admin only learns whether one is set.
 *
 * A package marks them in its manifest's setup wizard (DAppNode's
 * setup-wizard v2 format, as the Admin's installer and Settings read it):
 *   "setupWizard": {
 *     "version": "2",
 *     "fields": [{
 *       "id": "TS_AUTHKEY",
 *       "target": { "type": "environment", "name": "TS_AUTHKEY" },
 *       "secret": true
 *     }]
 *   }
 *
 * - The package list (listPackages, also published to the Admin) shows such
 *   an env as "********" when it has a value and "" when it has none.
 * - updatePackageEnv and installPackage take an incoming "********" or an
 *   empty value for it as "keep the current value": an Admin that sends the
 *   whole env table back (Admin 10.0.68 and older) never writes the mask.
 * - The real values stay in the package's .env file (and so reach the
 *   container through the docker-compose env_file) unchanged.
 *
 * DAppNode sends these values to its Admin as they are (its Admin needs a
 * login); the "secret" flag only makes its form fields masked. AVADO's Admin
 * has no login, so the DAPPMANAGER hides them.
 */

const MASK = "********";

/**
 * @param {object} manifest
 * @returns {array} names of the envs the manifest marks as secret
 */
function secretEnvNames(manifest) {
  const fields = ((manifest || {}).setupWizard || {}).fields;
  if (!Array.isArray(fields)) return [];
  const names = [];
  for (const field of fields) {
    if (!field || typeof field !== "object" || field.secret !== true) continue;
    const target = field.target || {};
    if (target.type !== "environment") continue;
    if (typeof target.name !== "string" || !target.name) continue;
    if (!names.includes(target.name)) names.push(target.name);
  }
  return names;
}

const isSet = value =>
  value !== undefined && value !== null && String(value).trim() !== "";

/**
 * A copy of `envs` safe to send to the Admin: each secret env is "********"
 * when it has a value and "" when it has none (also when the .env file does
 * not list it, so the Admin does not fall back to the manifest default).
 * @param {object} envs { NAME: value } from the package's .env file
 * @param {object} manifest the installed package's manifest
 * @returns {object} envs, the same object when the package has no secrets
 */
function maskSecretEnvs(envs, manifest) {
  const names = secretEnvNames(manifest);
  if (!names.length) return envs;
  const out = { ...(envs || {}) };
  for (const name of names) out[name] = isSet(out[name]) ? MASK : "";
  return out;
}

/**
 * A copy of incoming `envs` without the secret envs that mean "keep the
 * current value": the mask (with or without spaces around it) and empty
 * values. Every other env, and a secret with a new value, passes unchanged.
 * @param {object} envs { NAME: value } from the Admin
 * @param {object} manifest the package's manifest
 * @returns {object} envs, the same object when nothing was left out
 */
function dropKeptSecretEnvs(envs, manifest) {
  const names = secretEnvNames(manifest);
  if (!names.length || !envs || typeof envs !== "object") return envs;
  let out = envs;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(envs, name)) continue;
    const value = envs[name];
    if (isSet(value) && String(value).trim() !== MASK) continue;
    if (out === envs) out = { ...envs };
    delete out[name];
  }
  return out;
}

/**
 * The installed package's manifest, as listPackages reads it; {} when there is
 * none or it does not parse.
 * @param {string} name
 * @param {object} params
 * @param {bool} isCore
 */
function readInstalledManifest(name, params, isCore) {
  try {
    const manifestPath = getPath.manifest(name, params, isCore);
    if (!fs.existsSync(manifestPath)) return {};
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

module.exports = {
  MASK,
  secretEnvNames,
  maskSecretEnvs,
  dropKeptSecretEnvs,
  readInstalledManifest
};
