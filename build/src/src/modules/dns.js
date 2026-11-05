"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const yaml = require("js-yaml");
const logs = require("logs.js")(module);
const params = require("params");
const getPath = require("utils/getPath");
const dockerList = require("modules/dockerList");
const { run } = require("modules/diagnostics/exec");

/**
 * The box's DNS names for packages (<name>.my.ava.do and the older zones).
 *
 * The cron script build/dns_updater.sh (every minute) only ever ADDS names:
 * for every running container it deletes and re-adds its A record. Nothing
 * deleted the name of a removed package, so it stayed in the bind until the
 * bind restarted (its entrypoint wipes the zones) and kept answering with an
 * IP that another container may have by now. And a recreated container
 * waited up to a minute for the next cron run.
 *
 * This module (adapted from DAppNode's nsupdate daemon, GPL-3.0) adds what
 * was missing, without changing the names the cron script writes:
 * - names of packages that are no longer installed are deleted;
 * - names of running packages are set to their current IP right away
 *   (called on install, remove and restart, and by the docker events watcher
 *   in watchers/dns).
 *
 * What is never written or deleted here:
 * - core names: the static records of the bind image (/config/<zone>.hosts),
 *   the names of every DAppNodeCore- container and installed core compose
 *   file, and a fixed list of core names;
 * - any record whose TTL is not the updater's 60 s;
 * - the names of installed packages that are stopped or being recreated
 *   (they keep their last record: a deleted name is cached as "does not
 *   exist" by clients for hours, a stopped one is only unreachable).
 */

const DNS_SERVER = params.DNS_SERVICE || "172.33.1.2";
const NETWORK = params.DNP_NETWORK || "dncore_network";
const PACKAGE_PREFIX = params.CONTAINER_NAME_PREFIX || "DAppNodePackage-";
const CORE_PREFIX = params.CONTAINER_CORE_NAME_PREFIX || "DAppNodeCore-";
const BIND_CONTAINER = `${CORE_PREFIX}bind.dnp.dappnode.eth`;
const TTL = 60;

// The zones the bind lets the DAPPMANAGER update, with the name rules of
// build/dns_updater.sh: remove the container prefix, then these parts
// (each everywhere, in this order, like sed s/...//g), then every "/" and "_"
const ZONES = [
  { zone: "eth", strip: [], name: base => `my.${base}` },
  {
    zone: "dappnode",
    strip: [".dappnode.eth", ".dnp"],
    name: base => `${base}.dappnode`
  },
  {
    zone: "avado",
    strip: [".dappnode.eth", ".dnp"],
    name: base => `${base}.avado`
  },
  {
    zone: "avadopackage.com",
    strip: [".dappnode.eth", ".dnp", ".public", ".avado"],
    name: base => `${base}.avadopackage.com`
  },
  {
    zone: "my.ava.do",
    strip: [".dappnode.eth", ".dnp", ".public", ".avado"],
    name: base => `${base}.my.ava.do`,
    // The cron script also writes the core containers' names in this zone
    withCore: true
  }
];
const ZONE_NAMES = ZONES.map(z => z.zone);

// Core names, protected even when their container or compose file is missing
const CORE_NAMES = [
  "admin",
  "bind",
  "dappmanager",
  "ethchain",
  "ethforward",
  "fullnode",
  "ipfs",
  "my",
  "remoteconnect",
  "vpn",
  "wamp",
  "wifi"
];

const replaceAll = (s, part) => s.split(part).join("");

/**
 * DNS names the cron script gives a container, per zone
 * @param {string} containerName "DAppNodePackage-care.avado.dnp.dappnode.eth"
 * @returns {{ zone: string, name: string }[]} lower case, no trailing dot;
 *   [] for a name that is not a package or core container
 */
function namesOfContainer(containerName) {
  const raw = String(containerName || "").replace(/^\//, "");
  const prefix = raw.startsWith(PACKAGE_PREFIX)
    ? PACKAGE_PREFIX
    : raw.startsWith(CORE_PREFIX)
    ? CORE_PREFIX
    : null;
  if (!prefix) return [];
  const names = [];
  for (const def of ZONES) {
    let base = replaceAll(raw, prefix);
    for (const part of def.strip) base = replaceAll(base, part);
    base = base.replace(/[/_]/g, "");
    if (!base) continue;
    names.push({ zone: def.zone, name: def.name(base).toLowerCase() });
  }
  return names;
}

const isPackageContainer = name =>
  String(name || "").replace(/^\//, "").startsWith(PACKAGE_PREFIX);
const isCoreContainer = name =>
  String(name || "").replace(/^\//, "").startsWith(CORE_PREFIX);

/**
 * The IP the name should point at: the one on the box network, else the
 * first one a container has
 * @param {Object<string, string>} networks { networkName: ip }
 * @returns {string} "" when it has none (stopped)
 */
function ipOf(networks) {
  const nets = networks || {};
  if (nets[NETWORK]) return nets[NETWORK];
  for (const ip of Object.values(nets)) if (ip) return ip;
  return "";
}

/**
 * Reads the output of named-compilezone -s full
 * "mcp.my.ava.do.   60 IN A   172.33.0.7"
 * @param {string} text
 * @returns {Map<string, { ttl: number, ips: string[] }>} A records by name
 */
function parseZoneDump(text) {
  const records = new Map();
  for (const line of String(text || "").split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length < 5 || t[2] !== "IN" || t[3] !== "A") continue;
    if (!/^\d+$/.test(t[1])) continue;
    const name = t[0].replace(/\.$/, "").toLowerCase();
    const rec = records.get(name) || { ttl: Number(t[1]), ips: [] };
    rec.ips.push(t[4]);
    records.set(name, rec);
  }
  return records;
}

// One docker exec into the bind reads every zone as it is now (master file
// plus journal) and the image's static zone files. Read only.
const DUMP_SCRIPT = `
for z in ${ZONE_NAMES.join(" ")}; do
  echo "#zone live $z"
  named-compilezone -j -n ignore -k ignore -i none -f text -F text -s full -o - "$z" "/etc/bind/$z.hosts" 2>/dev/null || echo "#failed"
  echo "#zone static $z"
  named-compilezone -n ignore -k ignore -i none -f text -F text -s full -o - "$z" "/config/$z.hosts" 2>/dev/null || echo "#failed"
done
`;

/**
 * Splits the dump into { live: { zone: Map }, static: { zone: Map } };
 * a zone that could not be read is left out
 * @param {string} text
 */
function parseDump(text) {
  const out = { live: {}, static: {} };
  const sections = String(text || "").split(/^#zone /m).slice(1);
  for (const section of sections) {
    const nl = section.indexOf("\n");
    const [kind, zone] = section.slice(0, nl < 0 ? undefined : nl).trim().split(/\s+/);
    const body = nl < 0 ? "" : section.slice(nl + 1);
    if (!out[kind] || !ZONE_NAMES.includes(zone)) continue;
    if (/^#failed\s*$/m.test(body)) continue;
    const records = parseZoneDump(body);
    // A zone always has its own apex: without it, the read went wrong
    if (!records.size && !/\sIN\s+SOA\s/.test(body)) continue;
    out[kind][zone] = records;
  }
  return out;
}

async function readZones() {
  const res = await run("docker", ["exec", BIND_CONTAINER, "sh", "-c", DUMP_SCRIPT], {
    timeout: 20 * 1000
  });
  if (res.code !== 0) {
    const line = (res.stderr || res.stdout || "").trim().split("\n")[0];
    throw Error(`cannot read the zones from the bind: ${line || `exit ${res.code}`}`);
  }
  return parseDump(res.stdout);
}

/**
 * Container names of every installed package and core package, from the
 * compose files (a package being recreated has no container for a moment)
 * @returns {string[]}
 */
function installedContainerNames() {
  const names = [];
  const repoDir = params.REPO_DIR;
  let entries = [];
  try {
    entries = fs.readdirSync(repoDir);
  } catch (e) {
    return names;
  }
  const fromCompose = (file, fallback) => {
    try {
      const compose = yaml.safeLoad(fs.readFileSync(file, "utf8")) || {};
      const services = compose.services || {};
      let found = false;
      for (const service of Object.values(services)) {
        if (service && service.container_name) {
          names.push(String(service.container_name));
          found = true;
        }
      }
      if (!found && fallback) names.push(fallback);
    } catch (e) {
      if (fallback && fs.existsSync(file)) names.push(fallback);
    }
  };
  for (const entry of entries) {
    if (entry === params.DNCORE_DIR) {
      let coreFiles = [];
      try {
        coreFiles = fs.readdirSync(path.join(repoDir, entry));
      } catch (e) {
        coreFiles = [];
      }
      for (const f of coreFiles)
        if (/^docker-compose.*\.ya?ml$/.test(f))
          fromCompose(path.join(repoDir, entry, f), null);
      continue;
    }
    const file = getPath.dockerCompose(entry, params);
    if (fs.existsSync(file)) fromCompose(file, PACKAGE_PREFIX + entry);
  }
  return names;
}

/**
 * Decides the nsupdate instructions. Pure, for the tests.
 *
 * @param {object} arg
 * @param {{ name: string, networks: object }[]} arg.containers every container
 * @param {string[]} arg.installed container names from the compose files
 * @param {object} arg.live { zone: Map } current A records (zones that could be read)
 * @param {object} arg.static { zone: Map } static records of the bind image
 * @param {string[]} arg.removed package names just removed (used when a zone can't be read)
 * @returns {{ zone: string, deletes: string[], sets: { name: string, ip: string }[] }[]}
 */
function plan({ containers = [], installed = [], live = {}, static: statics = {}, removed = [] }) {
  const zoneSet = () => {
    const o = {};
    for (const z of ZONE_NAMES) o[z] = new Set();
    return o;
  };
  const protectedNames = zoneSet();
  const keep = zoneSet();
  const wanted = {};
  const ambiguous = zoneSet();
  for (const z of ZONE_NAMES) wanted[z] = new Map();

  const protect = containerName => {
    for (const { zone, name } of namesOfContainer(containerName))
      protectedNames[zone].add(name);
  };
  for (const core of CORE_NAMES) {
    protect(`${CORE_PREFIX}${core}.dnp.dappnode.eth`);
    protect(`${CORE_PREFIX}${core}.avado.dnp.dappnode.eth`);
  }
  for (const z of ZONE_NAMES) protectedNames[z].add(z);
  for (const [z, records] of Object.entries(statics))
    if (protectedNames[z]) for (const name of records.keys()) protectedNames[z].add(name);

  const allNames = [...containers.map(c => c.name), ...installed];
  for (const n of allNames) if (isCoreContainer(n)) protect(n);

  // Installed packages keep their names, running or not
  for (const n of allNames)
    if (isPackageContainer(n))
      for (const { zone, name } of namesOfContainer(n)) keep[zone].add(name);

  // Running packages: their names point at their IP
  for (const c of containers) {
    if (!isPackageContainer(c.name)) continue;
    const ip = ipOf(c.networks);
    if (!ip) continue;
    for (const { zone, name } of namesOfContainer(c.name)) {
      const prev = wanted[zone].get(name);
      if (prev && prev !== ip) ambiguous[zone].add(name);
      wanted[zone].set(name, ip);
    }
  }

  const removedNames = zoneSet();
  for (const id of removed || [])
    for (const { zone, name } of namesOfContainer(PACKAGE_PREFIX + id))
      removedNames[zone].add(name);

  const out = [];
  for (const z of ZONE_NAMES) {
    const isProtected = name =>
      protectedNames[z].has(name) || name.includes("*") || !name.endsWith(`.${z}`);
    const deletes = new Set();
    const sets = [];
    const records = live[z];

    for (const [name, ip] of wanted[z]) {
      if (isProtected(name) || ambiguous[z].has(name)) continue;
      const rec = records && records.get(name);
      // Same as the cron script when the zone could not be read
      if (!records || !rec || rec.ips.length !== 1 || rec.ips[0] !== ip || rec.ttl !== TTL)
        sets.push({ name, ip });
    }

    const mayDelete = name =>
      !isProtected(name) && !keep[z].has(name) && !wanted[z].has(name);
    if (records && statics[z]) {
      for (const [name, rec] of records)
        if (rec.ttl === TTL && mayDelete(name)) deletes.add(name);
    } else {
      // The zone (or the static list) could not be read: delete only what was
      // just removed, if it is not someone else's name
      for (const name of removedNames[z])
        if (mayDelete(name) && (!records || records.has(name))) deletes.add(name);
    }

    if (deletes.size || sets.length)
      out.push({ zone: z, deletes: [...deletes].sort(), sets });
  }
  return out;
}

/**
 * nsupdate input for one zone
 * @param {{ zone: string, deletes: string[], sets: { name: string, ip: string }[] }} change
 */
function nsupdateText({ zone, deletes, sets }) {
  const lines = [`server ${DNS_SERVER}`, `zone ${zone}.`];
  for (const name of deletes) lines.push(`update delete ${name} A`);
  for (const { name, ip } of sets) {
    lines.push(`update delete ${name} A`);
    lines.push(`update add ${name} ${TTL} A ${ip}`);
  }
  lines.push("send", "");
  return lines.join("\n");
}

/**
 * Runs nsupdate with the instructions on stdin (like DAppNode's execNsupdate)
 * @param {string} text
 */
function execNsupdate(text) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("nsupdate", ["-v", "-t", "10"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    let output = "";
    const collect = chunk => {
      if (output.length < 4096) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 1000);
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(Error(`nsupdate failed (exit ${code}): ${output.trim().split("\n")[0] || ""}`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}

/**
 * One full pass: read docker and the bind, then fix the differences
 * @param {{ removed?: string[] }} options
 * @returns {Promise<{ deleted: string[], set: string[], zonesRead: string[] }>}
 */
async function syncOnce({ removed = [] } = {}) {
  const containers = await dockerList.listContainerAddresses();
  const installed = installedContainerNames();
  let zones = { live: {}, static: {} };
  try {
    zones = await readZones();
  } catch (e) {
    logs.warn(`DNS: ${e.message}; only updating the names of running packages`);
  }
  const changes = plan({
    containers,
    installed,
    live: zones.live,
    static: zones.static,
    removed
  });
  const deleted = [];
  const set = [];
  const errors = [];
  for (const change of changes) {
    try {
      await execNsupdate(nsupdateText(change));
      deleted.push(...change.deletes);
      set.push(...change.sets.map(s => `${s.name}=${s.ip}`));
    } catch (e) {
      errors.push(`${change.zone}: ${e.message}`);
    }
  }
  // One line each, with the my.ava.do names (the others follow the same packages)
  const short = list => {
    const mine = list.filter(n => /\.my\.ava\.do(=|$)/.test(n));
    return `${(mine.length ? mine : list).join(", ")} (${list.length} records)`;
  };
  if (deleted.length) logs.info(`DNS: removed the names of packages that are gone: ${short(deleted)}`);
  if (set.length) logs.info(`DNS: updated ${short(set)}`);
  if (errors.length) throw Error(`DNS update failed for ${errors.join("; ")}`);
  return { deleted, set, zonesRead: Object.keys(zones.live) };
}

// One pass at a time; calls that arrive during a pass share the next one
let active = null;
let next = null;
const pendingRemoved = new Set();

function startPass() {
  const removed = [...pendingRemoved];
  pendingRemoved.clear();
  active = syncOnce({ removed }).finally(() => {
    active = null;
  });
  return active;
}

/**
 * Brings the package names in line with the containers
 * @param {{ removed?: string[] }} options removed: packages just removed
 * @returns {Promise} rejects when an nsupdate failed
 */
function sync({ removed = [] } = {}) {
  for (const id of removed || []) if (id) pendingRemoved.add(id);
  if (next) return next;
  if (active) {
    next = active
      .catch(() => {})
      .then(() => {
        next = null;
        return startPass();
      });
    return next;
  }
  return startPass();
}

/**
 * sync that never rejects and never takes longer than `timeout`, for calls
 * that must not fail or hang because of the DNS (install, remove, restart)
 * @param {{ removed?: string[] }} options
 * @param {number} timeout ms
 */
async function syncSafe(options, timeout = 30 * 1000) {
  let timer;
  try {
    await Promise.race([
      sync(options),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("timed out")), timeout);
      })
    ]);
  } catch (e) {
    logs.warn(`DNS: could not update the package names: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sync,
  syncSafe,
  // for the watcher and the tests
  BIND_CONTAINER,
  NETWORK,
  TTL,
  ZONE_NAMES,
  namesOfContainer,
  isPackageContainer,
  ipOf,
  parseZoneDump,
  parseDump,
  plan,
  nsupdateText,
  installedContainerNames,
  syncOnce
};
