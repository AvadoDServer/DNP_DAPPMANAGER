const path = require("path");

/**
 * What a backup of an app contains.
 *
 * The manifest's `backup` field, in DAppNode's format (dappnode/DNP_DAPPMANAGER
 * `PackageBackup`, validateBackupArray), wins:
 *
 *   "backup": [
 *     { "name": "data", "path": "/data" },
 *     { "name": "keys", "path": "/root/.keys", "service": "validator" }
 *   ]
 *
 * AVADO adds a few optional fields:
 *   label      plain words for the owner ("Passwords and settings")
 *   only       ["data-*\/validator", "settings.json"]: only these entries
 *              inside `path` (one * per path part)
 *   large      true: the owner chooses whether it is backed up (photo
 *              libraries); it is read while the app keeps running
 *   validator  true: validator keys and their slashing protection. Restored
 *              only with the owner's confirmation, never onto an app that has
 *              keys already or keys that another app on the box runs, and the
 *              app stays stopped afterwards
 *   keys       ["data-*\/validators/0x*"]: where the validator keys are, to
 *              compare public keys (with `validator`)
 *
 * Apps that have no `backup` field yet get the built-in list below, so their
 * data is covered without a new release of the app. Every app's settings
 * (its env values) are always included as the item "settings".
 */

const AVADO_SUFFIX = "\\.avado\\.dnp\\.dappnode\\.eth";

const DEFAULTS = [
  {
    match: new RegExp(`^teku(-[a-z0-9]+)?${AVADO_SUFFIX}$`),
    items: [
      {
        name: "validator",
        path: "/data",
        only: ["settings.json", "data-*/validator"],
        label: "Validator keys, slashing protection and settings",
        validator: true,
        keys: ["data-*/validator/key-manager/local/*.json"]
      }
    ]
  },
  {
    match: new RegExp(`^nimbus(-[a-z0-9]+)?${AVADO_SUFFIX}$`),
    items: [
      {
        name: "validator",
        path: "/data",
        only: ["settings.json", "data-*/validators", "data-*/secrets"],
        label: "Validator keys, slashing protection and settings",
        validator: true,
        keys: ["data-*/validators/0x*"]
      }
    ]
  },
  {
    match: new RegExp(`^lighthouse(-[a-z0-9]+)?${AVADO_SUFFIX}$`),
    items: [
      {
        name: "validator",
        path: "/data",
        only: ["settings.json", "data-*/validators", "data-*/secrets"],
        label: "Validator keys, slashing protection and settings",
        validator: true,
        keys: ["data-*/validators/0x*"]
      }
    ]
  },
  {
    match: new RegExp(`^eth2validator(-[a-z0-9]+)?${AVADO_SUFFIX}$`),
    items: [
      {
        name: "validator",
        path: "/root",
        only: ["settings.json", ".eth2validators", ".eth2"],
        label: "Validator wallet, slashing protection and settings",
        validator: true,
        // Prysm's wallet is encrypted: its public keys can't be read from it
        keys: [".eth2validators/direct/accounts/all-accounts.keystore.json"]
      }
    ]
  },
  {
    match: new RegExp(`^vaultwarden${AVADO_SUFFIX}$`),
    items: [{ name: "data", path: "/data", label: "Passwords, accounts and settings" }]
  },
  {
    match: new RegExp(`^paperless${AVADO_SUFFIX}$`),
    items: [
      { name: "data", path: "/usr/src/paperless/data", label: "Document list, tags and accounts" },
      { name: "media", path: "/usr/src/paperless/media", label: "Documents", large: true }
    ]
  },
  {
    match: new RegExp(`^immich${AVADO_SUFFIX}$`),
    items: [
      { name: "database", path: "/var/lib/postgresql", label: "Albums, people and accounts" },
      {
        name: "library",
        path: "/data",
        only: ["library", "upload", "profile", "backups"],
        label: "Photos and videos",
        large: true
      }
    ]
  },
  {
    match: new RegExp(`^homeassistant${AVADO_SUFFIX}$`),
    items: [{ name: "config", path: "/config", label: "Devices, automations and settings" }]
  }
];

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RESERVED = new Set(["settings"]);
const REL = /^[A-Za-z0-9._*@+-]+(\/[A-Za-z0-9._*@+-]+)*$/;

/**
 * DAppNode's rules (validateBackupArray) plus AVADO's: names are short plain
 * words and unique, paths absolute and without "..", `only` and `keys`
 * relative patterns.
 * @returns {object[]} the valid items, normalized
 * @throws when the list is not usable at all
 */
function validateBackupArray(backup) {
  if (!Array.isArray(backup)) throw Error("backup must be a list");
  const names = new Set();
  const items = [];
  for (const raw of backup) {
    if (!raw || typeof raw !== "object") throw Error("backup items must be objects");
    const name = String(raw.name || "");
    const p = String(raw.path || "");
    if (!NAME.test(name) || RESERVED.has(name)) throw Error(`Backup name ${name} is not allowed`);
    if (names.has(name)) throw Error(`Backup name ${name} is duplicated. They must be unique`);
    if (!path.isAbsolute(p) || p.split("/").includes("..") || p === "/") throw Error(`Backup paths must be absolute, path: ${p}`);
    if (path.parse(name).dir) throw Error(`Backup names cannot be a path, name: ${name}`);
    const rel = list => (Array.isArray(list) ? list.map(String).filter(x => REL.test(x) && !x.split("/").includes("..")) : undefined);
    names.add(name);
    items.push({
      name,
      path: path.posix.normalize(p).replace(/\/$/, ""),
      service: raw.service ? String(raw.service) : undefined,
      label: raw.label ? String(raw.label).slice(0, 80) : undefined,
      only: rel(raw.only),
      keys: rel(raw.keys),
      large: raw.large === true,
      validator: raw.validator === true
    });
  }
  return items;
}

/**
 * Backup items of an app: its manifest's `backup` field, else the built-in
 * list. Empty when there is nothing to back up besides settings.
 * @param {string} name package name
 * @param {object} [manifest]
 * @returns {{ items: object[], source: "manifest"|"builtin"|"none", error?: string }}
 */
function backupItemsOf(name, manifest) {
  if (manifest && manifest.backup !== undefined) {
    try {
      return { items: validateBackupArray(manifest.backup), source: "manifest" };
    } catch (e) {
      return { items: [], source: "none", error: e.message };
    }
  }
  const d = DEFAULTS.find(x => x.match.test(name));
  if (d) return { items: validateBackupArray(d.items), source: "builtin" };
  return { items: [], source: "none" };
}

module.exports = { backupItemsOf, validateBackupArray, DEFAULTS };
