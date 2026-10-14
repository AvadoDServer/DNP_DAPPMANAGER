const { runOk } = require("./exec");

/**
 * The box itself (uptime, memory, disk, temperatures, kernel log) and its
 * network interfaces, read in ONE privileged busybox run that chroots into
 * the host, the pattern rebootHost and getInternalIp use. Read-only: the
 * script only reads /proc, /sys and /etc and runs df, ip and dmesg.
 *
 * Each section starts with a "### <name>" line (after an empty line, as a
 * file such as /etc/os-release may not end with a newline); parseHostOutput
 * splits them.
 */

const HOST_TIMEOUT = 10 * 1000;

const HOST_SCRIPT = [
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "echo; echo '### uptime'; cat /proc/uptime",
  "echo; echo '### loadavg'; cat /proc/loadavg",
  "echo; echo '### cores'; grep -c '^processor' /proc/cpuinfo",
  "echo; echo '### meminfo'; cat /proc/meminfo",
  "echo; echo '### os'; cat /etc/os-release",
  "echo; echo '### kernel'; uname -r",
  "echo; echo '### df'; df -kP /",
  "echo; echo '### links'; ip -o link",
  "echo; echo '### addrs'; ip -o -4 addr",
  "echo; echo '### routes'; ip route",
  // name operstate carrier wireless|-   (carrier cannot be read while the
  // interface is down: empty)
  "echo; echo '### netstate'; for n in /sys/class/net/*; do b=${n##*/}; w=-; [ -d \"$n/wireless\" ] && w=wireless; echo \"$b $(cat $n/operstate 2>/dev/null) $(cat $n/carrier 2>/dev/null) $w\"; done",
  // hwmon-name <TAB> label <TAB> millidegrees
  "echo; echo '### hwmon'; for h in /sys/class/hwmon/hwmon*; do [ -d \"$h\" ] || continue; nm=$(cat $h/name 2>/dev/null); for t in $h/temp*_input; do [ -f \"$t\" ] || continue; l=${t%_input}_label; printf '%s\\t%s\\t%s\\n' \"$nm\" \"$(cat $l 2>/dev/null)\" \"$(cat $t 2>/dev/null)\"; done; done",
  "echo; echo '### dmesg'; { dmesg -T 2>/dev/null || dmesg 2>/dev/null; } | tail -n 400",
  "echo; echo '### end'"
].join("\n");

const hostCommandArgs = () => [
  "run",
  "--rm",
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

/**
 * @returns {Promise<string>} the raw sectioned output of the host script
 */
function runHostScript() {
  return runOk("docker", hostCommandArgs(), { timeout: HOST_TIMEOUT });
}

/** "### name" sections -> { name: [lines] } */
function splitSections(out) {
  const sections = {};
  let current = null;
  for (const line of String(out || "").split("\n")) {
    const m = line.match(/^### (\S+)\s*$/);
    if (m) {
      current = m[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
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
    if (c === null) continue;
    const n = [name, label].map(s => (s || "").trim()).filter(Boolean).join(" ");
    temps.push({ name: n || "sensor", celsius: round1(c / 1000) });
  }
  return temps;
}

const DMESG = {
  oom: /Out of memory|oom-kill|Killed process/,
  hardware: /I\/O error|nvme.*(timeout|reset|error)|ata.*error|EXT4-fs error|temperature|thermal|MCE|Hardware Error/i,
  // The spec's "wlan" plus the predictable names Debian gives Wi-Fi (wlp3s0, wlx…)
  network: /link (is )?(down|up)|NETDEV WATCHDOG|carrier|\bwl\w*.*(disconnect|deauth)/i
};
// Docker's own virtual interfaces go up and down with every container
const DOCKER_IFACE = /\b(veth\w*|docker\d+|br-[0-9a-f]+)\b/;

function parseDmesg(ls) {
  const pick = (re, skip) => ls.filter(l => re.test(l) && !(skip && skip.test(l))).slice(-10);
  return {
    oom: pick(DMESG.oom),
    hardware: pick(DMESG.hardware),
    network: pick(DMESG.network, DOCKER_IFACE)
  };
}

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
    interfaces.push({ name, type, up, carrier, ipv4: ipv4[name] || [] });
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
  if (!sections.uptime) throw Error("unexpected output of the host script");
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
      dmesg: parseDmesg(lines(sections, "dmesg"))
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
  hostCommandArgs,
  runHostScript,
  parseHostOutput
};
