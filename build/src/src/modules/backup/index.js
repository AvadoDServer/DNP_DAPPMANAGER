const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const params = require("params");
const db = require("db.js");
const logs = require("logs.js")(module);
const dockerList = require("modules/dockerList");
const docker = require("modules/docker");
const shell = require("utils/shell");
const getPath = require("utils/getPath");
const envsHelper = require("utils/envsHelper");
const { readInstalledManifest } = require("utils/secretEnvs");
const { eventBus, eventBusTag } = require("eventBus");
const { backupItemsOf } = require("./items");
const disks = require("./disks");
const runner = require("./runner");

/**
 * Encrypted backups of the apps' data to the owner's own USB disk or NAS.
 * Nothing leaves the owner's home: no AVADO server, no cloud.
 *
 * - What: each app's backup items (modules/backup/items) and its settings.
 * - How: restic (https://restic.net, AES-256 + Poly1305, key from the
 *   passphrase with scrypt), run by modules/backup/helper.js in a short
 *   container. The passphrase is the only key: without it nobody can open
 *   the backups, AVADO included.
 * - Consistency: small items are copied while the app is paused for a
 *   moment (docker pause, usually well under a second), so a database and
 *   its journal are copied at one instant. Large items (photo libraries) are
 *   read while the app keeps running.
 * - Weekly: watchers/backup runs one when "every week" is on and the disk
 *   is plugged in.
 *
 * Files in DNCORE/backup (root only):
 *   settings.json  where to, every week, choices per app (no secrets)
 *   secret.json    the passphrase and the NAS password (0600), needed for the
 *                  weekly backup. The box already holds the data itself, so
 *                  this protects the backup disk, not the box.
 *   state.json     the last backup and restore
 */

const DIR = () => params.BACKUP_DIR || path.join(params.DNCORE_DIR, "backup");
const SETTINGS = () => path.join(DIR(), "settings.json");
const SECRET = () => path.join(DIR(), "secret.json");
const STATE = () => path.join(DIR(), "state.json");

const MIN_PASSPHRASE = 10;
const MAX_PASSPHRASE = 256;
const PAUSE_CAP_MS = 2 * 60 * 1000;

const MESSAGES = {
  noPassphrase: "Type a passphrase.",
  shortPassphrase: `The passphrase must have at least ${MIN_PASSPHRASE} characters.`,
  longPassphrase: `The passphrase can have at most ${MAX_PASSPHRASE} characters.`,
  badPassphrase: "The passphrase cannot contain line breaks or other control characters.",
  otherPassphrase:
    "This disk already has backups of this AVADO made with another passphrase. Type that passphrase, or use another disk.",
  noTarget: "Choose where to save the backups first.",
  notSetUp: "Set up backups first.",
  noDisk: "The backup disk is not plugged in. Plug it in and try again.",
  unusableDisk: "This disk can't be used for backups.",
  busy: "A backup or restore is running. Wait for it to end.",
  nothing: "There is nothing to back up: no app with data is installed.",
  confirmValidators:
    "Confirm that the old AVADO is switched off, or that these validator keys are removed from it, before you restore them.",
  notInstalled: name => `Install ${name} first, then restore its backup.`
};

/* ------------------------------ files ------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.renameSync(tmp, file);
}

const getSettings = () => readJson(SETTINGS(), {}) || {};
const getSecret = () => readJson(SECRET(), {}) || {};
const getState = () => readJson(STATE(), {}) || {};
const setState = patch => writeJson(STATE(), { ...getState(), ...patch });

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS(), next);
  return next;
}

/* ------------------------------ checks ------------------------------ */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function passphraseProblem(p) {
  if (typeof p !== "string" || !p) return MESSAGES.noPassphrase;
  if (CONTROL.test(p)) return MESSAGES.badPassphrase;
  if ([...p].length < MIN_PASSPHRASE) return MESSAGES.shortPassphrase;
  if ([...p].length > MAX_PASSPHRASE) return MESSAGES.longPassphrase;
  return null;
}

function plain(code, message) {
  const e = Error(message);
  e.code = code;
  return e;
}

/** A NAS target from the Admin's fields, checked; the password is separate */
function nasTarget(t) {
  const host = String(t.host || "")
    .trim()
    .replace(/^(smb:)?\/\//i, "")
    .replace(/\/.*$/, "");
  const share = String(t.share || "")
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, "");
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(host))
    throw plain("badNas", "Type the NAS address, for example 192.168.1.20.");
  if (!/^[^/\\\0\n]{1,80}$/.test(share)) throw plain("badNas", "Type the name of the shared folder on the NAS.");
  const folder = String(t.folder || "")
    .split(/[\\/]+/)
    .filter(x => x && x !== "." && x !== "..")
    .join("/");
  const username = String(t.username || "").trim();
  if (username.length > 128 || CONTROL.test(username) || /[,=]/.test(username))
    throw plain("badNas", "The user name is not valid.");
  const domain = String(t.domain || "").trim();
  if (domain && !/^[A-Za-z0-9._-]{1,64}$/.test(domain)) throw plain("badNas", "The workgroup is not valid.");
  return { type: "smb", host, share, folder: folder || undefined, username: username || undefined, domain: domain || undefined };
}

/**
 * The target as the helper needs it: a USB disk resolved to its current
 * /dev path, or the NAS with its password.
 */
async function resolveTarget(t, secret = {}) {
  if (!t || !t.type) throw plain("noTarget", MESSAGES.noTarget);
  if (t.type === "usb") {
    const list = await disks.listDisks();
    const d = list.find(x => x.id && x.id === t.id);
    if (!d) throw plain("noDisk", MESSAGES.noDisk);
    if (!d.usable) throw plain("unusableDisk", d.reason || MESSAGES.unusableDisk);
    return { helper: { type: "usb", device: d.path, fstype: d.fstype }, disk: d };
  }
  if (t.type === "smb") {
    const n = nasTarget(t);
    const password = typeof t.password === "string" ? t.password : secret.smbPassword || "";
    if (CONTROL.test(password)) throw plain("badNas", "The password cannot contain line breaks.");
    return { helper: { ...n, password } };
  }
  throw plain("noTarget", MESSAGES.noTarget);
}

const publicTarget = t =>
  !t || !t.type
    ? null
    : t.type === "usb"
    ? { type: "usb", id: t.id, name: t.name, fsName: t.fsName, size: t.size }
    : { type: "smb", host: t.host, share: t.share, folder: t.folder, username: t.username, domain: t.domain };

/* ------------------------------ apps ------------------------------ */

const title = name => {
  const short = String(name).split(".")[0];
  const known = {
    teku: "Teku",
    nimbus: "Nimbus",
    lighthouse: "Lighthouse",
    eth2validator: "Prysm validator",
    vaultwarden: "Vaultwarden",
    paperless: "Paperless-ngx",
    immich: "Immich",
    homeassistant: "Home Assistant"
  };
  const [base, net] = short.split("-");
  return (known[base] || base.charAt(0).toUpperCase() + base.slice(1)) + (net ? ` (${net})` : "");
};

/**
 * Where an item lives on the host: the docker volume that holds its path.
 * @returns {{ volumeDir: string, rel: string }|null}
 */
function locate(item, container) {
  let best = null;
  for (const v of container.volumes || []) {
    const mp = String(v.mountPath || "").replace(/\/$/, "");
    if (!mp || !(item.path === mp || item.path.startsWith(mp + "/"))) continue;
    if (!best || mp.length > best.mp.length) best = { v, mp };
  }
  if (!best) return null;
  const src = String(best.v.path || "");
  if (best.v.type !== "volume" || !/\/_data$/.test(src)) return null;
  return { volumeDir: src.replace(/\/_data$/, ""), rel: path.posix.relative(best.mp, item.path) };
}

/** Installed apps that have something to back up, with the owner's choices */
async function listApps(settings = getSettings()) {
  const containers = (await dockerList.listContainers()).filter(c => c.isDnp && !c.isCore);
  const apps = [];
  for (const c of containers) {
    const manifest = readInstalledManifest(c.name, params, false);
    const { items, source, error } = backupItemsOf(c.name, manifest);
    if (!items.length) continue;
    const skip = (settings.skip || {})[c.name] === true;
    const large = (settings.large || {})[c.name] === true;
    apps.push({
      name: c.name,
      title: title(c.name),
      version: c.version,
      origin: c.origin,
      running: c.state === "running",
      state: c.state,
      included: !skip,
      includeLarge: large,
      source,
      error,
      validator: items.some(i => i.validator),
      items: items.map(i => ({
        ...i,
        where: locate(i, c),
        included: !skip && (!i.large || large)
      })),
      container: c
    });
  }
  return apps;
}

const publicApp = a => ({
  name: a.name,
  title: a.title,
  running: a.running,
  included: a.included,
  includeLarge: a.includeLarge,
  validator: a.validator,
  hasLarge: a.items.some(i => i.large),
  items: a.items.map(i => ({
    name: i.name,
    label: i.label,
    large: i.large,
    validator: i.validator,
    included: i.included,
    found: Boolean(i.where)
  }))
});

/* ------------------------------ job state ------------------------------ */

let job = null;
const paused = new Set();

function jobView() {
  if (!job) return null;
  const { kind, startedAt, step, current, n, total, percent, bytes, totalBytes, done, ok, error } = job;
  return { kind, startedAt, step, current, n, total, percent, bytes, totalBytes, done, ok, error };
}

function emit() {
  try {
    eventBus.emit(eventBusTag.emitBackup || "backup", jobView());
  } catch (e) {
    // no listener
  }
}

async function pause(name) {
  const c = `${params.CONTAINER_NAME_PREFIX}${name}`;
  const state = await shell(`docker inspect -f '{{.State.Status}}' ${c}`, { trim: true }).catch(() => "");
  if (state !== "running") return;
  await shell(`docker pause ${c}`);
  paused.add(c);
  setState({ paused: [...paused] });
  // Never leave an app paused
  setTimeout(() => resume(name).catch(() => {}), PAUSE_CAP_MS).unref();
}

async function resume(name) {
  const c = `${params.CONTAINER_NAME_PREFIX}${name}`;
  if (!paused.has(c)) return;
  await shell(`docker unpause ${c}`).catch(e => {
    if (!/is not paused/i.test(e.message)) throw e;
  });
  paused.delete(c);
  setState({ paused: [...paused] });
}

/** After a restart of the DAPPMANAGER: unpause what a backup paused */
async function cleanupAfterRestart() {
  const st = getState();
  for (const c of st.paused || []) {
    if (!/^DAppNodePackage-[a-z0-9.-]+$/.test(c)) continue;
    await shell(`docker unpause ${c}`).catch(() => {});
  }
  if ((st.paused || []).length) setState({ paused: [] });
  // A helper left from before (the DAPPMANAGER was recreated mid-job)
  const names = await shell(`docker ps -a --filter name=${runner.CONTAINER_PREFIX} --format '{{.Names}}'`).catch(() => "");
  for (const n of String(names || "")
    .split("\n")
    .map(s => s.trim())
    .filter(s => /^avado-backup-[a-z0-9-]+$/.test(s)))
    await shell(`docker rm -f ${n}`).catch(() => {});
  await shell(`docker volume rm ${runner.STAGE_VOLUME}`).catch(() => {});
  if (st.running) setState({ running: null });
}

/* ------------------------------ mounts ------------------------------ */

function mountPlan(apps, { ro }) {
  const dirs = new Map();
  const mounts = [];
  const dirOf = volumeDir => {
    if (!dirs.has(volumeDir)) {
      const dir = `/vol/${dirs.size}`;
      dirs.set(volumeDir, dir);
      mounts.push({ host: volumeDir, dir, ro });
    }
    return dirs.get(volumeDir);
  };
  return { dirOf, mounts };
}

/* ------------------------------ calls ------------------------------ */

async function status() {
  const settings = getSettings();
  const secret = getSecret();
  const state = getState();
  let apps = [];
  try {
    apps = (await listApps(settings)).map(publicApp);
  } catch (e) {
    logs.warn(`backup: could not list apps: ${e.message}`);
  }
  return {
    setUp: Boolean(settings.target && secret.passphrase),
    target: publicTarget(settings.target),
    weekly: settings.weekly === true,
    apps,
    last: state.last || null,
    lastSuccessAt: state.lastSuccessAt || null,
    lastRestore: state.lastRestore || null,
    weeklyNote: state.weeklyNote || null,
    job: jobView()
  };
}

async function listTargets() {
  const list = await disks.listDisks();
  return { disks: list.map(d => ({ id: d.id, name: d.name, model: d.model, size: d.size, fsName: d.fsName, usable: d.usable, reason: d.reason })) };
}

/**
 * Sets up (or changes) where the backups go and the passphrase. Opens the
 * repository there (makes it the first time) so a wrong passphrase for an
 * existing one is found now, not at the first weekly run.
 */
async function setup({ target, passphrase, weekly }) {
  if (job && !job.done) throw plain("busy", MESSAGES.busy);
  const problem = passphraseProblem(passphrase);
  if (problem) throw plain("badPassphrase", problem);
  if (!target || !target.type) throw plain("noTarget", MESSAGES.noTarget);
  const settings = getSettings();
  const boxId = settings.boxId || `avado-${crypto.randomBytes(4).toString("hex")}`;
  let saved;
  let secretPatch = {};
  if (target.type === "usb") {
    const { disk } = await resolveTarget({ type: "usb", id: target.id });
    saved = { type: "usb", id: disk.id, name: disk.name, fsName: disk.fsName, size: disk.size };
  } else {
    saved = nasTarget(target);
    secretPatch = { smbPassword: typeof target.password === "string" ? target.password : getSecret().smbPassword || "" };
  }
  const { helper } = await resolveTarget(saved, { ...getSecret(), ...secretPatch });
  job = { kind: "setup", startedAt: Date.now(), done: false };
  try {
    await runner.runHelper(
      { op: "init", target: helper, passphrase, repo: boxId, box: { id: boxId, name: (await db.get("name")) || "AVADO" } },
      { name: "setup", targetType: helper.type },
      { timeoutMs: 5 * 60 * 1000 }
    );
  } catch (e) {
    if (e.code === "wrongPassphrase") throw plain("otherPassphrase", MESSAGES.otherPassphrase);
    throw e;
  } finally {
    job = null;
  }
  writeJson(SECRET(), { ...getSecret(), ...secretPatch, passphrase });
  saveSettings({ boxId, target: saved, weekly: weekly === true ? true : weekly === false ? false : settings.weekly === true, setUpAt: new Date().toISOString() });
  return status();
}

/** Every week on/off and what each app includes */
async function setOptions({ weekly, apps }) {
  const s = getSettings();
  const patch = {};
  if (typeof weekly === "boolean") patch.weekly = weekly;
  if (apps && typeof apps === "object") {
    const skip = { ...(s.skip || {}) };
    const large = { ...(s.large || {}) };
    for (const [name, o] of Object.entries(apps)) {
      if (!/^[a-z0-9.-]{3,120}$/.test(name) || !o || typeof o !== "object") continue;
      if (typeof o.included === "boolean") skip[name] = !o.included;
      if (typeof o.includeLarge === "boolean") large[name] = o.includeLarge;
    }
    patch.skip = skip;
    patch.large = large;
  }
  saveSettings(patch);
  return status();
}

/**
 * Starts a backup of every included app. Resolves once it has started; the
 * progress is in status().job.
 * @param {object} [o]
 * @param {string} [o.reason] "now" | "weekly"
 */
async function startBackup({ reason = "now" } = {}) {
  if (job && !job.done) throw plain("busy", MESSAGES.busy);
  const settings = getSettings();
  const secret = getSecret();
  if (!settings.target || !secret.passphrase) throw plain("notSetUp", MESSAGES.notSetUp);
  const { helper } = await resolveTarget(settings.target, secret);
  const apps = (await listApps(settings)).filter(a => a.included);
  if (!apps.length) throw plain("nothing", MESSAGES.nothing);

  const plan = mountPlan(apps, { ro: true });
  const packages = apps.map(a => ({
    name: a.name,
    title: a.title,
    version: a.version,
    origin: a.origin,
    env: envsHelper.load(a.name, false),
    items: a.items
      .filter(i => i.included && i.where)
      .map(i => ({
        name: i.name,
        label: i.label,
        path: i.path,
        only: i.only,
        keys: i.keys,
        large: i.large,
        validator: i.validator,
        staged: !i.large,
        src: path.posix.join(plan.dirOf(i.where.volumeDir), "_data", i.where.rel)
      }))
  }));

  const run = { id: new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").toLowerCase(), at: new Date().toISOString() };
  job = { kind: "backup", reason, startedAt: Date.now(), step: "start", n: 0, total: packages.length, done: false };
  setState({ running: { kind: "backup", at: run.at } });
  emit();

  const work = runner
    .runHelper(
      {
        op: "backup",
        target: helper,
        passphrase: secret.passphrase,
        repo: settings.boxId,
        box: { id: settings.boxId, name: (await db.get("name")) || "AVADO" },
        run,
        packages
      },
      { name: "run", targetType: helper.type, mounts: plan.mounts, stage: true },
      {
        onPause: pause,
        onResume: resume,
        onEvent: ev => {
          if (ev.ev === "package") Object.assign(job, { step: "app", current: ev.name, n: ev.n, total: ev.total, percent: 0 });
          if (ev.ev === "progress")
            Object.assign(job, { current: ev.name, percent: ev.percent, bytes: ev.bytes, totalBytes: ev.totalBytes });
          if (ev.ev === "step") job.step = ev.step;
          emit();
        }
      }
    )
    .then(result => {
      const failed = result.packages.filter(p => !p.ok);
      const last = {
        kind: "backup",
        reason,
        at: run.at,
        endedAt: new Date().toISOString(),
        ok: failed.length === 0,
        target: publicTarget(settings.target),
        apps: result.packages.map(p => ({
          name: p.name,
          title: title(p.name),
          ok: p.ok,
          bytes: p.bytes,
          added: p.added,
          error: p.error,
          warnings: p.warnings
        })),
        free: result.free,
        total: result.total
      };
      setState({ last, running: null, weeklyNote: null, ...(last.ok ? { lastSuccessAt: last.endedAt } : {}) });
      Object.assign(job, { done: true, ok: last.ok, step: "done", error: last.ok ? null : `${failed.map(p => title(p.name)).join(", ")}: ${failed[0].error}` });
      logs.info(`backup ${run.id}: ${result.packages.filter(p => p.ok).length} of ${result.packages.length} apps backed up`);
    })
    .catch(e => {
      const last = { kind: "backup", reason, at: run.at, endedAt: new Date().toISOString(), ok: false, error: e.message, target: publicTarget(settings.target) };
      setState({ last, running: null });
      Object.assign(job, { done: true, ok: false, step: "done", error: e.message });
      logs.error(`backup ${run.id} failed: ${e.message}`);
    })
    .finally(async () => {
      for (const c of [...paused]) await resume(c.replace(params.CONTAINER_NAME_PREFIX, "")).catch(() => {});
      await shell(`docker volume rm ${runner.STAGE_VOLUME}`).catch(() => {});
      emit();
    });
  job.promise = work;
  return { started: true, run: run.id };
}

/**
 * Backups found on a USB disk or NAS (any AVADO's), from their plain lists.
 * No passphrase needed; nothing is opened.
 */
async function find({ target }) {
  if (job && !job.done) throw plain("busy", MESSAGES.busy);
  const settings = getSettings();
  const t = target && target.type ? target : settings.target;
  const { helper } = await resolveTarget(t, getSecret());
  const r = await runner.runHelper({ op: "probe", target: helper }, { name: "find", targetType: helper.type }, { timeoutMs: 2 * 60 * 1000 });
  return {
    writable: r.writable,
    free: r.free,
    total: r.total,
    thisBox: settings.boxId || null,
    backups: (r.repos || []).map(repo => ({
      repo: repo.id,
      boxName: repo.boxName,
      thisBox: repo.id === settings.boxId,
      runs: (repo.runs || []).slice(0, 40).map(run => ({
        id: run.id,
        at: run.at,
        apps: (run.packages || []).map(p => ({ name: p.name, title: p.title || title(p.name), items: p.items || [], bytes: p.bytes }))
      }))
    }))
  };
}

/**
 * Restores apps from one backup. Checks the passphrase first (and answers at
 * once when it is wrong), then runs in the background like a backup.
 *
 * @param {object} kwargs
 * @param {object} kwargs.target where the backup is ({ type: "usb", id } or NAS fields)
 * @param {string} kwargs.repo backup id of the AVADO that made it
 * @param {string} kwargs.run which backup
 * @param {string} kwargs.passphrase
 * @param {Array<{ name: string, items: string[] }>} kwargs.apps what to restore
 * @param {boolean} kwargs.confirmValidators the owner confirmed the old box
 *   is off or its keys are removed (needed when validator keys are restored)
 */
async function startRestore({ target, repo, run, passphrase, apps: wanted, confirmValidators }) {
  if (job && !job.done) throw plain("busy", MESSAGES.busy);
  if (typeof passphrase !== "string" || !passphrase) throw plain("badPassphrase", MESSAGES.noPassphrase);
  if (!/^[a-z0-9-]{4,64}$/.test(repo || "") || !/^[0-9t]{8,20}$/.test(run || "")) throw plain("badRequest", "Choose a backup.");
  if (!Array.isArray(wanted) || !wanted.length) throw plain("badRequest", "Choose what to restore.");
  const settings = getSettings();
  const { helper } = await resolveTarget(target && target.type ? target : settings.target, getSecret());

  // The passphrase and the backup's contents, before anything is stopped
  const listed = await runner
    .runHelper({ op: "list", target: helper, passphrase, repo }, { name: "list", targetType: helper.type }, { timeoutMs: 3 * 60 * 1000 })
    .catch(e => {
      if (e.code === "wrongPassphrase") throw plain("wrongPassphrase", "The passphrase is wrong.");
      throw e;
    });
  const snaps = (listed.snapshots || []).filter(s => s.run === run);
  if (!snaps.length) throw plain("badRequest", "This backup is no longer on the disk.");

  const installed = await listApps({});
  const allContainers = installed;
  const plan = mountPlan(installed, { ro: false });
  const packages = [];
  const validatorApps = [];
  for (const w of wanted) {
    const name = String((w && w.name) || "");
    const snap = snaps.find(s => s.pkg === name);
    if (!snap) throw plain("badRequest", `This backup has no copy of ${title(name)}.`);
    const app = installed.find(a => a.name === name);
    if (!app) throw plain("notInstalled", MESSAGES.notInstalled(title(name)));
    const names = new Set(Array.isArray(w.items) ? w.items.map(String) : []);
    const items = app.items
      .filter(i => names.has(i.name))
      .map(i => ({
        name: i.name,
        path: i.path,
        only: i.only,
        keys: i.keys,
        validator: i.validator,
        dst: i.where ? path.posix.join(plan.dirOf(i.where.volumeDir), "_data", i.where.rel) : null,
        aside: i.where ? path.posix.join(plan.dirOf(i.where.volumeDir), "avado-before-restore", i.name) : null
      }));
    if (names.has("settings")) items.push({ name: "settings" });
    if (!items.length) continue;
    if (items.some(i => i.validator)) validatorApps.push(app);
    packages.push({ name, title: app.title, snapshot: snap.id, items, app, wasRunning: app.running });
  }
  if (!packages.length) throw plain("badRequest", "Choose what to restore.");
  if (validatorApps.length && confirmValidators !== true) throw plain("confirmValidators", MESSAGES.confirmValidators);

  // Other validator apps on this box: their keys must not be restored here
  const otherValidators = [];
  for (const a of allContainers) {
    if (packages.some(p => p.name === a.name)) continue;
    for (const i of a.items.filter(x => x.validator && x.where)) {
      otherValidators.push({
        name: a.name,
        title: a.title,
        keys: i.keys,
        src: path.posix.join(plan.dirOf(i.where.volumeDir), "_data", i.where.rel)
      });
    }
  }

  job = { kind: "restore", startedAt: Date.now(), step: "stopping", n: 0, total: packages.length, done: false };
  setState({ running: { kind: "restore", at: new Date().toISOString() } });
  emit();

  const stopped = [];
  const work = (async () => {
    // Stop every running app first (validators before anything is copied).
    // An app the owner had stopped is left stopped, now and afterwards.
    for (const p of packages) {
      if (!p.wasRunning) continue;
      const dcPath = getPath.dockerComposeSmart(p.name, params);
      job.current = p.name;
      emit();
      await docker.compose.stop(dcPath, { timeout: 180 });
      stopped.push(p);
    }
    const envs = {};
    const result = await runner.runHelper(
      {
        op: "restore",
        target: helper,
        passphrase,
        repo,
        run,
        packages: packages.map(p => ({ name: p.name, title: p.title, snapshot: p.snapshot, items: p.items })),
        otherValidators
      },
      { name: "restore", targetType: helper.type, mounts: plan.mounts },
      {
        onEvent: ev => {
          if (ev.ev === "package") Object.assign(job, { step: "app", current: ev.name, n: ev.n, total: ev.total, percent: 0 });
          if (ev.ev === "progress") Object.assign(job, { percent: ev.percent, bytes: ev.bytes, totalBytes: ev.totalBytes });
          if (ev.ev === "settings" && ev.env && typeof ev.env === "object") envs[ev.name] = ev.env;
          emit();
        }
      }
    );
    // Settings: the backed-up values of the envs this version still has
    for (const [name, env] of Object.entries(envs)) {
      const current = envsHelper.load(name, false);
      const known = new Set([...Object.keys(current), ...Object.keys(envsHelper.getManifestEnvs(readInstalledManifest(name, params, false)))]);
      const restored = {};
      for (const [k, v] of Object.entries(env)) if (known.has(k) && typeof v === "string") restored[k] = v;
      envsHelper.write(name, false, { ...current, ...restored });
    }
    return result;
  })();

  job.promise = work
    .then(result => restartAfterRestore(packages, result))
    .then(({ result, keptStopped }) => {
      const failed = result.packages.filter(p => !p.ok);
      const lastRestore = {
        at: new Date().toISOString(),
        run,
        repo,
        ok: failed.length === 0,
        keptStopped: keptStopped.map(p => ({ name: p.name, title: p.title })),
        apps: result.packages.map(p => ({ name: p.name, title: title(p.name), ok: p.ok, items: p.items, error: p.error, warnings: p.warnings, validatorKeys: p.validatorKeys }))
      };
      setState({ lastRestore, running: null });
      Object.assign(job, { done: true, ok: lastRestore.ok, step: "done", error: lastRestore.ok ? null : failed[0].error });
      logs.info(`restore of ${run}: ${result.packages.filter(p => p.ok).length} of ${result.packages.length} apps restored`);
    })
    .catch(async e => {
      // Nothing was restored: start what this restore stopped (not
      // validators, so a half-restored one never signs)
      for (const p of stopped) {
        if (p.items.some(i => i.validator)) continue;
        await docker.compose.start(getPath.dockerComposeSmart(p.name, params)).catch(() => {});
      }
      setState({ lastRestore: { at: new Date().toISOString(), run, repo, ok: false, error: e.message }, running: null });
      Object.assign(job, { done: true, ok: false, step: "done", error: e.message });
      logs.error(`restore of ${run} failed: ${e.message}`);
    })
    .finally(() => {
      eventBus.emit(eventBusTag.emitPackages);
      emit();
    });
  return { started: true, validators: validatorApps.map(a => a.name) };
}

/**
 * Apps that were running start again with their restored data and
 * settings. Apps the owner had stopped stay stopped, and so do apps with
 * validator keys: the owner starts them once the old box is off for good.
 */
async function restartAfterRestore(packages, result) {
  const keptStopped = [];
  for (const p of packages) {
    const dcPath = getPath.dockerComposeSmart(p.name, params);
    const r = result.packages.find(x => x.name === p.name) || {};
    const validator = p.items.some(i => i.validator);
    try {
      // Validator keys that were put back stay stopped. When nothing of the
      // app was restored (it was refused), it goes back to how it was.
      const restored = r.ok || (r.items || []).length > 0;
      if ((validator && restored) || !p.wasRunning) {
        // Recreated with the restored settings, but not started
        await docker.compose.create(dcPath);
        if (validator && restored) keptStopped.push(p);
      } else {
        await docker.safe.compose.up(dcPath);
      }
    } catch (e) {
      r.warnings = [...(r.warnings || []), `could not start: ${e.message}`];
    }
  }
  return { result, keptStopped };
}

function setWeeklyNote(message) {
  setState({ weeklyNote: { at: new Date().toISOString(), message } });
}

module.exports = {
  setWeeklyNote,
  status,
  listTargets,
  setup,
  setOptions,
  startBackup,
  find,
  startRestore,
  cleanupAfterRestart,
  passphraseProblem,
  locate,
  listApps,
  MESSAGES,
  // tests
  _job: () => job,
  _reset: () => {
    job = null;
    paused.clear();
  }
};
