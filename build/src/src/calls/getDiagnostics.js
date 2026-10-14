const host = require("modules/diagnostics/host");
const containers = require("modules/diagnostics/containers");
const network = require("modules/diagnostics/network");
const clients = require("modules/diagnostics/clients");
const { withTimeout, mapLimit, errorMessage } = require("modules/diagnostics/timeout");

/**
 * What a support person needs to find a fault in one read: the box, its
 * network path to the internet and to the AVADO store, every DAppNode
 * container with the processes inside it and its last errors, and the
 * clients' own view (sync, peers, validators).
 *
 * Read-only. Every probe runs in parallel with its own timeout; a probe that
 * fails or runs late leaves its part null/empty and adds "<probe>: <message>"
 * to errors, the call itself never fails because of one. Whatever has not
 * finished after CAP_MS is reported as "<probe>: timed out".
 *
 * The Admin polls { host: false, network: false, logs: false, clients: false }
 * every 60 s (containers and processes only: no host run, no docker logs);
 * the support report asks for everything.
 *
 * @param {object} kwargs { host, network, logs, clients } all default true
 * @returns {object} { message, result } result: see the spec
 *   (collectedAt, durationMs, errors, host, network, containers, clients)
 */

let CAP_MS = 24 * 1000; // the whole call stays under 25 s
const CONTAINERS_TIMEOUT = 10 * 1000;
const PROCESSES_TIMEOUT = 5 * 1000;
const LOGS_TIMEOUT = 10 * 1000;
const SETTINGS_TIMEOUT = 5 * 1000;
const CLIENT_TIMEOUT = 4 * 1000;
const DOCKER_CONCURRENCY = 6;

const TIMED_OUT = Symbol("timed out");

async function getDiagnostics(kwargs) {
  const opts = Object.assign({ host: true, network: true, logs: true, clients: true }, kwargs || {});
  const t0 = Date.now();
  const errors = [];
  const pending = new Set();
  let closed = false;
  const addError = msg => {
    if (!closed) errors.push(msg);
  };

  /**
   * Runs one probe: its value, or null with an error. Tracked so the cap
   * can name what is still running.
   */
  const probe = (name, ms, fn) => {
    pending.add(name);
    return withTimeout(Promise.resolve().then(fn), ms, "timed out").then(
      value => {
        pending.delete(name);
        return value;
      },
      e => {
        pending.delete(name);
        addError(`${name}: ${errorMessage(e)}`);
        return null;
      }
    );
  };

  const result = {
    collectedAt: new Date(t0).toISOString(),
    durationMs: 0,
    errors,
    host: null,
    network: null,
    containers: [],
    clients: opts.clients ? [] : null
  };

  if (opts.network) {
    result.network = {
      interfaces: null,
      defaultRoute: null,
      dns: null,
      internet: null,
      store: { ipfs: null, catalogue: null }
    };
  }

  const tasks = [];

  // The box and its interfaces: one busybox run
  if (opts.host || opts.network) {
    tasks.push(
      probe("host", host.HOST_TIMEOUT + 1000, async () => host.parseHostOutput(await host.runHostScript())).then(
        parsed => {
          if (closed) return;
          if (opts.host && parsed) result.host = parsed.host;
          if (opts.network) {
            result.network.interfaces = parsed ? parsed.network.interfaces : null;
            result.network.defaultRoute = parsed ? parsed.network.defaultRoute : null;
          }
        }
      )
    );
  }

  if (opts.network) {
    tasks.push(
      probe("dns", 6000, () => network.checkDns()).then(v => !closed && (result.network.dns = v)),
      probe("internet", 6000, () => network.checkInternet()).then(v => !closed && (result.network.internet = v)),
      probe("ipfs", 12000, () => network.readIpfsStore(addError)).then(
        v => !closed && (result.network.store.ipfs = v)
      ),
      probe("catalogue", 9000, () => network.checkCatalogue()).then(
        v => !closed && (result.network.store.catalogue = v)
      )
    );
  }

  // Containers, then per container: processes, logs, settings, client probes
  tasks.push(
    probe("containers", CONTAINERS_TIMEOUT, () => containers.readContainers({ timeout: CONTAINERS_TIMEOUT })).then(
      async list => {
        if (!list || closed) return;
        result.containers = list;
        const running = list.filter(c => c.running);
        const jobs = [];
        for (const c of running) {
          jobs.push(() =>
            probe(`processes ${c.id}`, PROCESSES_TIMEOUT + 500, () =>
              containers.readProcesses(c.name, { timeout: PROCESSES_TIMEOUT })
            ).then(p => !closed && (c.processes = p || []))
          );
        }
        if (opts.logs) {
          for (const c of list) {
            jobs.push(() =>
              probe(`logs ${c.id}`, LOGS_TIMEOUT + 500, () => containers.readLog(c.name, { timeout: LOGS_TIMEOUT })).then(
                l => !closed && (c.log = l)
              )
            );
          }
        }
        const clientJobs = [];
        if (opts.clients) {
          for (const c of list) {
            const client = clients.getClient(c.id);
            if (!client) continue;
            if (client.settingsPath && c.running) {
              jobs.push(() =>
                probe(`settings ${c.id}`, SETTINGS_TIMEOUT + 500, () =>
                  containers.readSettings(c.name, client.settingsPath, { timeout: SETTINGS_TIMEOUT })
                ).then(s => !closed && (c.settings = s))
              );
            }
            // HTTP, not docker: not limited with the docker jobs
            clientJobs.push(
              probe(`client ${c.id}`, CLIENT_TIMEOUT * 2, () =>
                clients.probeClient(client, c, { timeout: CLIENT_TIMEOUT, onError: addError })
              ).then(r => r && !closed && result.clients.push(r))
            );
          }
        }
        await Promise.all([mapLimit(jobs, DOCKER_CONCURRENCY, job => job()), ...clientJobs]);
      }
    )
  );

  let timer;
  const finished = await Promise.race([
    Promise.all(tasks),
    new Promise(resolve => (timer = setTimeout(() => resolve(TIMED_OUT), CAP_MS)))
  ]);
  clearTimeout(timer);
  if (finished === TIMED_OUT) {
    for (const name of pending) errors.push(`${name}: timed out`);
  }
  closed = true;

  if (result.clients) result.clients.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  result.durationMs = Date.now() - t0;
  return {
    message: errors.length
      ? `Collected diagnostics with ${errors.length} problem${errors.length === 1 ? "" : "s"}`
      : "Collected diagnostics",
    result
  };
}

// Tests only
getDiagnostics._setCapMs = ms => (CAP_MS = ms);

module.exports = getDiagnostics;
