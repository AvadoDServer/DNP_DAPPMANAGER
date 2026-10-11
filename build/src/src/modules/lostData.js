const shell = require("utils/shell");
const dockerList = require("modules/dockerList");
const { shortNameCapitalized } = require("utils/strings");
const logs = require("logs.js")(module);

/**
 * Finds Docker volumes that no container uses but that hold a package's data,
 * e.g. after an update created a new, empty volume under a different compose
 * project name (compose v1 vs v2) and the data stayed in the old one.
 *
 * Cost: one `docker volume ls` plus the container list. A busybox probe only
 * runs when an unused volume matches a package by name, or when an unused
 * anonymous volume exists and a package has exactly one named volume. On a
 * healthy box nothing else runs. Probes are read-only and run one at a time,
 * each volume at most once per scan.
 */

// Every volume name is checked against this before it is put in a command
const VOLUME_REGEX = /^[A-Za-z0-9_.-]+$/;
const ANONYMOUS_REGEX = /^[0-9a-f]{64}$/;
const PROBE_TIMEOUT = 5 * 60 * 1000;

const alnum = s => String(s).replace(/[^a-z0-9]/g, "");
const shortOf = name => name.slice(name.lastIndexOf("_") + 1);
const isValidVolume = name => typeof name === "string" && VOLUME_REGEX.test(name);

/**
 * Top-level entries (first 50) and size of a volume, mounted read-only
 * @param {string} volume validated volume name
 * @returns {Promise<{entries: string[], sizeKb: number}>}
 */
async function probe(volume) {
  if (!isValidVolume(volume)) throw Error("unexpected volume name");
  const out = await shell(
    `docker run --rm -v ${volume}:/vol:ro busybox sh -c 'ls -A /vol | head -50; echo __SIZE__; du -sk /vol'`,
    { timeout: PROBE_TIMEOUT }
  );
  const [list, size = ""] = out.split("__SIZE__");
  const entries = list
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
  const sizeKb = parseInt(size.trim().split(/\s+/)[0], 10);
  return { entries, sizeKb: Number.isFinite(sizeKb) ? sizeKb : 0 };
}

async function createdAt(volume) {
  try {
    const out = await shell(
      `docker volume inspect --format '{{.CreatedAt}}' ${volume}`
    );
    return (out || "").trim() || null;
  } catch (e) {
    logs.warn(`lostData: cannot inspect volume ${volume}: ${e.message}`);
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.id] limit the scan to this package
 * @returns {Promise<Array<{package, title, live, candidates}>>} one entry per
 * installed non-core package (only `id` when given), candidates may be empty
 */
async function scan({ id } = {}) {
  // Volumes first: a volume created after this point (an install in
  // progress) is not seen at all, rather than seen without its container.
  const allVolumes = (await shell(`docker volume ls --format '{{.Name}}'`))
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);
  const containers = (await dockerList.listContainers()) || [];

  // A volume is used when any container mounts it, running or not, also a
  // container that is not a package
  const mounted = new Set(
    ((await dockerList.listMountedVolumeNames()) || []).filter(Boolean)
  );
  for (const c of containers) {
    for (const v of c.volumes || []) if (v.name) mounted.add(v.name);
  }

  const unused = [];
  for (const name of allVolumes) {
    if (mounted.has(name)) continue;
    if (!isValidVolume(name)) {
      logs.warn(`lostData: ignoring volume with unexpected name ${JSON.stringify(name)}`);
      continue;
    }
    unused.push(name);
  }

  // Named live volumes per non-core package (a package can have several
  // containers)
  const packages = new Map();
  for (const c of containers) {
    if (!c.name || c.isCore) continue;
    if (id && c.name !== id) continue;
    if (!packages.has(c.name)) packages.set(c.name, []);
    const live = packages.get(c.name);
    for (const v of c.volumes || []) {
      if (v.type !== "volume" || !v.name || ANONYMOUS_REGEX.test(v.name)) continue;
      if (!isValidVolume(v.name)) {
        logs.warn(`lostData: ignoring live volume with unexpected name ${JSON.stringify(v.name)}`);
        continue;
      }
      if (live.some(l => l.name === v.name)) continue;
      live.push({ name: v.name, mountPath: v.mountPath || null });
    }
  }

  // Each volume is probed at most once per scan; a failure is kept as null
  const probes = new Map();
  const probeOnce = async volume => {
    if (!probes.has(volume)) {
      try {
        probes.set(volume, await probe(volume));
      } catch (e) {
        logs.warn(`lostData: cannot read volume ${volume}: ${e.message}`);
        probes.set(volume, null);
      }
    }
    return probes.get(volume);
  };

  const anonymous = unused.filter(v => ANONYMOUS_REGEX.test(v));
  const entries = [];
  for (const [name, live] of packages) {
    const candidates = [];
    const byShort = new Map();
    for (const l of live) {
      const short = shortOf(l.name);
      if (!byShort.has(short)) byShort.set(short, l.name);
    }

    // Name match: <prefix>_<short> where prefix is the package name in any
    // compose project-name spelling
    for (const v of unused) {
      const i = v.lastIndexOf("_");
      if (i <= 0) continue;
      const short = v.slice(i + 1);
      if (!byShort.has(short) || alnum(v.slice(0, i)) !== alnum(name)) continue;
      const p = await probeOnce(v);
      if (!p || p.entries.length === 0) continue;
      candidates.push({ name: v, anonymous: false, entries: p.entries, sizeKb: p.sizeKb, target: byShort.get(short) });
    }

    // Anonymous: only with exactly one live volume, and only when it shares
    // a top-level entry with it
    if (live.length === 1 && anonymous.length > 0) {
      const target = live[0].name;
      const liveProbe = await probeOnce(target);
      if (liveProbe) {
        const liveEntries = new Set(liveProbe.entries);
        for (const v of anonymous) {
          const p = await probeOnce(v);
          if (!p || p.entries.length === 0) continue;
          if (!p.entries.some(e => liveEntries.has(e))) continue;
          candidates.push({ name: v, anonymous: true, entries: p.entries, sizeKb: p.sizeKb, target });
        }
      }
    }

    for (const c of candidates) c.createdAt = await createdAt(c.name);

    entries.push({
      package: name,
      title: shortNameCapitalized(name),
      live,
      candidates: candidates.map(c => ({
        name: c.name,
        anonymous: c.anonymous,
        createdAt: c.createdAt,
        entries: c.entries,
        sizeKb: c.sizeKb,
        target: c.target
      }))
    });
  }
  return entries;
}

module.exports = {
  scan,
  VOLUME_REGEX
};
