/**
 * Manifest fields for the compose generator that need a safety check first:
 *
 *   image.stop_grace_period  "10m", "90s", "1m30s" or a number of seconds
 *   image.mem_limit          "4g", "512m", "2GB" or a number of bytes
 *   image.deploy.resources.limits.memory   same as mem_limit (the compose v3
 *                            spelling; docker-compose 1.x only applies it with
 *                            --compatibility, so it becomes mem_limit here)
 *   image.devices            ["/dev/ttyUSB0", "/dev/dri:/dev/dri", ...]
 *
 * A value outside the caps is clamped (time, memory) or left out (devices),
 * with a reason the installer logs. A bad value never fails an install.
 */

// Time a package may take to stop. docker's default is 10 s; the DAPPMANAGER
// itself waits 180 s. Bitcoin Core flushing a big chainstate can need several
// minutes, but a box must still shut down and update in reasonable time.
const MIN_GRACE_S = 10;
const MAX_GRACE_S = 15 * 60;

// Memory limit. Below 64 MiB nearly every app is killed at start (a typo such
// as "4m" for "4g"); 256 GiB is more than any AVADO has.
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MIN_MEM = 64 * MIB;
const MAX_MEM = 256 * GIB;

/**
 * Host devices a package may ask for. Disks, memory, the kernel log, loop and
 * device-mapper nodes are never handed out: with them a package could read or
 * overwrite the box's own disk.
 */
const DEVICE_ALLOW = [
  /^\/dev\/tty(USB|ACM|AMA)\d{1,3}$/, // USB serial: Zigbee/Z-Wave sticks, GPS
  /^\/dev\/serial\/by-(id|path)\/[A-Za-z0-9._:+@-]{1,200}$/,
  /^\/dev\/bus\/usb(\/\d{3}(\/\d{3})?)?$/, // raw USB (Coral, SDR)
  /^\/dev\/dri(\/(card|renderD)\d{1,3})?$/, // GPU: video transcoding, AI
  /^\/dev\/kfd$/, // AMD GPU compute (ROCm)
  /^\/dev\/accel(\/accel\d{1,3})?$/, // NPUs (AMD XDNA, Intel)
  /^\/dev\/net\/tun$/, // VPNs
  /^\/dev\/hidraw\d{1,3}$/, // hardware wallets, UPS
  /^\/dev\/snd(\/[A-Za-z0-9]{1,40})?$/, // sound (voice assistants)
  /^\/dev\/video\d{1,3}$/, // cameras
  /^\/dev\/gpiochip\d{1,3}$/,
  /^\/dev\/apex_\d{1,2}$/ // Coral PCIe
];

const CONTAINER_DEVICE = /^\/dev\/[A-Za-z0-9._:+@/-]{1,200}$/;

/**
 * @param {string|number} value "10m", "90s", "1m30s", "1h", or seconds
 * @returns {number|null} seconds, null when it can't be read
 */
function parseDurationSeconds(value) {
  if (typeof value === "number") return isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (!/^(\d+(\.\d+)?(h|m|s|ms|us|µs|ns))+$/.test(s)) return null;
  const unit = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, µs: 1e-6, ns: 1e-9 };
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g;
  let m;
  while ((m = re.exec(s))) total += Number(m[1]) * unit[m[2]];
  return total;
}

/**
 * @param {string|number} value "4g", "512m", "2GB", "1.5GiB", or bytes
 * @returns {number|null} bytes, null when it can't be read
 */
function parseMemoryBytes(value) {
  if (typeof value === "number") return isFinite(value) && value > 0 ? Math.floor(value) : null;
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(i?b)?$/i);
  if (!m) return null;
  const mult = { "": 1, k: 1024, m: MIB, g: GIB, t: 1024 * GIB }[m[2].toLowerCase()];
  return Math.floor(Number(m[1]) * mult);
}

/**
 * stop_grace_period for the compose file.
 * @returns {{ value: string|undefined, seconds: number|undefined, note: string|undefined }}
 */
function stopGracePeriod(image = {}) {
  const raw = image.stop_grace_period;
  if (raw === undefined || raw === null || raw === "") return {};
  const seconds = parseDurationSeconds(raw);
  if (seconds === null) return { note: `stop_grace_period "${raw}" is not a duration, left out` };
  const clamped = Math.round(Math.min(MAX_GRACE_S, Math.max(MIN_GRACE_S, seconds)));
  const note =
    clamped !== Math.round(seconds)
      ? `stop_grace_period ${raw} is outside ${MIN_GRACE_S}s..${MAX_GRACE_S / 60}m, using ${clamped}s`
      : undefined;
  return { value: `${clamped}s`, seconds: clamped, note };
}

/**
 * mem_limit for the compose file, from image.mem_limit or
 * image.deploy.resources.limits.memory (mem_limit wins when both are set).
 * @returns {{ bytes: number|undefined, note: string|undefined }}
 */
function memoryLimit(image = {}) {
  const deployed =
    image.deploy && image.deploy.resources && image.deploy.resources.limits
      ? image.deploy.resources.limits.memory
      : undefined;
  const raw = image.mem_limit !== undefined && image.mem_limit !== null && image.mem_limit !== "" ? image.mem_limit : deployed;
  if (raw === undefined || raw === null || raw === "") return {};
  const bytes = parseMemoryBytes(raw);
  if (bytes === null) return { note: `memory limit "${raw}" is not a size, left out` };
  const clamped = Math.min(MAX_MEM, Math.max(MIN_MEM, bytes));
  const note = clamped !== bytes ? `memory limit ${raw} is outside 64m..256g, using ${clamped} bytes` : undefined;
  return { bytes: clamped, note };
}

/**
 * Parses one compose device entry: "host", "host:container" or
 * "host:container:perms".
 * @returns {{ host: string, container: string, perms: string }|null}
 */
function parseDevice(entry) {
  if (typeof entry !== "string") return null;
  const parts = entry.trim().split(":");
  if (parts.length > 3) return null;
  const [host, container = host, perms = "rwm"] = parts;
  if (!host) return null;
  if (!CONTAINER_DEVICE.test(container) || container.includes("..")) return null;
  if (!/^[rwm]{1,3}$/.test(perms) || new Set(perms).size !== perms.length) return null;
  return { host, container, perms };
}

function isAllowedHostDevice(host) {
  return typeof host === "string" && !host.includes("..") && DEVICE_ALLOW.some(re => re.test(host));
}

/**
 * Devices for the compose file.
 * @param {object} image manifest.image
 * @param {string[]} [presentDevices] host device paths that exist; when
 *   given, a device that is not on the host is left out (docker refuses to
 *   create a container whose device is missing, e.g. a Zigbee stick that is
 *   not plugged in). When not given, every allowed device is kept.
 * @returns {{ devices: string[], notes: string[] }}
 */
function devices(image = {}, presentDevices) {
  const notes = [];
  const out = [];
  if (!Array.isArray(image.devices)) {
    if (image.devices !== undefined) notes.push("devices must be a list, left out");
    return { devices: out, notes };
  }
  const present = Array.isArray(presentDevices) ? new Set(presentDevices) : null;
  for (const entry of image.devices) {
    const d = parseDevice(entry);
    if (!d) {
      notes.push(`device "${entry}" is not a valid entry, left out`);
      continue;
    }
    if (!isAllowedHostDevice(d.host)) {
      notes.push(`device ${d.host} is not allowed, left out`);
      continue;
    }
    if (present && !present.has(d.host)) {
      notes.push(`device ${d.host} is not on this AVADO, left out`);
      continue;
    }
    const value = `${d.host}:${d.container}:${d.perms}`;
    if (!out.includes(value)) out.push(value);
  }
  return { devices: out, notes };
}

/** Host paths of the allowed devices a manifest asks for (for the host check) */
function requestedHostDevices(image = {}) {
  if (!Array.isArray(image.devices)) return [];
  return image.devices
    .map(parseDevice)
    .filter(d => d && isAllowedHostDevice(d.host))
    .map(d => d.host);
}

/**
 * Seconds to give a package to stop: the larger of `timeout` and the
 * stop_grace_period in its compose file. docker-compose's `-t` replaces the
 * service's stop_grace_period, so a fixed 180 s would cut a longer one short.
 * @param {object} composeObj parsed docker-compose file
 */
function stopTimeoutOf(composeObj, timeout) {
  let max = 0;
  const services = (composeObj && composeObj.services) || {};
  for (const name of Object.keys(services)) {
    const s = parseDurationSeconds(services[name] && services[name].stop_grace_period);
    if (s !== null && s > max) max = s;
  }
  const t = Number(timeout);
  return Math.ceil(Math.max(isNaN(t) ? 0 : t, Math.min(max, MAX_GRACE_S)));
}

module.exports = {
  parseDurationSeconds,
  parseMemoryBytes,
  stopGracePeriod,
  memoryLimit,
  devices,
  requestedHostDevices,
  isAllowedHostDevice,
  stopTimeoutOf,
  MAX_GRACE_S,
  MIN_GRACE_S,
  MIN_MEM,
  MAX_MEM
};
