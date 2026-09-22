const os = require("os");
const shellExec = require("utils/shell");
const logs = require("logs.js")(module);

// Cache static values
const numCores = os.cpus().length;

/**
 * Returns the current disk space available of a requested path
 *
 * @returns {object} status = {
 *   cpu: "35%", {string}
 *   cpuName: "Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz", {string} CPU model name
 *   memory: "46%", {string}
 *   memTotal: "16.00 GB", {string} Total RAM in GB
 *   memUsed: "8.50 GB", {string} Used RAM in GB
 *   disk: "57%", {string}
 *   diskTotal: "1.50 TB", {string} Total disk size in TB
 *   diskUsed: "0.75 TB", {string} Used disk size in TB
 * }
 */
const getStats = async () => {
  const cpuUsedPercent = await wrapErrors(async () => {
    return getCpuPercent();
  }, "cpuUsedPercent");

  const cpuName = await wrapErrors(async () => {
    return os.cpus()[0].model;
  }, "cpuName");

  const memUsedPercent = await wrapErrors(async () => {
    const memTotal = await shellExec(`free | awk 'NR==2 { print $2}'`, true);
    const memUsed = await shellExec(`free | awk 'NR==2 { print $3}'`, true);
    return Math.floor((100 * parseInt(memUsed)) / parseInt(memTotal)) + "%";
  }, "memUsedPercent");

  const memTotal = await wrapErrors(async () => {
    const total = await shellExec(`free | awk 'NR==2 { print $2}'`, true);
    const kb = parseInt((total || "0").trim());
    return (kb / 1024 ** 2).toFixed(2) + " GB"; // Convert from KB to GB
  }, "memTotal");

  const memUsed = await wrapErrors(async () => {
    const used = await shellExec(`free | awk 'NR==2 { print $3}'`, true);
    const kb = parseInt((used || "0").trim());
    return (kb / 1024 ** 2).toFixed(2) + " GB"; // Convert from KB to GB
  }, "memUsed");

  const diskUsedPercent = await wrapErrors(async () => {
    const disk = await shellExec(`df / | awk 'NR==2 { print $5}'`, true);
    return (disk || "").trim();
  }, "diskUsedPercent");

  const diskTotal = await wrapErrors(async () => {
    const total = await shellExec(`df / | awk 'NR==2 { print $2}'`, true);
    const kb = parseInt((total || "0").trim());
    return (kb / 1024 ** 3).toFixed(2) + " TB"; // Convert from KB to TB
  }, "diskTotal");

  const diskUsed = await wrapErrors(async () => {
    const used = await shellExec(`df / | awk 'NR==2 { print $3}'`, true);
    const kb = parseInt((used || "0").trim());
    return (kb / 1024 ** 3).toFixed(2) + " TB"; // Convert from KB to TB
  }, "diskUsed");

  return {
    message: `Checked stats of this DAppNode server`,
    result: {
      cpu: cpuUsedPercent,
      cpuName: cpuName,
      memory: memUsedPercent,
      memTotal: memTotal,
      memUsed: memUsed,
      disk: diskUsedPercent,
      diskTotal: diskTotal,
      diskUsed: diskUsed,
    },
  };
};

// Utils

/**
 * Uses nodejs native os.loadavg, which returns three factors
 * [0.124352, 0.16262, 0.32514]
 * [1 min, 5 min, 15 min] averages
 * This util takes only the 1min and limits it to 100%
 * @returns {string} cpu usage percent "36%"
 */
function getCpuPercent() {
  let cpuFraction = os.loadavg()[0] / numCores;
  if (cpuFraction > 1) cpuFraction = 1;
  return Math.round(cpuFraction * 100) + "%";
}

/**
 * Wraps the shell calls to return null in case of error
 * @param {function} fn async getter
 * @param {string} name for the message
 */
async function wrapErrors(fn, name) {
  try {
    return await fn();
  } catch (e) {
    logs.warn(`Error fetching ${name}: ${e.stack}`);
  }
}

module.exports = getStats;
