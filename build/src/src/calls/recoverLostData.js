const fs = require("fs");
const crypto = require("crypto");
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
 * Busybox script that copies the old volume (/from, read-only) into the live
 * one (/to). Nothing is ever deleted or overwritten:
 * - Entries are walked parents first (find -print0 / read -d "", so any file
 *   name works). An entry that exists in /to, or whose parent in /to is a
 *   symlink, is kept as it is; a regular file counts as skipped, and as a
 *   key file when its path contains wallet or password AND it differs from
 *   the old one (cmp -s; an identical file, e.g. from an earlier attempt,
 *   gives no warning).
 * - A missing folder is created with the owner and mode of the old one.
 * - Anything else is copied with cp -a to `<name><suffix>` in the same
 *   folder and then renamed into place with mv -n, so an interrupted copy
 *   never leaves half a file under the real name. The suffix is random per
 *   run (`.avado-recover-tmp-<8 hex>`), so it never collides with a real
 *   entry or a leftover of an earlier run; if `<name><suffix>` exists
 *   anyway the entry fails. mv -n returns 0 when the target exists, so the
 *   temporary name must be gone afterwards.
 * - A failure is counted and the walk goes on.
 * - The number of regular files walked must equal an independent count
 *   (`find -type f -print0 | tr | wc -c`): busybox before 1.32 cannot read
 *   NUL-separated names and would otherwise walk nothing and report success.
 * Output: FILES <regular files walked>, SKIPPED <n> <key files>, then on
 * failure `FAILED walk <walked>/<found>` or `FAILED <n> <first path>` with
 * exit 1; on success du -sk /to.
 * The script holds no single quote: it runs inside sh -c '...'.
 * (busybox cp -n skips an existing folder as a whole, so `cp -an /from/. /to/`
 * copies nothing into an existing volume root.)
 * Known limit: the temporary name is 27 characters longer, so a file name
 * longer than 228 characters cannot be copied (it fails, nothing else).
 */
const TMP_SUFFIX_REGEX = /^\.avado-recover-tmp-[0-9a-f]{8}$/;
const newTmpSuffix = () =>
  `.avado-recover-tmp-${crypto.randomBytes(4).toString("hex")}`;

const copyScript = suffix => {
  if (!TMP_SUFFIX_REGEX.test(suffix)) throw Error("unexpected suffix");
  return [
    "cd /from || exit 1",
    'found=$(find . -type f -print0 | tr -cd "\\000" | wc -c)',
    '[ "$found" -ge 0 ] || exit 1',
    "find . -mindepth 1 -print0 | {",
    '  files=0; copied=0; skipped=0; key=0; failed=0; first=""',
    '  while IFS= read -r -d "" f; do',
    "    isfile=0",
    '    if [ -f "$f" ] && [ ! -L "$f" ]; then isfile=1; files=$((files+1)); fi',
    "    keep=0; linked=0",
    '    if [ -e "/to/$f" ] || [ -L "/to/$f" ]; then keep=1; fi',
    '    p="${f%/*}"',
    '    while [ "$keep" = 0 ] && [ "$p" != "." ] && [ -n "$p" ]; do',
    '      if [ -L "/to/$p" ]; then keep=1; linked=1; fi',
    '      q="${p%/*}"; [ "$q" = "$p" ] && break; p="$q"',
    "    done",
    '    if [ "$keep" = 1 ]; then',
    '      if [ "$isfile" = 1 ]; then',
    "        skipped=$((skipped+1))",
    '        if [ "$linked" = 1 ] || ! cmp -s "$f" "/to/$f"; then',
    '          case "$f" in *[Ww][Aa][Ll][Ll][Ee][Tt]*|*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) key=$((key+1));; esac',
    "        fi",
    "      fi",
    "      continue",
    "    fi",
    '    if [ -d "$f" ] && [ ! -L "$f" ]; then',
    '      mkdir "/to/$f" && chown "$(stat -c %u:%g "$f")" "/to/$f" && chmod "$(stat -c %a "$f")" "/to/$f"',
    "    else",
    `      t="/to/$f${suffix}"`,
    '      if [ -e "$t" ] || [ -L "$t" ]; then false; else cp -af "$f" "$t" && mv -n "$t" "/to/$f" && [ ! -e "$t" ] && [ ! -L "$t" ]; fi',
    "    fi",
    '    if [ $? != 0 ]; then failed=$((failed+1)); [ -n "$first" ] || first="$f"; elif [ "$isfile" = 1 ]; then copied=$((copied+1)); fi',
    "  done",
    '  echo "FILES $files"',
    '  echo "SKIPPED $skipped $key"',
    '  if [ "$files" -ne "$found" ]; then echo "FAILED walk $files/$found"; exit 1; fi',
    '  if [ "$failed" != 0 ]; then echo "FAILED $failed $first"; exit 1; fi',
    '  if [ "$found" -gt 0 ] && [ $((copied+skipped)) = 0 ]; then echo "FAILED walk 0/$found"; exit 1; fi',
    "} && du -sk /to"
  ].join("\n");
};

const copyCommand = (name, volume, target, suffix) =>
  `docker run --rm --name ${name} -v ${volume}:/from:ro -v ${target}:/to busybox sh -c '${copyScript(suffix)}'`;

const lines = s =>
  String(s || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

const parseFailed = out => {
  const walk = lines(out)
    .map(l => l.match(/^FAILED walk (\d+)\/(\d+)$/))
    .find(Boolean);
  if (walk) {
    return `only ${walk[1]} of the ${walk[2]} files in the old storage could be read`;
  }
  const m = lines(out)
    .map(l => l.match(/^FAILED (\d+) (.*)$/))
    .find(Boolean);
  return m
    ? `${m[1]} file${m[1] === "1" ? "" : "s"} could not be copied (first: ${m[2]})`
    : null;
};

/**
 * First useful line of a failed copy, without the command itself
 */
function firstLine(e) {
  const failedLine = parseFailed(e.stdout);
  if (failedLine) return failedLine;
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

// Packages with a recovery running in this process
const running = new Set();

/**
 * Copies a package's data from an unused volume found by findLostData into
 * the package's live volume. Nothing is ever deleted: files that already
 * exist in the live volume are kept as they are. The package is always
 * started again afterwards, also when it was stopped before the call.
 *
 * @param {string} id DNP .eth name
 * @param {string} volume name of a candidate returned by findLostData
 */
const recoverLostData = async ({ id, volume } = {}) => {
  if (!id) throw Error("kwarg id must be defined");
  if (!volume || typeof volume !== "string") {
    throw Error("kwarg volume must be defined");
  }
  if (running.has(id)) {
    throw Error("A recovery for this app is already running.");
  }
  running.add(id);
  try {
    return await recover({ id, volume });
  } finally {
    running.delete(id);
  }
};

async function recover({ id, volume }) {
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
      out = await shell(copyCommand(name, candidate.name, target, newTmpSuffix()), {
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
    const failedLine = parseFailed(out);
    if (failedLine) throw failed(failedLine);
    if (!/^FILES \d+$/m.test(out)) {
      throw failed("the copy did not report what it copied");
    }
    const outLines = lines(out);
    const sizeLine = outLines.find(l => /^\d+\s+\/to$/.test(l));
    const filesMatch = outLines.map(l => l.match(/^FILES (\d+)$/)).find(Boolean);
    files = filesMatch ? parseInt(filesMatch[1], 10) : 0;
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

  const copied = Math.max(files - skipped, 0);
  const message = `Recovered ${copied} files into ${target} from ${volume}`;
  if (startError) throw Error(`${message}, but ${startError.message}`);
  return {
    message,
    logMessage: true,
    userAction: true,
    result: Object.assign(
      { files, copied, skipped, sizeKb },
      skipped > 0 && keyFilesSkipped ? { warning: SKIPPED_WARNING } : {}
    )
  };
}

module.exports = recoverLostData;
module.exports.copyCommand = copyCommand;
module.exports.copyScript = copyScript;
