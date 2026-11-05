#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Runs INSIDE the short-lived backup container (the DAPPMANAGER's own image,
 * started by modules/backup/runner.js), never in the DAPPMANAGER itself.
 *
 * stdin, line 1: the job as JSON, secrets included (passphrase, NAS
 * password). They are written to /run/secrets (a tmpfs of this container
 * only) for restic and mount.cifs, and never printed.
 * stdin, later lines: "go" after the DAPPMANAGER paused a package.
 * stdout: one JSON object per line, { ev: ... }; the last one is
 * { ev: "result", ... } or { ev: "error", code, message }.
 *
 * Layout on the backup disk or NAS folder:
 *   AVADO-backups/README.txt                 how to restore without an AVADO
 *   AVADO-backups/<box id>/repo/             restic repository (encrypted)
 *   AVADO-backups/<box id>/avado-backup.json plain list of backups: dates,
 *                                            app names, item names, sizes
 * In the repository each app is one snapshot per backup, tagged
 * avado, run-<id>, pkg-<name>, with its items under /avado/<name>/<item>.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const MNT = "/mnt/target";
const SECRETS = "/run/secrets";
const PW_FILE = `${SECRETS}/pw`;
const SMB_FILE = `${SECRETS}/smb`;
const STAGE = "/stage";
const AVADO = "/avado";
const BASE_DIR = "AVADO-backups";
const ASIDE = "avado-before-restore";
const INDEX = "avado-backup.json";

const out = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const log = message => out({ ev: "log", message });

class JobError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------ stdin ------------------------------ */

let rl = null;
const lines = [];
const waiters = [];
function openStdin() {
  rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", l => {
    if (waiters.length) waiters.shift()(l);
    else lines.push(l);
  });
  rl.on("close", () => {
    while (waiters.length) waiters.shift()(null);
  });
}
function nextLine() {
  if (lines.length) return Promise.resolve(lines.shift());
  return new Promise(resolve => waiters.push(resolve));
}

/* ------------------------------ processes ------------------------------ */

function sh(cmd, args, { allow = [0], input } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new JobError("tool", `${cmd}: ${r.error.message}`);
  if (!allow.includes(r.status)) {
    const err = new JobError("tool", `${cmd} ${args[0] || ""} exited ${r.status}: ${tail(r.stderr)}`);
    err.status = r.status;
    err.stderr = r.stderr || "";
    throw err;
  }
  return r;
}

const tail = s =>
  String(s || "")
    .trim()
    .split("\n")
    .slice(-3)
    .join(" | ")
    .slice(0, 400);

let repoPath = null;
function resticEnv(extra = {}) {
  return {
    ...process.env,
    RESTIC_REPOSITORY: repoPath,
    RESTIC_PASSWORD_FILE: PW_FILE,
    RESTIC_CACHE_DIR: "/cache",
    RESTIC_PROGRESS_FPS: "0.2",
    ...extra
  };
}

/** restic, waiting for the end; JSON status lines go to onJson */
function restic(args, { onJson, allow = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("restic", args, { env: resticEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    child.stdout.on("data", chunk => {
      const s = chunk.toString("utf8");
      if (onJson) {
        buf += s;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            onJson(JSON.parse(line));
          } catch (e) {
            // not JSON
          }
        }
      }
      if (stdout.length < 32 * 1024 * 1024) stdout += s;
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", e => reject(new JobError("tool", `restic: ${e.message}`)));
    child.on("close", code => {
      if (allow.includes(code)) return resolve({ code, stdout, stderr });
      reject(resticError(code, stderr, args[0]));
    });
  });
}

function resticError(code, stderr, what) {
  if (code === 12) return new JobError("wrongPassphrase", "The passphrase is wrong.");
  if (code === 10) return new JobError("noRepo", "There is no AVADO backup in this place.");
  if (code === 11) return new JobError("locked", "Another backup is using this disk right now. Try again later.");
  if (/no space left on device/i.test(stderr))
    return new JobError("full", "The backup disk is full. Use a bigger disk, or leave out large items.");
  if (/read-only file system/i.test(stderr)) return new JobError("readOnly", "The backup disk is read-only.");
  if (/input\/output error/i.test(stderr))
    return new JobError("io", "The backup disk could not be read or written. Check the cable, or try another disk.");
  return new JobError("restic", `restic ${what} failed (${code}): ${tail(stderr)}`);
}

/* ------------------------------ target ------------------------------ */

const FS_TYPES = new Set(["ext4", "ext3", "ext2", "exfat", "vfat", "ntfs", "xfs", "btrfs"]);
let mounted = false;

function mountTarget(target) {
  fs.mkdirSync(MNT, { recursive: true });
  if (target.type === "usb") {
    const dev = target.device;
    if (!/^\/dev\/[A-Za-z0-9/_-]{1,64}$/.test(dev || "")) throw new JobError("noDisk", "The backup disk was not found.");
    if (!fs.existsSync(dev)) throw new JobError("noDisk", "The backup disk was not found. Plug it in and try again.");
    const fstype = target.fstype;
    if (!FS_TYPES.has(fstype)) throw new JobError("badFs", "This disk's format can't be used for backups.");
    try {
      if (fstype === "ntfs") sh("ntfs-3g", [dev, MNT, "-o", "big_writes"]);
      else sh("mount", ["-t", fstype, "-o", "noatime", dev, MNT]);
    } catch (e) {
      throw new JobError("mountFailed", `The backup disk could not be opened (${tail(e.stderr || e.message)}).`);
    }
  } else if (target.type === "smb") {
    const host = String(target.host || "");
    const share = String(target.share || "");
    if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(host)) throw new JobError("badNas", "The NAS address is not valid.");
    if (!/^[^/\\\0\n]{1,80}$/.test(share)) throw new JobError("badNas", "The shared folder name is not valid.");
    const cred = [`username=${target.username || "guest"}`, `password=${target.password || ""}`];
    if (target.domain) cred.push(`domain=${target.domain}`);
    fs.writeFileSync(SMB_FILE, cred.join("\n") + "\n", { mode: 0o600 });
    const opts = ["credentials=" + SMB_FILE, "iocharset=utf8", "file_mode=0600", "dir_mode=0700", "noperm", "nobrl"];
    let last = null;
    for (const vers of target.vers ? [target.vers] : ["3.1.1", "3.0", "2.1"]) {
      try {
        sh("mount", ["-t", "cifs", `//${host}/${share}`, MNT, "-o", [...opts, `vers=${vers}`].join(",")]);
        last = null;
        break;
      } catch (e) {
        last = e;
      }
    }
    if (last) {
      const msg = last.stderr || "";
      if (/permission denied|error\(13\)/i.test(msg))
        throw new JobError("nasLogin", "The NAS refused the user name or password.");
      if (/no such file|error\(2\)|error\(6\)/i.test(msg))
        throw new JobError("nasShare", "The NAS has no shared folder with that name.");
      if (/host is down|unreachable|timed out|error\(112\)|error\(113\)|error\(115\)/i.test(msg))
        throw new JobError("nasDown", "The NAS did not answer. Check the address and that it is switched on.");
      throw new JobError("mountFailed", `The NAS folder could not be opened (${tail(msg)}).`);
    }
  } else {
    throw new JobError("noTarget", "No backup place is set up.");
  }
  mounted = true;
  const base = path.join(MNT, target.folder ? safeRel(target.folder) : "", BASE_DIR);
  return base;
}

function safeRel(p) {
  const parts = String(p)
    .split(/[\\/]+/)
    .filter(x => x && x !== "." && x !== "..");
  return parts.join("/");
}

function unmountTarget() {
  if (!mounted) return;
  spawnSync("sync", []);
  const r = spawnSync("umount", [MNT]);
  if (r.status !== 0) spawnSync("umount", ["-l", MNT]);
  mounted = false;
}

function writable(base) {
  try {
    fs.mkdirSync(base, { recursive: true });
    const probe = path.join(base, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function space(dir) {
  const r = spawnSync("df", ["-Pk", dir], { encoding: "utf8" });
  const line = String(r.stdout || "")
    .trim()
    .split("\n")[1];
  if (!line) return {};
  const f = line.split(/\s+/);
  return { total: Number(f[1]) * 1024, free: Number(f[3]) * 1024 };
}

const README = `AVADO backups
=============

This folder holds encrypted backups made by an AVADO box. Each box has its
own folder (named after its backup id) with:

  repo/              the backups, encrypted with the passphrase the owner
                     chose. Without that passphrase nobody can open them,
                     AVADO included.
  avado-backup.json  a plain list of the backups: dates, app names, sizes.

Restore on an AVADO: Admin > Backup > Restore.

Restore on a computer: the backups are a standard restic repository
(https://restic.net). Install restic, then for example:

  restic -r /path/to/AVADO-backups/<box id>/repo snapshots
  restic -r /path/to/AVADO-backups/<box id>/repo restore latest --target ./restored

It asks for the passphrase. Each app's files are under /avado/<app name>/.
`;

/* ------------------------------ repo ------------------------------ */

async function openRepo(base, repoId, { create }) {
  if (!/^[a-z0-9-]{4,64}$/.test(repoId || "")) throw new JobError("badRepo", "Unknown backup.");
  const boxDir = path.join(base, repoId);
  repoPath = path.join(boxDir, "repo");
  const exists = fs.existsSync(path.join(repoPath, "config"));
  if (!exists) {
    if (!create) throw new JobError("noRepo", "There is no AVADO backup in this place.");
    if (!writable(base)) throw new JobError("readOnly", "Nothing can be saved on the backup disk.");
    fs.mkdirSync(boxDir, { recursive: true });
    await restic(["init", "--json"]);
    try {
      fs.writeFileSync(path.join(base, "README.txt"), README);
    } catch (e) {
      // the README is a convenience
    }
    return { boxDir, created: true };
  }
  // Checks the passphrase
  await restic(["cat", "config"]);
  return { boxDir, created: false };
}

async function snapshots() {
  const { stdout } = await restic(["snapshots", "--json", "--tag", "avado"]);
  const list = JSON.parse(stdout || "[]") || [];
  return list.map(s => ({
    id: s.id,
    time: s.time,
    tags: s.tags || [],
    paths: s.paths || [],
    run: ((s.tags || []).find(t => t.startsWith("run-")) || "").slice(4),
    pkg: ((s.tags || []).find(t => t.startsWith("pkg-")) || "").slice(4),
    bytes: s.summary ? s.summary.total_bytes_processed : undefined
  }));
}

function readIndex(boxDir) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(boxDir, INDEX), "utf8"));
    return idx && typeof idx === "object" ? idx : null;
  } catch (e) {
    return null;
  }
}

/** Rewrites the plain list from the snapshots that exist now */
function writeIndex(boxDir, box, snaps, runMeta) {
  const prev = readIndex(boxDir) || {};
  const prevRuns = new Map((prev.runs || []).map(r => [r.id, r]));
  const runs = new Map();
  for (const s of snaps) {
    if (!s.run || !s.pkg) continue;
    if (!runs.has(s.run)) runs.set(s.run, { id: s.run, at: s.time, packages: [] });
    const r = runs.get(s.run);
    if (s.time < r.at) r.at = s.time;
    const items = [
      ...new Set(
        s.paths
          .map(p => p.split("/")[3])
          .filter(Boolean)
      )
    ];
    const meta = (runMeta && runMeta[s.run] && runMeta[s.run][s.pkg]) || findPrevPkg(prevRuns.get(s.run), s.pkg) || {};
    r.packages.push({ name: s.pkg, title: meta.title || undefined, items: meta.items || items, bytes: s.bytes });
  }
  const list = [...runs.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  const index = {
    format: 1,
    boxId: box.id,
    boxName: box.name || prev.boxName || "AVADO",
    updatedAt: new Date().toISOString(),
    runs: list
  };
  const tmp = path.join(boxDir, `.${INDEX}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, path.join(boxDir, INDEX));
  return index;
}

function findPrevPkg(run, pkg) {
  if (!run) return null;
  return (run.packages || []).find(p => p.name === pkg) || null;
}

function listRepos(base) {
  const repos = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch (e) {
    return repos;
  }
  for (const name of names) {
    const dir = path.join(base, name);
    if (!fs.existsSync(path.join(dir, "repo", "config"))) continue;
    const idx = readIndex(dir) || {};
    repos.push({ id: name, boxName: idx.boxName || null, updatedAt: idx.updatedAt || null, runs: idx.runs || [] });
  }
  return repos;
}

/* ------------------------------ files ------------------------------ */

/** Expands a relative pattern with * (one path part) inside `root` */
function expand(root, pattern) {
  const parts = safeRel(pattern).split("/");
  let found = [""];
  for (const part of parts) {
    const next = [];
    const re = new RegExp("^" + part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
    for (const rel of found) {
      const dir = path.join(root, rel);
      if (!part.includes("*")) {
        if (fs.existsSync(path.join(dir, part)) || isLink(path.join(dir, part))) next.push(path.join(rel, part));
        continue;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(dir);
      } catch (e) {
        continue;
      }
      for (const e of entries) if (re.test(e)) next.push(path.join(rel, e));
    }
    found = next;
  }
  return found.filter(Boolean).sort();
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    return false;
  }
}

function entriesOf(root, only) {
  if (Array.isArray(only) && only.length) return [...new Set(only.flatMap(p => expand(root, p)))];
  try {
    return fs.readdirSync(root).sort();
  } catch (e) {
    return [];
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

/** Copies the item's entries (or all of it) with owners and modes kept */
function stageCopy(src, dst, only) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = entriesOf(src, only);
  if (!entries.length) return 0;
  // tar exits 1 when a file changed while it was read: not an error here
  const r = spawnSync(
    "bash",
    [
      "-c",
      'set -o pipefail; src="$1"; dst="$2"; shift 2; tar -C "$src" -cpf - --numeric-owner -- "$@" | tar -C "$dst" -xpf - --numeric-owner',
      "stage",
      src,
      dst,
      ...entries
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (r.status !== 0 && r.status !== 1) throw new JobError("copy", `Could not copy ${src}: ${tail(r.stderr)}`);
  return entries.length;
}

function bindMount(src, dst, ro) {
  if (isDir(src)) fs.mkdirSync(dst, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, "");
  }
  sh("mount", ["--bind", src, dst]);
  if (ro) sh("mount", ["-o", "remount,bind,ro", dst], { allow: [0, 1, 32] });
}

function unmountAll(dir) {
  const r = spawnSync("sh", ["-c", `awk '{print $2}' /proc/mounts | grep '^${dir}/' | sort -r`], { encoding: "utf8" });
  for (const m of String(r.stdout || "")
    .split("\n")
    .filter(Boolean)) {
    if (spawnSync("umount", [m]).status !== 0) spawnSync("umount", ["-l", m]);
  }
}

/* ------------------------------ validator keys ------------------------------ */

const PUBKEY = /0x[0-9a-fA-F]{96}/g;

function pubkeysInText(text) {
  const keys = new Set();
  for (const m of String(text).match(PUBKEY) || []) keys.add(m.toLowerCase());
  // keystores: "pubkey": "<hex without 0x>"
  const re = /"pubkey"\s*:\s*"(0x)?([0-9a-fA-F]{96})"/g;
  let m;
  while ((m = re.exec(text))) keys.add("0x" + m[2].toLowerCase());
  return keys;
}

/** Validator public keys in a live directory, from names and keystore files */
function pubkeysInDir(root, keyGlobs) {
  const keys = new Set();
  for (const rel of (keyGlobs || []).flatMap(g => expand(root, g))) {
    for (const k of pubkeysInText(rel)) keys.add(k);
    const p = path.join(root, rel);
    if (/\.json$/i.test(rel) && !isDir(p)) {
      try {
        if (fs.statSync(p).size < 1024 * 1024) for (const k of pubkeysInText(fs.readFileSync(p, "utf8"))) keys.add(k);
      } catch (e) {
        // unreadable
      }
    }
  }
  return keys;
}

function globRe(rootPrefix, glob) {
  const body = safeRel(glob)
    .split("/")
    .map(p => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join("/");
  return new RegExp("^" + rootPrefix.replace(/[.+?^${}()|[\]\\]/g, "\\$&") + "/" + body + "$");
}

/** Validator public keys in a backup item, without restoring it */
async function pubkeysInSnapshot(snap, itemRoot, keyGlobs) {
  const keys = new Set();
  if (!keyGlobs || !keyGlobs.length) return keys;
  const res = keyGlobs.map(g => globRe(itemRoot, g));
  const { stdout } = await restic(["ls", "--json", "--recursive", snap, itemRoot]);
  const jsonFiles = [];
  for (const line of stdout.split("\n")) {
    let n;
    try {
      n = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (n.struct_type !== "node" && n.message_type !== "node") continue;
    if (!res.some(re => re.test(n.path))) continue;
    for (const k of pubkeysInText(n.path)) keys.add(k);
    if (n.type === "file" && /\.json$/i.test(n.path) && (n.size || 0) < 1024 * 1024) jsonFiles.push(n.path);
  }
  for (const f of jsonFiles.slice(0, 2000)) {
    const r = await restic(["dump", snap, f]);
    for (const k of pubkeysInText(r.stdout)) keys.add(k);
  }
  return keys;
}

/* ------------------------------ jobs ------------------------------ */

async function opProbe(job) {
  const base = mountTarget(job.target);
  const canWrite = writable(base);
  const sp = space(path.dirname(base));
  const repos = listRepos(base);
  return { writable: canWrite, ...sp, repos };
}

async function opInit(job) {
  const base = mountTarget(job.target);
  const { boxDir, created } = await openRepo(base, job.repo, { create: true });
  const snaps = await snapshots();
  writeIndex(boxDir, job.box || {}, snaps, null);
  return { created, ...space(base) };
}

async function opList(job) {
  const base = mountTarget(job.target);
  const { boxDir } = await openRepo(base, job.repo, { create: false });
  const snaps = await snapshots();
  const index = readIndex(boxDir) || {};
  return { snapshots: snaps, index };
}

async function opBackup(job) {
  const base = mountTarget(job.target);
  if (!writable(base)) throw new JobError("readOnly", "Nothing can be saved on the backup disk.");
  const { boxDir } = await openRepo(base, job.repo, { create: true });
  await restic(["unlock"], { allow: [0, 1] });
  const results = [];
  const runMeta = { [job.run.id]: {} };
  const total = job.packages.length;
  let n = 0;
  for (const pkg of job.packages) {
    n++;
    const res = { name: pkg.name, ok: false, items: [], warnings: [] };
    results.push(res);
    out({ ev: "package", name: pkg.name, n, total });
    const stageRoot = path.join(STAGE, pkg.name);
    const pkgRoot = path.join(AVADO, pkg.name);
    try {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      fs.mkdirSync(stageRoot, { recursive: true });
      const staged = pkg.items.filter(i => i.staged && i.src);
      // A short pause of the app, so database files are copied at one
      // moment (crash-consistent); the copy is local and quick.
      if (staged.length) {
        out({ ev: "pause", name: pkg.name });
        const answer = await nextLine();
        if (answer === null) throw new JobError("aborted", "The backup was stopped.");
        const t0 = Date.now();
        try {
          for (const item of staged) {
            if (!fs.existsSync(item.src)) {
              res.warnings.push(`${item.name}: nothing to back up yet`);
              continue;
            }
            stageCopy(item.src, path.join(stageRoot, item.name), isDir(item.src) ? item.only : null);
          }
        } finally {
          out({ ev: "resume", name: pkg.name, ms: Date.now() - t0 });
        }
      }
      // Settings (env) and what was backed up, as files of the snapshot
      const settingsDir = path.join(stageRoot, "settings");
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(path.join(settingsDir, "env.json"), JSON.stringify(pkg.env || {}, null, 2), { mode: 0o600 });
      fs.writeFileSync(
        path.join(settingsDir, "backup.json"),
        JSON.stringify(
          {
            name: pkg.name,
            title: pkg.title,
            version: pkg.version,
            origin: pkg.origin,
            items: pkg.items.map(i => ({ name: i.name, label: i.label, path: i.path, large: !!i.large, validator: !!i.validator, keys: i.keys })),
            at: job.run.at
          },
          null,
          2
        )
      );
      // Same paths every time (/avado/<app>/<item>), so restic finds the last
      // snapshot and only reads changed files of large items.
      const paths = [path.join(pkgRoot, "settings")];
      bindMount(settingsDir, path.join(pkgRoot, "settings"), true);
      for (const item of pkg.items) {
        const dst = path.join(pkgRoot, item.name);
        if (item.staged) {
          const s = path.join(stageRoot, item.name);
          if (!fs.existsSync(s)) continue;
          bindMount(s, dst, true);
          paths.push(dst);
        } else {
          if (!item.src || !fs.existsSync(item.src)) {
            res.warnings.push(`${item.name}: nothing to back up yet`);
            continue;
          }
          bindMount(item.src, dst, true);
          if (Array.isArray(item.only) && item.only.length && isDir(dst)) {
            const sub = entriesOf(dst, item.only);
            if (!sub.length) {
              res.warnings.push(`${item.name}: nothing to back up yet`);
              continue;
            }
            paths.push(...sub.map(e => path.join(dst, e)));
          } else paths.push(dst);
        }
        res.items.push(item.name);
      }
      let summary = null;
      const r = await restic(
        [
          "backup",
          "--json",
          "--host",
          job.repo,
          "--tag",
          "avado",
          "--tag",
          `run-${job.run.id}`,
          "--tag",
          `pkg-${pkg.name}`,
          "--exclude",
          ASIDE,
          ...paths
        ],
        {
          allow: [0, 3],
          onJson: j => {
            if (j.message_type === "status")
              out({ ev: "progress", name: pkg.name, n, total, percent: j.percent_done, bytes: j.bytes_done, totalBytes: j.total_bytes });
            if (j.message_type === "summary") summary = j;
          }
        }
      );
      if (r.code === 3) res.warnings.push("some files could not be read");
      res.ok = true;
      if (summary) {
        res.bytes = summary.total_bytes_processed;
        res.added = summary.data_added_packed;
        res.snapshot = summary.snapshot_id;
      }
      runMeta[job.run.id][pkg.name] = { title: pkg.title, items: ["settings", ...res.items] };
    } catch (e) {
      res.error = e.message;
      res.code = e.code;
      if (["full", "io", "readOnly", "wrongPassphrase", "locked"].includes(e.code)) {
        unmountAll(AVADO);
        fs.rmSync(stageRoot, { recursive: true, force: true });
        throw Object.assign(e, { partial: results });
      }
    } finally {
      unmountAll(AVADO);
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
  // Per app: keep the last 4 backups and one per month for 12 months
  const keep = job.keep || { last: 4, monthly: 12 };
  out({ ev: "step", step: "tidy" });
  let forgot = false;
  for (const pkg of job.packages) {
    try {
      await restic([
        "forget",
        "--json",
        "--host",
        job.repo,
        "--tag",
        `avado,pkg-${pkg.name}`,
        "--group-by",
        "host",
        "--keep-last",
        String(keep.last),
        "--keep-monthly",
        String(keep.monthly)
      ]);
      forgot = true;
    } catch (e) {
      log(`forget ${pkg.name} failed: ${e.message}`);
    }
  }
  if (forgot && job.prune !== false) {
    try {
      await restic(["prune"]);
    } catch (e) {
      log(`prune failed: ${e.message}`);
    }
  }
  const snaps = await snapshots();
  const index = writeIndex(boxDir, job.box || {}, snaps, runMeta);
  return { packages: results, runId: job.run.id, runs: index.runs.length, ...space(base) };
}

async function opRestore(job) {
  const base = mountTarget(job.target);
  await openRepo(base, job.repo, { create: false });
  const snaps = await snapshots();
  const results = [];
  const total = job.packages.length;
  let n = 0;
  for (const pkg of job.packages) {
    n++;
    out({ ev: "package", name: pkg.name, n, total });
    const res = { name: pkg.name, ok: false, items: [], warnings: [] };
    results.push(res);
    const snap = snaps.find(s => s.id === pkg.snapshot || (s.run === job.run && s.pkg === pkg.name));
    if (!snap) {
      res.error = "This backup has no copy of this app.";
      continue;
    }
    try {
      // Validator keys: never onto an app that already has keys, never keys
      // that another app on this AVADO runs.
      for (const item of pkg.items.filter(i => i.validator)) {
        const itemRoot = path.join(AVADO, pkg.name, item.name);
        if (item.dst && pubkeysInDir(item.dst, item.keys).size)
          throw new JobError(
            "hasKeys",
            `${pkg.title || pkg.name} on this AVADO already has validator keys. Remove them in the app first, then restore.`
          );
        const backupKeys = await pubkeysInSnapshot(snap.id, itemRoot, item.keys);
        for (const other of job.otherValidators || []) {
          const theirs = pubkeysInDir(other.src, other.keys);
          const same = [...backupKeys].filter(k => theirs.has(k));
          if (same.length)
            throw new JobError(
              "keysElsewhere",
              `${same.length} of these validator keys ${same.length === 1 ? "is" : "are"} also in ${other.title ||
                other.name} on this AVADO. Remove ${same.length === 1 ? "it" : "them"} there first: the same key must never run twice.`
            );
        }
        res.validatorKeys = backupKeys.size;
      }
      for (const item of pkg.items) {
        if (item.name === "settings") continue;
        if (!item.dst) {
          res.warnings.push(`${item.name}: no place to restore to`);
          continue;
        }
        const itemRoot = path.join(AVADO, pkg.name, item.name);
        if (!snap.paths.some(p => p === itemRoot || p.startsWith(itemRoot + "/") || p === path.join(AVADO, pkg.name))) {
          res.warnings.push(`${item.name}: not in this backup`);
          continue;
        }
        fs.mkdirSync(item.dst, { recursive: true });
        // What is there now is moved aside (same disk, nothing is copied),
        // so a restore never deletes anything. Only the last copy is kept.
        if (item.aside) {
          fs.rmSync(item.aside, { recursive: true, force: true });
          for (const rel of entriesOf(item.dst, item.only)) {
            const from = path.join(item.dst, rel);
            const to = path.join(item.aside, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.renameSync(from, to);
          }
        }
        await restic(["restore", `${snap.id}:${itemRoot}`, "--target", item.dst, "--json"], {
          onJson: j => {
            if (j.message_type === "status")
              out({ ev: "progress", name: pkg.name, n, total, percent: j.percent_done, bytes: j.bytes_restored, totalBytes: j.total_bytes });
          }
        });
        res.items.push(item.name);
      }
      if (pkg.items.some(i => i.name === "settings")) {
        try {
          const r = await restic(["dump", snap.id, path.join(AVADO, pkg.name, "settings", "env.json")]);
          out({ ev: "settings", name: pkg.name, env: JSON.parse(r.stdout || "{}") });
          res.items.push("settings");
        } catch (e) {
          res.warnings.push("settings: not in this backup");
        }
      }
      res.ok = true;
    } catch (e) {
      res.error = e.message;
      res.code = e.code;
      if (["io", "wrongPassphrase"].includes(e.code)) throw Object.assign(e, { partial: results });
    }
  }
  return { packages: results };
}

const OPS = { probe: opProbe, init: opInit, list: opList, backup: opBackup, restore: opRestore };

async function main() {
  openStdin();
  const first = await nextLine();
  let job;
  try {
    job = JSON.parse(first);
  } catch (e) {
    out({ ev: "error", code: "badJob", message: "bad job" });
    return 2;
  }
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  if (job.passphrase) fs.writeFileSync(PW_FILE, String(job.passphrase), { mode: 0o600 });
  job.passphrase = undefined;
  if (job.target && job.target.type === "smb") process.env.GODEBUG = "asyncpreemptoff=1";
  const op = OPS[job.op];
  if (!op) {
    out({ ev: "error", code: "badJob", message: `unknown op ${job.op}` });
    return 2;
  }
  try {
    const result = await op(job);
    out({ ev: "result", ...result });
    return 0;
  } catch (e) {
    out({ ev: "error", code: e.code || "failed", message: e.message, partial: e.partial });
    return 1;
  } finally {
    try {
      unmountAll(AVADO);
    } catch (e) {
      // best effort
    }
    unmountTarget();
    fs.rmSync(SECRETS, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then(code => {
    if (rl) rl.close();
    process.exit(code);
  });
}

module.exports = { expand, entriesOf, pubkeysInText, globRe, safeRel, writeIndex, readIndex, README };
