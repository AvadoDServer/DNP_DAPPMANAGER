const shell = require("utils/shell");
const dockerList = require("modules/dockerList");
const { shortNameCapitalized } = require("utils/strings");
const db = require("db");
const logs = require("logs.js")(module);

/**
 * Finds Docker volumes that no container uses but that hold a package's data,
 * e.g. after an update created a new, empty volume under a different compose
 * project name (compose v1 vs v2) and the data stayed in the old one.
 *
 * Two kinds of candidates:
 * - confidence "high": the volume has the package's name under another
 *   compose project-name spelling and the same compose volume key
 * - confidence "low": an anonymous volume (64 hex) that shares a meaningful
 *   top-level name with the package's only volume. Only offered on the
 *   package page (findLostData), never as a Home finding (listLostData),
 *   never to a validator / consensus client (their data holds keys), and
 *   never when it would fit more than one package.
 *
 * Cost: listLostData runs one `docker volume ls`, the container list and one
 * db read; busybox only runs when an unused volume matches a package by
 * name. findLostData and recoverLostData also look at unused anonymous
 * volumes: one batched, read-only `ls -A` over them and the single volumes
 * of the packages. `du -sk` only runs for the final candidates.
 */

// Every volume name is checked against this before it is put in a command
const VOLUME_REGEX = /^[A-Za-z0-9_.-]+$/;
const ANONYMOUS_REGEX = /^[0-9a-f]{64}$/;
// Packages whose data holds validator keys: never offered anonymous volumes
const VALIDATOR_REGEX = /teku|nimbus|lighthouse|prysm|validator|eth2/i;
// Top-level names too common to tie an anonymous volume to a package
const GENERIC_ENTRIES = new Set([
  "settings.json",
  "settings",
  "data",
  "config",
  "keys",
  "logs",
  "db",
  "validators",
  "validator"
]);
const PROBE_TIMEOUT = 5 * 60 * 1000;
const PROBE_BATCH = 20;
// db key: [{ volume, package, at }] of volumes recoverLostData copied from
const RECOVERED_KEY = "lostDataRecovered";

const norm = s =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const isValidVolume = name => typeof name === "string" && VOLUME_REGEX.test(name);
const isGeneric = entry =>
  entry.startsWith(".") || GENERIC_ENTRIES.has(entry.toLowerCase());
const underscores = name => {
  const positions = [];
  for (let i = name.indexOf("_"); i > 0; i = name.indexOf("_", i + 1)) {
    positions.push(i);
  }
  return positions;
};

/**
 * Compose volume key of a live volume: the part after the first `_` whose
 * prefix is the package name in some project-name spelling, e.g.
 * nethermindavadodnpdappnodeeth_nethermind_db -> nethermind_db
 * @returns {string|null}
 */
function keyOf(volume, id) {
  for (const i of underscores(volume)) {
    if (norm(volume.slice(0, i)) === norm(id)) return volume.slice(i + 1) || null;
  }
  return null;
}

/**
 * Key of `volume` when it is `<prefix>_<key>` with prefix the package name in
 * any spelling and key one of `keys`
 * @returns {string|null}
 */
function matchKey(volume, id, keys) {
  for (const i of underscores(volume)) {
    const key = volume.slice(i + 1);
    if (keys.has(key) && norm(volume.slice(0, i)) === norm(id)) return key;
  }
  return null;
}

let probeSeq = 0;
const probeName = kind => `lostdata-${kind}-${Date.now()}-${++probeSeq}`;

/**
 * Runs a read-only busybox command in a named container. When the shell
 * fails or times out the container is removed by name: a timeout kills only
 * the docker client.
 */
async function runProbe(kind, mounts, cmd) {
  for (const { volume } of mounts) {
    if (!isValidVolume(volume)) throw Error("unexpected volume name");
  }
  const name = probeName(kind);
  const args = mounts.map(m => `-v ${m.volume}:${m.dir}:ro`).join(" ");
  try {
    return await shell(`docker run --rm --name ${name} ${args} busybox ${cmd}`, {
      timeout: PROBE_TIMEOUT
    });
  } catch (e) {
    await shell(`docker rm -f ${name}`).catch(() => {});
    throw e;
  }
}

/**
 * Top-level entries (first 50) of each volume, several volumes per busybox
 * run. A batch that fails is retried one volume at a time.
 * @param {string[]} volumes validated volume names
 * @returns {Promise<Map<string, string[]|null>>} null when it could not be read
 */
async function listEntries(volumes) {
  const result = new Map();
  const runBatch = async batch => {
    const mounts = batch.map((volume, i) => ({ volume, dir: `/v${i}` }));
    const dirs = mounts.map(m => m.dir).join(" ");
    const out = await runProbe(
      "ls",
      mounts,
      `sh -c 'for d in ${dirs}; do echo "__VOL__ $d"; ls -A "$d" | head -50; done'`
    );
    const byDir = new Map();
    let current = null;
    for (const line of out.split("\n")) {
      const marker = line.match(/^__VOL__ (\/v\d+)$/);
      if (marker) {
        current = [];
        byDir.set(marker[1], current);
      } else if (current && line.trim()) {
        current.push(line.trim());
      }
    }
    for (const m of mounts) result.set(m.volume, byDir.get(m.dir) || null);
  };
  for (let i = 0; i < volumes.length; i += PROBE_BATCH) {
    const batch = volumes.slice(i, i + PROBE_BATCH);
    try {
      await runBatch(batch);
    } catch (e) {
      if (batch.length === 1) {
        logs.warn(`lostData: cannot read volume ${batch[0]}: ${e.message}`);
        result.set(batch[0], null);
        continue;
      }
      for (const volume of batch) {
        try {
          await runBatch([volume]);
        } catch (e2) {
          logs.warn(`lostData: cannot read volume ${volume}: ${e2.message}`);
          result.set(volume, null);
        }
      }
    }
  }
  return result;
}

/**
 * @returns {Promise<number|null>} du -sk of the volume, null on failure
 */
async function sizeKbOf(volume) {
  try {
    const out = await runProbe("du", [{ volume, dir: "/vol" }], "du -sk /vol");
    const kb = parseInt(String(out).trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb : null;
  } catch (e) {
    logs.warn(`lostData: cannot measure volume ${volume}: ${e.message}`);
    return null;
  }
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
 * Volumes recoverLostData already copied from. They stay on disk (nothing is
 * ever deleted), so without this list they would be offered again forever.
 * @returns {Promise<Array<{volume, package, at}>>}
 */
async function getRecovered() {
  try {
    const list = await db.get(RECOVERED_KEY);
    return Array.isArray(list)
      ? list.filter(r => r && typeof r.volume === "string")
      : [];
  } catch (e) {
    logs.warn(`lostData: cannot read ${RECOVERED_KEY}: ${e.message}`);
    return [];
  }
}

/**
 * Remembers that the data of `volume` was recovered into package `id`
 */
async function markRecovered(volume, id) {
  const list = (await getRecovered()).filter(r => r.volume !== volume);
  list.push({ volume, package: id, at: new Date().toISOString() });
  await db.set(RECOVERED_KEY, list);
}

/**
 * @param {object} [options]
 * @param {string} [options.id] limit the result to this package
 * @param {boolean} [options.includeAnonymous] also look at anonymous volumes
 * (confidence "low"); listLostData leaves them out
 * @returns {Promise<Array<{package, title, live, candidates, recovered}>>}
 * one entry per installed non-core package (only `id` when given),
 * candidates and recovered may be empty
 */
async function scan({ id, includeAnonymous = true } = {}) {
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

  // Volumes already recovered are never offered again
  const recovered = await getRecovered();
  const recoveredNames = new Set(recovered.map(r => r.volume));

  const unused = [];
  for (const name of allVolumes) {
    if (mounted.has(name) || recoveredNames.has(name)) continue;
    if (!isValidVolume(name)) {
      logs.warn(`lostData: ignoring volume with unexpected name ${JSON.stringify(name)}`);
      continue;
    }
    unused.push(name);
  }

  // Named live volumes of every non-core package (a package can have several
  // containers). All packages are needed even for one `id`: an anonymous
  // volume that fits two packages is offered to none.
  const packages = new Map();
  for (const c of containers) {
    if (!c.name || c.isCore) continue;
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
  const inScope = name => !id || name === id;

  // 1. Name match, confidence "high"
  const drafts = [];
  for (const [name, live] of packages) {
    if (!inScope(name)) continue;
    const keys = new Map();
    for (const l of live) {
      const key = keyOf(l.name, name);
      if (key && !keys.has(key)) keys.set(key, l.name);
    }
    if (keys.size === 0) continue;
    for (const v of unused) {
      const key = matchKey(v, name, keys);
      if (key) {
        drafts.push({ package: name, name: v, anonymous: false, confidence: "high", target: keys.get(key) });
      }
    }
  }
  if (drafts.length > 0) {
    const entries = await listEntries([...new Set(drafts.map(d => d.name))]);
    for (const d of drafts) d.entries = entries.get(d.name);
  }

  // 2. Anonymous, confidence "low"
  const anonymous = unused.filter(v => ANONYMOUS_REGEX.test(v));
  const single = [...packages].filter(([, live]) => live.length === 1);
  const canReceive = name => inScope(name) && !VALIDATOR_REGEX.test(name);
  if (includeAnonymous && anonymous.length > 0 && single.some(([name]) => canReceive(name))) {
    const entries = await listEntries([
      ...anonymous,
      ...new Set(single.map(([, live]) => live[0].name))
    ]);
    // A package whose volume cannot be read could be the owner: offer nothing
    const unreadable = single.filter(([, live]) => !entries.get(live[0].name));
    if (unreadable.length > 0) {
      logs.warn(`lostData: not offering anonymous volumes, cannot read ${unreadable.map(([n]) => n).join(", ")}`);
    } else {
      for (const v of anonymous) {
        const own = entries.get(v);
        if (!own || own.length === 0) continue;
        const meaningful = own.filter(e => !isGeneric(e));
        const fits = single.filter(([, live]) =>
          meaningful.some(e => entries.get(live[0].name).includes(e))
        );
        if (fits.length !== 1) {
          if (fits.length > 1) {
            logs.info(`lostData: anonymous volume ${v} fits ${fits.map(([n]) => n).join(", ")}, offered to none`);
          }
          continue;
        }
        const [name, live] = fits[0];
        if (!canReceive(name)) continue;
        drafts.push({ package: name, name: v, anonymous: true, confidence: "low", target: live[0].name, entries: own });
      }
    }
  }

  // 3. Size and creation date, only for the volumes that are left
  const candidatesOf = new Map();
  for (const d of drafts) {
    if (!d.entries || d.entries.length === 0) continue;
    const sizeKb = await sizeKbOf(d.name);
    if (sizeKb === null) continue;
    if (!candidatesOf.has(d.package)) candidatesOf.set(d.package, []);
    candidatesOf.get(d.package).push({
      name: d.name,
      anonymous: d.anonymous,
      confidence: d.confidence,
      createdAt: await createdAt(d.name),
      entries: d.entries,
      sizeKb,
      target: d.target
    });
  }

  const result = [];
  for (const [name, live] of packages) {
    if (!inScope(name)) continue;
    result.push({
      package: name,
      title: shortNameCapitalized(name),
      live,
      candidates: candidatesOf.get(name) || [],
      recovered: recovered
        .filter(r => r.package === name)
        .map(r => ({ volume: r.volume, at: r.at || null }))
    });
  }
  return result;
}

module.exports = {
  scan,
  markRecovered,
  VOLUME_REGEX
};
