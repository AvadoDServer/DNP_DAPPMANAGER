const params = require("params");
const { run, runOk } = require("./exec");
const { scrub, scrubSettings } = require("./scrub");

/**
 * Every DAppNode container (core and packages) as docker sees it, the
 * supervisord processes inside it, its recent log errors and its settings.
 * Read-only: docker ps / inspect / logs, and `docker exec` of
 * `supervisorctl status` and `cat` into running containers.
 */

const CORE = params.CONTAINER_CORE_NAME_PREFIX; // DAppNodeCore-
const PKG = params.CONTAINER_NAME_PREFIX; // DAppNodePackage-
const NO_DATE = /^0001-01-01/;

const LOG_TAIL = 500;
const LOG_LINES = 40;
const LOG_ERRORS = 5;
const LOG_LINE_MAX = 500;
const LOG_ERROR = /error|fatal|panic|exception|failed|refused|timeout|out of memory/i;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

// Looked for in this order (Qtum keeps its config in /etc/supervisord/)
const SUPERVISOR_CONFS = ["/etc/supervisord.conf", "/etc/supervisord/supervisord.conf"];
const SUPERVISOR_STATES = ["RUNNING", "STARTING", "BACKOFF", "STOPPED", "EXITED", "FATAL", "UNKNOWN"];

/**
 * Names and docker's Status text ("Up 3 hours", "Exited (2) 5 minutes ago")
 * of all DAppNode containers, then ONE docker inspect of all of them.
 * @returns {Promise<object[]>} formatted containers, each with a
 *   non-enumerable `ip` (its address on the dncore network)
 */
async function readContainers({ now = Date.now(), timeout = 10 * 1000 } = {}) {
  const ps = await runOk("docker", ["ps", "-a", "--no-trunc", "--format", "{{.Names}}\t{{.Status}}"], { timeout });
  const statusByName = {};
  for (const line of ps.split("\n")) {
    const [name, status] = line.split("\t");
    if (name && (name.startsWith(CORE) || name.startsWith(PKG))) statusByName[name.trim()] = (status || "").trim();
  }
  const names = Object.keys(statusByName).sort();
  if (!names.length) return [];
  // A container removed between ps and inspect makes inspect exit 1 but it
  // still prints the others
  const res = await run("docker", ["inspect", ...names], { timeout });
  let inspected;
  try {
    inspected = JSON.parse(res.stdout);
  } catch (e) {
    throw Error((res.stderr || "").trim().split("\n")[0] || "cannot parse docker inspect");
  }
  return (inspected || []).map(info => formatContainer(info, statusByName[(info.Name || "").replace(/^\//, "")], now));
}

/**
 * One `docker inspect` entry in the shape getDiagnostics returns
 */
function formatContainer(info, status, now = Date.now()) {
  const name = (info.Name || "").replace(/^\//, "");
  const isCore = name.startsWith(CORE);
  const id = isCore ? name.slice(CORE.length) : name.startsWith(PKG) ? name.slice(PKG.length) : name;
  const state = info.State || {};
  const image = (info.Config && info.Config.Image) || info.Image || null;
  let version = image && image.includes(":") ? image.split(":").pop() : null;
  if (version && version.startsWith("ipfs-")) version = version.replace("ipfs-", "/ipfs/");
  const startedAt = state.StartedAt && !NO_DATE.test(state.StartedAt) ? state.StartedAt : null;
  const finishedAt = state.FinishedAt && !NO_DATE.test(state.FinishedAt) ? state.FinishedAt : null;
  const running = state.Running === true && state.Restarting !== true;
  const networks = (info.NetworkSettings && info.NetworkSettings.Networks) || {};
  const dncore = networks[params.DNP_NETWORK] || {};
  const c = {
    name,
    id,
    isCore,
    image,
    version,
    state: state.Status || null,
    status: status || null,
    exitCode: Number.isFinite(state.ExitCode) ? state.ExitCode : null,
    oomKilled: state.OOMKilled === true,
    restartCount: Number(info.RestartCount) || 0,
    startedAt,
    finishedAt,
    uptimeSeconds: running && startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : null,
    health: state.Health && state.Health.Status ? state.Health.Status : null,
    processes: [],
    log: null,
    settings: null
  };
  // Used for the client probes, not returned
  Object.defineProperty(c, "ip", { value: dncore.IPAddress || null, enumerable: false });
  Object.defineProperty(c, "running", { value: running, enumerable: false });
  // Key of the "has supervisord" cache: a recreated container or a new image
  // is looked at again
  Object.defineProperty(c, "cacheKey", { value: info.Id ? `${info.Id}|${info.Image || image}` : null, enumerable: false });
  return c;
}

/**
 * `supervisorctl status` output -> [{ name, state, description }]
 * "teku                             FATAL     Exited too quickly (process log may have details)"
 */
function parseSupervisorStatus(out) {
  const processes = [];
  for (const line of String(out || "").split("\n")) {
    const m = line.trim().match(/^(\S+)\s+([A-Z]+)\b\s*(.*)$/);
    if (!m) continue;
    const known = SUPERVISOR_STATES.includes(m[2]);
    if (!known && m[2] !== "STOPPING") continue;
    processes.push({
      name: m[1],
      state: known ? m[2] : "UNKNOWN",
      description: scrub(known ? m[3].trim() : `${m[2]} ${m[3]}`.trim())
    });
  }
  return processes;
}

const NO_SHELL = /"sh": executable file not found/i;
const NO_SUPERVISORD = "__no_supervisord__";
const CONF_MARK = "__conf__=";
// supervisorctl that finds no supervisord behind its socket: the container
// has the config but does not run supervisord
const NO_SUPERVISORD_RUNNING = /unix:\/\/|no such file|refused|ConnectionRefused|socket/i;

// Where a container's supervisord config is (or false: none), per container
// id + image id, for the life of this process: the Admin polls processes
// every 60 s from every open tab, so after the first look a container costs
// one `docker exec supervisorctl status`, or nothing when it has no
// supervisord. A recreated container or a new image is a new key.
const supervisordConf = new Map();
const CACHE_MAX = 1000;

const remember = (key, value) => {
  if (!key) return;
  if (supervisordConf.size >= CACHE_MAX) supervisordConf.clear();
  supervisordConf.set(key, value);
};

/**
 * The supervisord processes of a running container, [] when it has no
 * supervisord config (/etc/supervisord.conf, or Qtum's
 * /etc/supervisord/supervisord.conf), no shell, or no supervisord running
 * @param {string} name container name
 * @param {object} options { timeout, cacheKey: "<container id>|<image id>" }
 */
async function readProcesses(name, { timeout = 5 * 1000, cacheKey = null } = {}) {
  const known = cacheKey ? supervisordConf.get(cacheKey) : undefined;
  if (known === false) return [];

  // First look: find the config and read in the same exec
  const find = SUPERVISOR_CONFS.map(
    c => `if [ -f ${c} ]; then echo ${CONF_MARK}${c}; supervisorctl -c ${c} status; exit 0; fi`
  ).join("; ");
  const args = known
    ? ["exec", name, "supervisorctl", "-c", known, "status"]
    : ["exec", name, "sh", "-c", `${find}; echo ${NO_SUPERVISORD}; exit 0`];
  const res = await run("docker", args, { timeout });
  let out = res.stdout.trim();
  if (out === NO_SUPERVISORD) {
    remember(cacheKey, false);
    return [];
  }
  let conf = known || null;
  if (out.startsWith(CONF_MARK)) {
    const nl = out.indexOf("\n");
    conf = (nl === -1 ? out : out.slice(0, nl)).slice(CONF_MARK.length).trim();
    out = nl === -1 ? "" : out.slice(nl + 1).trim();
    remember(cacheKey, conf);
  }
  // supervisorctl exits non-zero when a process is not running: the output
  // is what counts
  const processes = parseSupervisorStatus(out);
  if (processes.length) return processes;
  const said = `${out}\n${res.stderr}`;
  if (res.code !== 0 && !conf) {
    // No shell in the image: nothing to read, now or later. Any other exec
    // failure (a container stopping under us) is reported and not remembered.
    if (NO_SHELL.test(said)) {
      remember(cacheKey, false);
      return [];
    }
    throw Error(scrub((res.stderr || res.stdout).trim().split("\n")[0]) || `exit code ${res.code}`);
  }
  // A config but no supervisord behind it ("unix:///run/supervisord.sock no
  // such file"): the container does not use supervisord, nothing to report
  if (!said.trim() || NO_SUPERVISORD_RUNNING.test(said)) return [];
  throw Error(scrub(said.trim().split("\n")[0]));
}

// Tests only
function _resetSupervisordCache() {
  supervisordConf.clear();
}

const tsOf = line => {
  const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/);
  return m ? m[1] : "";
};

/**
 * `docker logs --tail 500 --timestamps` output (stdout and stderr) ->
 * { lines: last 40, errors: last 5 error lines, errorCount }, scrubbed
 */
function summarizeLogs(out) {
  const all = String(out || "")
    .split("\n")
    .map(l => l.replace(ANSI, "").replace(/\r/g, "").trimEnd())
    .filter(l => l.trim() !== "")
    // stdout and stderr arrive on two pipes: put them back in time order
    .map((l, i) => ({ l, i, t: tsOf(l) }))
    .sort((a, b) => (a.t === b.t || !a.t || !b.t ? a.i - b.i : a.t < b.t ? -1 : 1))
    .map(({ l }) => scrub(l))
    .map(l => (l.length > LOG_LINE_MAX ? `${l.slice(0, LOG_LINE_MAX)}…` : l));
  const errors = all.filter(l => LOG_ERROR.test(l));
  return {
    lines: all.slice(-LOG_LINES),
    errors: errors.slice(-LOG_ERRORS),
    errorCount: errors.length
  };
}

async function readLog(name, { timeout = 10 * 1000 } = {}) {
  const res = await run("docker", ["logs", "--tail", String(LOG_TAIL), "--timestamps", name], { timeout });
  if (res.code !== 0) throw Error((res.stderr || "").trim().split("\n")[0] || `exit code ${res.code}`);
  return summarizeLogs(res.combined);
}

/**
 * A package's settings file read inside its running container, without
 * secrets. null when the file does not exist.
 */
async function readSettings(name, path, { timeout = 5 * 1000 } = {}) {
  const res = await run("docker", ["exec", name, "cat", path], { timeout });
  if (res.code !== 0) {
    if (/no such file/i.test(res.stderr)) return null;
    throw Error((res.stderr || "").trim().split("\n")[0] || `exit code ${res.code}`);
  }
  let settings;
  try {
    settings = JSON.parse(res.stdout);
  } catch (e) {
    throw Error(`${path} is not valid JSON`);
  }
  // A double-encoded file parses to a string: not settings
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw Error("not an object");
  return scrubSettings(settings);
}

module.exports = {
  readContainers,
  formatContainer,
  parseSupervisorStatus,
  readProcesses,
  _resetSupervisordCache,
  summarizeLogs,
  readLog,
  readSettings,
  LOG_ERROR
};
