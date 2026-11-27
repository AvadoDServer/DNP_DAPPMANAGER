const shellExec = require("utils/shell");

/**
 * The box's temperature sensors, read from /sys/class/hwmon inside this
 * container (sysfs shows the host's sensors; no privileged helper container
 * needed, unlike getDiagnostics' host run).
 *
 * One line per sensor: chip <TAB> device <TAB> label <TAB> input <TAB> max
 * <TAB> crit, temperatures in millidegrees. `device` is the sensor's parent
 * device (e.g. the PCI address of an NVMe drive), so drives keep their order.
 *
 * Every read runs under `timeout` (coreutils): a hung NVMe drive can block a
 * read of its temperature, and that must not block the rest.
 */
const HWMON = "/sys/class/hwmon";

const script = (root = HWMON) => [
  'T=""; command -v timeout >/dev/null 2>&1 && T="timeout -k 1 2"',
  'r() { $T cat "$1" 2>/dev/null; }',
  `for h in ${root}/hwmon*; do`,
  '  [ -d "$h" ] || continue',
  '  nm=$(r "$h/name")',
  '  dev=$(readlink "$h/device" 2>/dev/null); dev=${dev##*/}',
  '  for t in "$h"/temp*_input; do',
  '    [ -f "$t" ] || continue',
  "    b=${t%_input}",
  '    printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$nm" "$dev" "$(r "${b}_label")" "$(r "$t")" "$(r "${b}_max")" "$(r "${b}_crit")"',
  "  done",
  "done"
].join("\n");

// The whole read, normally a few ms
const READ_TIMEOUT = 5 * 1000;

function celsius(milli) {
  const s = (milli || "").trim();
  if (!/^-?\d+$/.test(s)) return null;
  return Math.round(Number(s) / 100) / 10;
}

// A threshold a sensor reports, or null when it reports none or nonsense
// (some drives report 0, others 65261.8 °C).
function threshold(milli) {
  const c = celsius(milli);
  return c !== null && c > 0 && c <= 150 ? c : null;
}

/**
 * @param {string} out the script's output
 * @returns {Array} [{ chip, device, label, celsius, high, crit }]
 */
function parseSensors(out) {
  const sensors = [];
  for (const line of (out || "").split("\n")) {
    if (!line.trim()) continue;
    const [chip, device, label, input, max, crit] = line.split("\t");
    const c = celsius(input);
    // An unwired sensor reads 0 (acpitz on many boxes); absurd values are no reading
    if (c === null || c <= 0 || c > 150) continue;
    sensors.push({
      chip: (chip || "").trim() || "sensor",
      device: (device || "").trim() || null,
      label: (label || "").trim() || null,
      celsius: c,
      high: threshold(max),
      crit: threshold(crit)
    });
  }
  return sensors;
}

// The shell read still going. Kept after we stop waiting for it: a cat stuck
// on a hung drive keeps it open, and a new read would only get stuck too.
let running = null;

/**
 * Reads the sensors. Rejects when the read fails, takes longer than
 * READ_TIMEOUT (a cat stuck on a hung drive keeps the pipe open, so the
 * shell's own timeout may never answer) or the previous read is still stuck.
 */
function readSensors() {
  if (running) return Promise.reject(Error("the previous read of the temperature sensors has not finished"));
  const done = shellExec(script(), { timeout: READ_TIMEOUT }).finally(() => {
    if (running === done) running = null;
  });
  running = done;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error("reading the temperature sensors timed out")), READ_TIMEOUT);
  });
  return Promise.race([done, timeout])
    .then(parseSensors)
    .finally(() => clearTimeout(timer));
}

// Tests only
function _reset() {
  running = null;
}

module.exports = { script, READ_TIMEOUT, parseSensors, readSensors, _reset };
