const { spawn } = require("child_process");
const getDappmanagerImage = require("utils/getDappmanagerImage");
const logs = require("logs.js")(module);

/**
 * Starts modules/backup/helper.js in a short-lived container of the
 * DAPPMANAGER's own image (always on the box, has restic, mount.cifs and
 * ntfs-3g). Same pattern as modules/hostPassword: the secrets (passphrase,
 * NAS password) travel only on the container's stdin, never in an argument,
 * an environment variable, a file on the box or a log; the container has no
 * log driver.
 *
 * The container is privileged so it can mount the USB disk or NAS share
 * inside its own mount namespace: the box itself never mounts it, and the
 * mount disappears with the container.
 */

const CONTAINER_PREFIX = "avado-backup-";
const HELPER = "/usr/src/app/src/modules/backup/helper.js";
const CACHE_VOLUME = "avado-backup-cache";
const STAGE_VOLUME = "avado-backup-stage";

/**
 * docker run arguments.
 * @param {object} o
 * @param {string} o.image
 * @param {string} o.name container name suffix
 * @param {"usb"|"smb"} o.targetType
 * @param {Array<{ host: string, dir: string, ro: boolean }>} o.mounts
 * @param {boolean} [o.stage] mount the staging volume
 */
function helperArgs({ image, name, targetType, mounts = [], stage = false }) {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    CONTAINER_PREFIX + name,
    "--privileged",
    "--log-driver",
    "none",
    "--network",
    targetType === "smb" ? "bridge" : "none",
    "--tmpfs",
    "/run/secrets:size=1m,mode=0700",
    "-v",
    `${CACHE_VOLUME}:/cache`
  ];
  if (targetType === "usb") args.push("-v", "/dev:/dev");
  if (stage) args.push("-v", `${STAGE_VOLUME}:/stage`);
  for (const m of mounts) {
    if (!/^\/[^:,\n]*$/.test(m.host) || !/^\/vol\/\d+$/.test(m.dir)) throw Error(`unexpected mount ${m.host}`);
    args.push("-v", `${m.host}:${m.dir}${m.ro ? ":ro" : ""}`);
  }
  args.push("--entrypoint", "node", image, HELPER);
  return args;
}

let spawnImpl = spawn;

/**
 * Runs one helper job.
 * @param {object} job see helper.js (secrets included)
 * @param {object} o helperArgs options without image
 * @param {object} [hooks]
 * @param {function} [hooks.onEvent] every event but result/error
 * @param {function} [hooks.onPause] async (name) => before the app's data is
 *   copied; the helper waits until it resolves
 * @param {function} [hooks.onResume] async (name) => after the copy
 * @param {number} [hooks.timeoutMs] whole job
 * @returns {Promise<object>} the result event
 */
async function runHelper(job, o, hooks = {}) {
  const image = o.image || (await getDappmanagerImage());
  const args = helperArgs({ ...o, image });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(Error(`Could not start the backup helper: ${e.message}`));
    }
    let buf = "";
    let final = null;
    let stderr = "";
    let chain = Promise.resolve();
    const timer = hooks.timeoutMs
      ? setTimeout(() => {
          logs.warn(`backup helper ${o.name} took too long, stopping it`);
          spawnImpl("docker", ["rm", "-f", CONTAINER_PREFIX + o.name], { stdio: "ignore" });
        }, hooks.timeoutMs)
      : null;
    const handle = ev => {
      if (ev.ev === "result" || ev.ev === "error") {
        final = ev;
        return;
      }
      if (ev.ev === "pause") {
        chain = chain
          .then(() => (hooks.onPause ? hooks.onPause(ev.name) : null))
          .catch(e => logs.warn(`backup: pausing ${ev.name} failed: ${e.message}`))
          .then(() => {
            if (child.stdin.writable) child.stdin.write("go\n");
          });
        return;
      }
      if (ev.ev === "resume") {
        chain = chain.then(() => (hooks.onResume ? hooks.onResume(ev.name, ev) : null)).catch(e =>
          logs.warn(`backup: resuming ${ev.name} failed: ${e.message}`)
        );
        return;
      }
      if (ev.ev === "log") logs.info(`backup helper: ${ev.message}`);
      if (hooks.onEvent) {
        try {
          hooks.onEvent(ev);
        } catch (e) {
          // a listener must not stop the job
        }
      }
    };
    child.stdout.on("data", chunk => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch (e) {
          continue;
        }
        handle(ev);
      }
    });
    // stderr is only kept for docker's own errors (no image, name in use)
    child.stderr.on("data", c => {
      if (stderr.length < 2000) stderr += c.toString("utf8");
    });
    child.on("error", e => {
      if (timer) clearTimeout(timer);
      reject(Error(`Could not start the backup helper: ${e.message}`));
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      // Always let a pending resume finish before answering
      chain.then(() => {
        if (final && final.ev === "result") return resolve(final);
        if (final && final.ev === "error") {
          const e = Error(final.message);
          e.code = final.code;
          e.partial = final.partial;
          return reject(e);
        }
        const e = Error(
          /Conflict|already in use/i.test(stderr)
            ? "Another backup job is running. Wait for it to end."
            : `The backup helper stopped (${code}). ${stderr.trim().slice(0, 200)}`
        );
        e.code = "helper";
        reject(e);
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(job) + "\n");
  });
}

module.exports = {
  runHelper,
  helperArgs,
  CONTAINER_PREFIX,
  CACHE_VOLUME,
  STAGE_VOLUME,
  _setSpawn: f => (spawnImpl = f || spawn)
};
