const { spawn } = require("child_process");

/**
 * Runs a program without a shell (arguments are passed as they are, so a
 * container name or a script never needs quoting) and collects its output.
 *
 * Unlike utils/shell it resolves for any exit code, keeps stdout and stderr
 * apart and also in the order they arrived (`combined`, what `2>&1` gives),
 * and stops reading after `maxBytes` so a chatty container cannot fill memory.
 *
 * @param {string} file e.g. "docker"
 * @param {string[]} args
 * @param {object} options { timeout (ms), maxBytes }
 * @returns {Promise<{ code: number, stdout: string, stderr: string, combined: string }>}
 *   rejects only when the program cannot start or runs past the timeout
 *   (that error has `timedOut` and the `stdout` received until then)
 */
function run(file, args, { timeout = 10 * 1000, maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    const err = [];
    const all = [];
    let bytes = 0;
    let done = false;
    const collect = list => chunk => {
      if (bytes >= maxBytes) return;
      bytes += chunk.length;
      list.push(chunk);
      all.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      const e = Error(`timed out after ${Math.round(timeout / 1000)} s`);
      // What arrived before the timeout, for callers that can use part of it
      e.timedOut = true;
      e.stdout = Buffer.concat(out).toString("utf8");
      reject(e);
    }, timeout);
    child.on("error", e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code: code === null ? -1 : code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        combined: Buffer.concat(all).toString("utf8")
      });
    });
  });
}

/**
 * Like run, but a non-zero exit code is an error carrying the program's
 * first stderr line
 * @returns {Promise<string>} stdout
 */
async function runOk(file, args, options) {
  const res = await run(file, args, options);
  if (res.code !== 0) {
    const line = (res.stderr || res.stdout || "").trim().split("\n")[0];
    throw Error(line || `exit code ${res.code}`);
  }
  return res.stdout;
}

module.exports = { run, runOk };
