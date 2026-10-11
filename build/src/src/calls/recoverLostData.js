const fs = require("fs");
const getPath = require("utils/getPath");
const params = require("params");
const docker = require("modules/docker");
const dockerList = require("modules/dockerList");
const lostData = require("modules/lostData");
const shell = require("utils/shell");
const logUi = require("utils/logUi");
const { shortNameCapitalized } = require("utils/strings");
const logs = require("logs.js")(module);
const { eventBus, eventBusTag } = require("eventBus");

const COPY_TIMEOUT = 10 * 60 * 1000;

/**
 * Copies the unused volume into the live one without overwriting anything,
 * keeping owners, modes and symlinks, then checks that every source file
 * exists in the target.
 *
 * Not `cp -an /from/. /to/`: busybox cp -n skips a directory that already
 * exists as a whole (tested on busybox 1.38), so it copies nothing into an
 * existing volume root. Instead every entry, parents first, that does not
 * exist in the target is copied with cp -a; an entry that exists is kept and
 * only its children are looked at. `&&` makes a failed cp or a MISSING file
 * end the script with a non-zero exit.
 *
 * Before copying, the files that already exist in the target (and so are
 * kept, not copied) are counted: `SKIPPED <files> <names with wallet or
 * password>`. Only the counts are printed, never the list, so a big volume
 * cannot overflow the output buffer.
 */
const copyCommand = (name, volume, target) =>
  `docker run --rm --name ${name} -v ${volume}:/from:ro -v ${target}:/to busybox sh -c '` +
  `cd /from && find . -type f | while IFS= read -r f; do if [ -e "/to/$f" ] || [ -L "/to/$f" ]; then echo "$f"; fi; done > /tmp/skipped` +
  ` && echo "SKIPPED $(wc -l < /tmp/skipped) $(grep -ciE "wallet|password" /tmp/skipped)"` +
  ` && find . -mindepth 1 | while IFS= read -r f; do [ -e "/to/$f" ] || [ -L "/to/$f" ] || cp -an "$f" "/to/$f" || exit 1; done` +
  ` && find . -type f | while IFS= read -r f; do [ -e "/to/$f" ] || { echo "MISSING $f"; exit 1; }; done` +
  ` && find . -type f | wc -l && du -sk /to'`;

const lines = s =>
  String(s || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

/**
 * First useful line of a failed copy, without the command itself
 */
function firstLine(e) {
  const missing = lines(e.stdout).find(l => l.startsWith("MISSING "));
  if (missing) return missing;
  const stderr = lines(e.stderr)[0];
  if (stderr) return stderr;
  return (
    lines(e.message).filter(l => !l.startsWith("Command failed:"))[0] ||
    "unknown error"
  );
}

const TIMED_OUT = Error(
  "Recovering the data took longer than 10 minutes and was stopped. Files already copied were kept; contact AVADO support."
);
const SKIPPED_WARNING =
  "Some files already existed in the app's storage and were kept; the copy from the old storage was not used for them.";

const failed = line =>
  Error(
    `Recovering the data failed: ${line.replace(/\.$/, "")}. Nothing was deleted; contact AVADO support.`
  );

/**
 * Copies a package's data from an unused volume found by findLostData into
 * the package's live volume. Nothing is ever deleted: files that already
 * exist in the live volume are kept as they are.
 *
 * @param {string} id DNP .eth name
 * @param {string} volume name of a candidate returned by findLostData
 */
const recoverLostData = async ({ id, volume }) => {
  if (!id) throw Error("kwarg id must be defined");
  if (!volume || typeof volume !== "string") {
    throw Error("kwarg volume must be defined");
  }
  if (id.includes("dappmanager.dnp.dappnode.eth")) {
    throw Error(
      "The data of the AVADO package manager cannot be recovered this way. Nothing was changed."
    );
  }
  const title = shortNameCapitalized(id);
  const log = message => logUi({ id, name: id, message });

  const dnps = ((await dockerList.listContainers()) || []).filter(
    c => c.name === id
  );
  if (dnps.length === 0) {
    throw Error(`${title} is not installed. Nothing was changed.`);
  }
  if (dnps.some(c => c.isCore)) {
    throw Error(
      `${title} is part of the AVADO system; its data cannot be recovered this way. Nothing was changed.`
    );
  }

  const dcPath = getPath.dockerComposeSmart(id, params);
  if (!fs.existsSync(dcPath)) {
    throw Error(`${title} is missing its configuration. Nothing was changed.`);
  }

  // 1. The volume must still be a candidate of a fresh scan
  log("Looking for the data");
  const entry = (await lostData.scan({ id })).find(e => e.package === id);
  const candidate =
    entry && entry.candidates.find(c => c.name === volume);
  if (!candidate) {
    throw Error(
      "That volume is not on the list any more. Reload the page and try again."
    );
  }
  const { target } = candidate;
  if (
    !lostData.VOLUME_REGEX.test(candidate.name) ||
    !lostData.VOLUME_REGEX.test(target || "")
  ) {
    throw Error(
      "That volume is not on the list any more. Reload the page and try again."
    );
  }

  // 2. Stop, copy, start. Once the stop has run, always start again.
  let error = null;
  let files = 0;
  let sizeKb = 0;
  let skipped = 0;
  let keyFilesSkipped = false;
  try {
    log(`Stopping ${title}`);
    await docker.compose.stop(dcPath, { timeout: 300 });

    log(`Copying the data into ${title}. This can take several minutes`);
    // The throwaway container gets a name: when the shell times out only the
    // docker client is killed, so the container is removed by name before
    // the package starts again on top of a copy that is still running.
    const name = `recover-data-${Date.now()}`;
    let out;
    try {
      out = await shell(copyCommand(name, candidate.name, target), {
        timeout: COPY_TIMEOUT
      });
    } catch (e) {
      logs.error(`recoverLostData ${id}: copy from ${volume} failed: ${e.message} ${e.stdout || ""}`);
      await shell(`docker rm -f ${name}`).catch(() => {});
      // utils/shell turns a timeout into `cmd "..." timed out (<ms> ms)`
      if (/timed out \(\d+ ms\)$/.test(e.message || "")) {
        throw Error(TIMED_OUT.message);
      }
      throw failed(firstLine(e));
    }
    const missing = lines(out).find(l => l.startsWith("MISSING "));
    if (missing) throw failed(missing);
    // The last two lines are `find | wc -l` and `du -sk /to`
    const fromEnd = lines(out).reverse();
    const sizeLine = fromEnd.find(l => /^\d+\s+\/to$/.test(l));
    const filesLine = fromEnd.find(l => /^\d+$/.test(l));
    files = filesLine ? parseInt(filesLine, 10) : 0;
    sizeKb = sizeLine ? parseInt(sizeLine, 10) : 0;
    const skippedMatch = lines(out)
      .map(l => l.match(/^SKIPPED (\d+) (\d+)$/))
      .find(Boolean);
    skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
    keyFilesSkipped = skippedMatch ? parseInt(skippedMatch[2], 10) > 0 : false;

    // Never offer this volume again; a failed write must not fail the
    // recovery, which has already happened
    try {
      await lostData.markRecovered(volume, id);
    } catch (e) {
      logs.error(`recoverLostData ${id}: cannot remember ${volume}: ${e.message}`);
    }
  } catch (e) {
    error = e;
  }

  log(`Starting ${title}`);
  let startError = null;
  try {
    await docker.safe.compose.up(dcPath);
  } catch (e) {
    logs.error(`recoverLostData ${id}: start failed: ${e.message}`);
    startError = Error(
      `${title} did not start. Open it in My DApps and press Start.`
    );
  }
  eventBus.emit(eventBusTag.emitPackages);

  if (error && startError) throw Error(`${error.message} ${startError.message}`);
  if (error) throw error;

  const message = `Recovered ${files} files into ${target} from ${volume}`;
  if (startError) throw Error(`${message}, but ${startError.message}`);
  return {
    message,
    logMessage: true,
    userAction: true,
    result: Object.assign(
      { files, sizeKb, skipped },
      skipped > 0 && keyFilesSkipped ? { warning: SKIPPED_WARNING } : {}
    )
  };
};

module.exports = recoverLostData;
module.exports.copyCommand = copyCommand;
