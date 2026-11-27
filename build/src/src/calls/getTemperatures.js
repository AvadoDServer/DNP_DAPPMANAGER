const temperatures = require("modules/temperatures");
const logs = require("logs.js")(module);

/**
 * The box's temperature sensors (processor, NVMe drives, memory when it has
 * a sensor), for the Admin's Home. Read-only and cheap: a few small files in
 * /sys/class/hwmon.
 *
 * Callers share one read: a read in flight is joined, and its answer is
 * reused for CACHE_MS (several Admin tabs poll at once). A read that fails
 * or hangs (a drive that stopped answering) returns the last good answer,
 * marked by its readAt, while it is younger than STALE_MS, and no sensors
 * after that; a stuck read is never joined by a second one.
 *
 * @returns {object} result: {
 *   sensors: [{
 *     chip: "k10temp", {string} hwmon driver: k10temp/zenpower/coretemp
 *       (processor), nvme or drivetemp (disks), spd5118/jc42 (memory), ...
 *     device: "0000:01:00.0", {string|null} the sensor's parent device
 *     label: "Tctl", {string|null} e.g. "Composite" for an NVMe drive
 *     celsius: 69.5, {number}
 *     high: 89.8, {number|null} the sensor's own "too hot" mark, if any
 *     crit: 93.8, {number|null} the sensor's own critical mark, if any
 *   }],
 *   readAt: "2026-11-27T10:00:00.000Z" {string|null} when they were read
 * }
 */

let CACHE_MS = 10 * 1000;
let STALE_MS = 2 * 60 * 1000;

let last = null; // { sensors, readAt (ms) }
let inFlight = null;

function read() {
  if (!inFlight) {
    inFlight = temperatures
      .readSensors()
      .then(sensors => {
        last = { sensors, readAt: Date.now() };
        return last;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const getTemperatures = async () => {
  let reading = last;
  if (!reading || Date.now() - reading.readAt >= CACHE_MS) {
    try {
      reading = await read();
    } catch (e) {
      logs.warn(`Error reading temperatures: ${e.message}`);
      reading = last && Date.now() - last.readAt < STALE_MS ? last : null;
    }
  }
  const sensors = reading ? reading.sensors : [];
  return {
    message: `Read ${sensors.length} temperature sensor(s)`,
    result: {
      sensors,
      readAt: reading ? new Date(reading.readAt).toISOString() : null
    }
  };
};

// Tests only
getTemperatures._reset = ({ cacheMs = 10 * 1000, staleMs = 2 * 60 * 1000 } = {}) => {
  last = null;
  inFlight = null;
  CACHE_MS = cacheMs;
  STALE_MS = staleMs;
};

module.exports = getTemperatures;
