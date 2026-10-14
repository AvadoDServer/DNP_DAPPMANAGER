const { run } = require("./exec");
const { scrub } = require("./scrub");

/**
 * The box itself (uptime, memory, disk, temperatures, kernel log) and its
 * network interfaces, read in ONE privileged busybox run that chroots into
 * the host, the pattern rebootHost and getInternalIp use. Read-only: the
 * script only reads /proc, /sys and /etc and runs date, df, ip and dmesg.
 *
 * Each section starts with a "### <name>" line (after an empty line, as a
 * file such as /etc/os-release may not end with a newline); parseHostOutput
 * splits them. Every read runs under `timeout 3` (coreutils on the host;
 * without it, unguarded), so a hung NVMe sensor or df only empties its own
 * section. The most useful sections come first and sensors last: when the
 * whole run hits HOST_TIMEOUT, the sections printed so far are still parsed
 * and the container (named, so it can be found) is removed.
 */

let HOST_TIMEOUT = 10 * 1000;
const HOST_CONTAINER = "dappmanager-diag-host";

const HOST_SCRIPT = [
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  'T=""; command -v timeout >/dev/null 2>&1 && T="timeout -k 1 3"',
  'r() { $T cat "$1" 2>/dev/null; }',
  "echo; echo '### uptime'; r /proc/uptime",
  // dmesg -T prints the host's local time: its UTC offset dates the lines
  "echo; echo '### tz'; $T date +%z",
  "echo; echo '### loadavg'; r /proc/loadavg",
  "echo; echo '### cores'; $T grep -c '^processor' /proc/cpuinfo",
  "echo; echo '### meminfo'; r /proc/meminfo",
  "echo; echo '### os'; r /etc/os-release",
  "echo; echo '### kernel'; $T uname -r",
  "echo; echo '### dmesg'; { $T dmesg -T 2>/dev/null || $T dmesg 2>/dev/null; } | tail -n 400",
  "echo; echo '### links'; $T ip -o link",
  "echo; echo '### addrs'; $T ip -o -4 addr",
  "echo; echo '### routes'; $T ip route",
  // name operstate carrier wireless|-   (carrier cannot be read while the
  // interface is down: empty)
  "echo; echo '### netstate'; for n in /sys/class/net/*; do b=${n##*/}; w=-; [ -d \"$n/wireless\" ] && w=wireless; echo \"$b $(r $n/operstate) $(r $n/carrier) $w\"; done",
  "echo; echo '### df'; $T df -kP /",
  // hwmon-name <TAB> label <TAB> millidegrees
  "echo; echo '### hwmon'; for h in /sys/class/hwmon/hwmon*; do [ -d \"$h\" ] || continue; nm=$(r $h/name); for t in $h/temp*_input; do [ -f \"$t\" ] || continue; l=${t%_input}_label; printf '%s\\t%s\\t%s\\n' \"$nm\" \"$(r $l)\" \"$(r $t)\"; done; done",
  "echo; echo '### end'"
].join("\n");

const hostCommandArgs = () => [
  "run",
  "--rm",
  "--name",
  HOST_CONTAINER,
  "--privileged",
  "--net=host",
  "--pid=host",
  "-v",
  "/:/host",
  "busybox",
  "chroot",
  "/host",
  "sh",
  "-c",
  HOST_SCRIPT
];

const removeHostContainer = () =>
  run("docker", ["rm", "-f", HOST_CONTAINER], { timeout: HOST_TIMEOUT }).catch(() => null);

const firstLine = s => (s || "").trim().split("\n")[0];

async function runOnce() {
  let res;
  try {
    res = await run("docker", hostCommandArgs(), { timeout: HOST_TIMEOUT });
  } catch (e) {
    if (!e.timedOut) throw e;
    // Killing the docker CLI does not stop the container. Not awaited: a read
    // stuck in the kernel (a hung NVMe) can keep `docker rm -f` waiting too,
    // and the sections already read must come back now.
    removeHostContainer();
    if (!/^### /m.test(e.stdout || "")) throw e;
    return { output: e.stdout, error: `${e.message}, kept the sections read until then` };
  }
  if (res.code !== 0) {
    const err = Error(firstLine(res.stderr) || `exit code ${res.code}`);
    err.conflict = /already in use/i.test(res.stderr);
    throw err;
  }
  return { output: res.stdout, error: null };
}

let inFlight = null;

/**
 * Runs the host script: one run at a time per process, concurrent callers
 * share it
 * @returns {Promise<{ output: string, error: string|null }>} error: why the
 *   output is partial (timed out), null when complete
 */
function runHostScript() {
  if (!inFlight) {
    inFlight = (async () => {
      try {
        return await runOnce();
      } catch (e) {
        // A container left by a DAPPMANAGER that died mid-run
        if (!e.conflict) throw e;
        await removeHostContainer();
        return runOnce();
      }
    })().finally(() => (inFlight = null));
  }
  return inFlight;
}

/** "### name" sections -> { name: [lines] }, every line scrubbed */
function splitSections(out) {
  const sections = {};
  let current = null;
  for (const line of String(out || "").split("\n")) {
    const m = line.match(/^### (\S+)\s*$/);
    if (m) {
      current = m[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(scrub(line));
    }
  }
  return sections;
}

const lines = (sections, name) => (sections[name] || []).filter(l => l.trim() !== "");
const round1 = n => Math.round(n * 10) / 10;
const num = s => {
  if (s === null || s === undefined || String(s).trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function parseMeminfo(ls) {
  const kb = {};
  for (const l of ls) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) kb[m[1]] = Number(m[2]);
  }
  const mb = k => (Number.isFinite(kb[k]) ? Math.round(kb[k] / 1024) : null);
  const swapTotal = mb("SwapTotal");
  const swapFree = mb("SwapFree");
  return {
    memTotalMB: mb("MemTotal"),
    memAvailableMB: mb("MemAvailable"),
    swapTotalMB: swapTotal,
    swapUsedMB: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null
  };
}

function parseOs(ls) {
  for (const l of ls) {
    const m = l.match(/^PRETTY_NAME=(.*)$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

// Filesystem 1024-blocks Used Available Capacity Mounted on
function parseDf(ls) {
  const row = ls.find(l => /\s\/\s*$/.test(l)) || ls[1];
  if (!row) return null;
  const f = row.trim().split(/\s+/);
  const gb = kb => (Number.isFinite(Number(kb)) ? round1(Number(kb) / 1024 / 1024) : null);
  return { totalGB: gb(f[1]), usedGB: gb(f[2]), availableGB: gb(f[3]) };
}

function parseTemperatures(ls) {
  const temps = [];
  for (const l of ls) {
    const [name, label, milli] = l.split("\t");
    const c = num((milli || "").trim());
    // A sensor that reads 0 (unwired acpitz) or an absurd value is no reading
    if (c === null || c <= 0 || c > 150 * 1000) continue;
    const n = [name, label].map(s => (s || "").trim()).filter(Boolean).join(" ");
    temps.push({ name: n || "sensor", celsius: round1(c / 1000) });
  }
  return temps;
}

const DMESG = {
  oom: /Out of memory|oom-kill|Killed process/,
  hardware: /I\/O error|nvme.*(timeout|reset controller|failed|abort)|ata\d.*(error|failed command)|EXT4-fs error|Machine Check|Hardware Error|critical temperature|thermal.*(critical|shutdown)/i,
  // Boot messages that name the same words but report no fault
  hardwareNot: /Thermal monitoring|thermal_sys|mce: CPU supports|Shutdown timeout set to/i,
  // "wlan" plus the predictable names Debian gives Wi-Fi (wlp3s0, wlx…)
  network: /link (is )?(down|up)|carrier|NETDEV WATCHDOG|\bwl\w*.*(disconnect|deauth)/i,
  // An empty SATA port, and Docker's own interfaces that go up and down with
  // every container
  networkNot: /SATA link|docker|veth|br-/i
};
// Every link comes up once while the box boots: not a flapping network
const BOOT_QUIET_MS = 180 * 1000;

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * The time of a `dmesg -T` line ("[Mon Oct 13 22:01:02 2026] …", the host's
 * local time) in ms, with the host's UTC offset ("+0200"); null when either
 * is unknown
 */
function dmesgTime(line, tz) {
  const m = line.match(/^\[\w{3} (\w{3})\s+(\d{1,2}) (\d\d):(\d\d):(\d\d) (\d{4})\]/);
  const z = String(tz || "").trim().match(/^([+-])(\d\d)(\d\d)$/);
  if (!m || !z || MONTHS[m[1]] === undefined) return null;
  const offsetMin = (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offsetMin * 60 * 1000;
}

/**
 * @param {string[]} ls dmesg -T lines
 * @param {object} context { tz: "+0200", bootMs } network lines from the
 *   first 3 minutes after boot are left out
 */
function parseDmesg(ls, { tz = null, bootMs = null } = {}) {
  const last10 = list => list.slice(-10);
  const afterBoot = l => {
    const t = dmesgTime(l, tz);
    return t === null || bootMs === null || t >= bootMs + BOOT_QUIET_MS;
  };
  return {
    oom: last10(ls.filter(l => DMESG.oom.test(l))),
    hardware: last10(ls.filter(l => DMESG.hardware.test(l) && !DMESG.hardwareNot.test(l))),
    network: last10(ls.filter(l => DMESG.network.test(l) && !DMESG.networkNot.test(l) && afterBoot(l)))
  };
}

// Private, shared, link-local and loopback ranges; any other IPv4 address on
// an interface is the box's public address and is not returned
const PRIVATE_IPV4 = [
  [10, 0, 8],
  [172, 16, 12],
  [192, 168, 16],
  [100, 64, 10],
  [169, 254, 16],
  [127, 0, 8]
];

function isPrivateIpv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const value = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  return PRIVATE_IPV4.some(([a, b, bits]) => {
    const base = ((a << 24) >>> 0) + (b << 16);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

const maskPublic = ip => (isPrivateIpv4(ip) ? ip : "<public>");

// Interfaces that are not a way out of the box
const VIRTUAL_IFACE = /^(lo|veth.*|docker\d*|br-.*)$/;

function parseInterfaces(sections) {
  const state = {};
  for (const l of lines(sections, "netstate")) {
    const f = l.trim().split(/\s+/);
    // "eth0 up 1 -", "eth1 down  -" (carrier unreadable while down)
    const name = f[0];
    const wireless = f[f.length - 1] === "wireless";
    const operstate = f.length >= 3 ? f[1] : null;
    const carrier = f.length >= 4 ? f[2] : null;
    state[name] = { operstate, carrier, wireless };
  }
  const ipv4 = {};
  for (const l of lines(sections, "addrs")) {
    // 2: eth0    inet 192.168.1.5/24 brd 192.168.1.255 scope global dynamic eth0\       valid_lft ...
    const m = l.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/);
    if (m) (ipv4[m[1]] = ipv4[m[1]] || []).push(m[2]);
  }
  const interfaces = [];
  const seen = new Set();
  for (const l of lines(sections, "links")) {
    // 2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 ... state UP ...
    const m = l.match(/^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<([^>]*)>/);
    if (!m) continue;
    const name = m[1];
    if (VIRTUAL_IFACE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const flags = m[2].split(",");
    const s = state[name] || {};
    const wifi = s.wireless || /^wl/.test(name);
    const type = wifi ? "wifi" : /^(eth|en)/.test(name) ? "ethernet" : "other";
    const up = s.operstate ? s.operstate === "up" : flags.includes("UP") && flags.includes("LOWER_UP");
    // carrier: "1" link, "0" no link; unreadable (interface down) counts as no link
    const carrier = s.carrier !== null && s.carrier !== undefined ? s.carrier === "1" : flags.includes("LOWER_UP");
    // The kernel's idle tunnel devices (sit0, gre0, tunl0, bond0…): down,
    // no address, nothing to say
    if (type === "other" && !up && !(ipv4[name] || []).length) continue;
    interfaces.push({ name, type, up, carrier, ipv4: (ipv4[name] || []).map(maskPublic) });
  }
  return interfaces;
}

function parseDefaultRoute(ls) {
  let best = null;
  for (const l of ls) {
    if (!/^default\s/.test(l)) continue;
    const dev = l.match(/\bdev\s+(\S+)/);
    const via = l.match(/\bvia\s+(\S+)/);
    const metric = l.match(/\bmetric\s+(\d+)/);
    const route = {
      interface: dev ? dev[1] : null,
      gateway: via ? via[1] : null,
      metric: metric ? Number(metric[1]) : 0
    };
    if (!best || route.metric < best.metric) best = route;
  }
  return best ? { interface: best.interface, gateway: best.gateway } : null;
}

/**
 * @param {string} out the host script's output
 * @param {number} now ms
 * @returns {{ host: object, network: { interfaces, defaultRoute } }}
 */
function parseHostOutput(out, now = Date.now()) {
  const sections = splitSections(out);
  // A run cut short keeps the sections it printed; none at all is an error
  if (!Object.keys(sections).length) throw Error("unexpected output of the host script");
  const uptime = num((lines(sections, "uptime")[0] || "").split(/\s+/)[0]);
  const uptimeSeconds = uptime === null ? null : Math.floor(uptime);
  const load = (lines(sections, "loadavg")[0] || "").split(/\s+/).slice(0, 3).map(num);
  const host = Object.assign(
    {
      uptimeSeconds,
      bootedAt: uptimeSeconds === null ? null : new Date(now - uptimeSeconds * 1000).toISOString(),
      loadavg: load.length === 3 ? load : null,
      cores: num((lines(sections, "cores")[0] || "").trim())
    },
    parseMeminfo(lines(sections, "meminfo")),
    {
      kernel: (lines(sections, "kernel")[0] || "").trim() || null,
      os: parseOs(lines(sections, "os")),
      rootDisk: parseDf(lines(sections, "df")),
      temperatures: parseTemperatures(lines(sections, "hwmon")),
      dmesg: parseDmesg(lines(sections, "dmesg"), {
        tz: (lines(sections, "tz")[0] || "").trim() || null,
        bootMs: uptimeSeconds === null ? null : now - uptimeSeconds * 1000
      })
    }
  );
  return {
    host,
    network: {
      interfaces: parseInterfaces(sections),
      defaultRoute: parseDefaultRoute(lines(sections, "routes"))
    }
  };
}

module.exports = {
  HOST_SCRIPT,
  HOST_TIMEOUT,
  HOST_CONTAINER,
  isPrivateIpv4,
  // Tests only
  _setHostTimeout: ms => (HOST_TIMEOUT = ms),
  hostCommandArgs,
  runHostScript,
  parseHostOutput
};
