const { spawn } = require("child_process");
const getDappmanagerImage = require("utils/getDappmanagerImage");
const logs = require("logs.js")(module);

/**
 * The password of the box's login user (`avado`, the SSH user every AVADO
 * ships with, password `avado`).
 *
 * Same idea as DAppNode's passwordManager (dappnode/DNP_DAPPMANAGER, GPL-3.0):
 * a short-lived privileged container on the host does the work. Unlike there:
 * - the current password is checked against /etc/shadow before anything
 *   changes, so reaching the Admin is not enough to take over the login;
 * - "is the factory password still in use" is answered by checking the
 *   password `avado` against the hash, not by a known salt (AVADO boxes were
 *   not all made the same way);
 * - the passwords travel on the container's stdin only, never in an argument,
 *   an environment variable or a file, so they appear in no `ps`, no
 *   `docker inspect`, no docker event and no log.
 *
 * The container runs the DAPPMANAGER's own image (always on the box, no
 * pull), chroots into the host and runs the host's own perl (perl-base is
 * part of every Debian) and chpasswd, so the hash is made the way the host's
 * PAM settings say. perl reads the hash from /etc/shadow, checks a password
 * with the host's crypt() (SHA-512 and yescrypt alike), runs chpasswd with
 * "avado:<new>" on its stdin and checks the new hash afterwards. It prints a
 * single word and never a password or a hash.
 */

const USER = "avado";
const DEFAULT_PASSWORD = "avado";
const CONTAINER = "dappmanager-passwd-host";
let HOST_TIMEOUT = 30 * 1000;

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

// Wrong current passwords: each one waits before its answer, and after
// MAX_WRONG of them within WRONG_WINDOW_MS no try is accepted until the window
// has passed. The SSH login itself allows guessing too; this keeps the Admin
// from being a faster way.
let WRONG_DELAY_MS = 2000;
const MAX_WRONG = 5;
const WRONG_WINDOW_MS = 10 * 60 * 1000;

const MESSAGES = {
  noCurrent: "Type your current password.",
  wrong: "The current password is wrong.",
  tooManyWrong: "Too many wrong tries. Wait 10 minutes and try again.",
  noNew: "Type a new password.",
  tooShort: `The new password must have at least ${MIN_LENGTH} characters.`,
  tooLong: `The new password can have at most ${MAX_LENGTH} characters.`,
  isDefault: "Choose a password other than avado.",
  sameAsCurrent: "The new password must be different from the current one.",
  badCharacter: "The new password cannot contain line breaks or other control characters.",
  noUser: `This AVADO has no "${USER}" user, so its password cannot be changed here.`,
  failed: "Could not change the password. Nothing was changed. Try again; if it keeps failing, contact AVADO support.",
  busy: "The password is being changed already. Wait a moment and try again."
};

// Runs on the host (chroot). Mode in $ARGV[0]: "check" reads one line (the
// password to check); "change" reads two (current, new). Prints one word:
// NOUSER, WRONG, MATCH (check), CHANGED or FAIL (change).
const PERL_SCRIPT = `
use strict;
use warnings;
$ENV{PATH} = "/usr/sbin:/usr/bin:/sbin:/bin";
my $user = "${USER}";
my $mode = $ARGV[0] || "check";
sub line { my $l = <STDIN>; $l = "" unless defined $l; chomp $l; return $l; }
sub hash_of {
  open(my $f, "<", "/etc/shadow") or return undef;
  while (my $l = <$f>) {
    chomp $l;
    my @p = split(/:/, $l, -1);
    if (defined $p[0] && $p[0] eq $user) { close($f); return defined $p[1] ? $p[1] : ""; }
  }
  close($f);
  return undef;
}
sub matches {
  my ($pw, $h) = @_;
  return 0 unless defined $h && $h =~ /^\\$/;
  my $c = crypt($pw, $h);
  return (defined $c && $c eq $h) ? 1 : 0;
}
my $current = line();
my $new = $mode eq "change" ? line() : "";
my $h = hash_of();
if (!defined $h) { print "NOUSER\\n"; exit 0; }
if (!matches($current, $h)) { print "WRONG\\n"; exit 0; }
if ($mode ne "change") { print "MATCH\\n"; exit 0; }
my $ok = open(my $p, "|-", "chpasswd");
if (!$ok) { print "FAIL\\n"; exit 0; }
print $p "$user:$new\\n";
if (!close($p)) { print "FAIL\\n"; exit 0; }
print(matches($new, hash_of()) ? "CHANGED\\n" : "FAIL\\n");
`;

const hostArgs = (image, mode) => [
  "run",
  "--rm",
  "-i",
  "--name",
  CONTAINER,
  "--privileged",
  "--network",
  "none",
  "--log-driver",
  "none",
  "-v",
  "/:/host",
  "--entrypoint",
  "chroot",
  image,
  "/host",
  "/usr/bin/perl",
  "-e",
  PERL_SCRIPT,
  mode
];

/**
 * Runs `docker` with `input` on its stdin. Only the program's last stdout
 * word comes back; stderr is never kept (chpasswd's messages stay out of the
 * logs and the Admin).
 * @returns {Promise<{ code: number, word: string, conflict: boolean }>}
 */
function runDocker(args, input, { timeout = HOST_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(Error(`Could not start docker: ${e.message}`));
    }
    let out = "";
    let conflict = false;
    let done = false;
    child.stdout.on("data", chunk => {
      if (out.length < 4096) out += chunk.toString("utf8");
    });
    // Only whether a container of that name is left over; nothing else of
    // stderr is kept
    child.stderr.on("data", chunk => {
      if (/already in use/i.test(chunk.toString("utf8"))) conflict = true;
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      removeContainer();
      reject(Error(`The host did not answer within ${Math.round(timeout / 1000)} s`));
    }, timeout);
    child.on("error", e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Error(`Could not run docker: ${e.message}`));
    });
    child.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const words = out.trim().split(/\s+/);
      resolve({ code: code === null ? -1 : code, word: words[words.length - 1] || "", conflict });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function removeContainer() {
  return new Promise(resolve => {
    try {
      const child = spawn("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/**
 * One host run. `lines` are written to its stdin, one per line.
 * @returns {Promise<string>} NOUSER | WRONG | MATCH | CHANGED | FAIL
 */
async function runOnHost(mode, lines) {
  const image = await getDappmanagerImage();
  const input = lines.join("\n") + "\n";
  let res = await runDocker(hostArgs(image, mode), input);
  if (res.conflict) {
    // A container left by a DAPPMANAGER that died mid-run
    await removeContainer();
    res = await runDocker(hostArgs(image, mode), input);
  }
  if (res.code !== 0 || !/^(NOUSER|WRONG|MATCH|CHANGED|FAIL)$/.test(res.word)) {
    throw Error(`The password tool on the host failed (exit code ${res.code})`);
  }
  return res.word;
}

// One host run at a time: a change never overlaps a check or another change
let queue = Promise.resolve();
function serialized(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Control characters (line breaks, tabs, NUL, DEL): they would end the line
// on stdin, or cannot be typed at an SSH login
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The rules for a new password; the first one broken, as a plain sentence
 * @returns {string|null}
 */
function newPasswordProblem(newPassword, currentPassword) {
  if (typeof newPassword !== "string" || newPassword === "") return MESSAGES.noNew;
  if (newPassword.trim().toLowerCase() === DEFAULT_PASSWORD) return MESSAGES.isDefault;
  if (CONTROL.test(newPassword)) return MESSAGES.badCharacter;
  if ([...newPassword].length < MIN_LENGTH) return MESSAGES.tooShort;
  if ([...newPassword].length > MAX_LENGTH) return MESSAGES.tooLong;
  if (newPassword === currentPassword) return MESSAGES.sameAsCurrent;
  return null;
}

let wrongTries = [];
const recentWrong = now => (wrongTries = wrongTries.filter(t => now - t < WRONG_WINDOW_MS)).length;

// Cache of "the factory password is still in use": the check runs a
// container, and the Admin asks on every page load
const CHECK_CACHE_MS = 60 * 1000;
let cached = null; // { isDefault, at }
let checkInFlight = null;

/**
 * Changes the password of the `avado` user on the host, after checking the
 * current one there. Throws an Error with a plain sentence for the owner.
 */
async function changePassword({ currentPassword, newPassword }) {
  if (typeof currentPassword !== "string" || currentPassword === "") throw Error(MESSAGES.noCurrent);
  const problem = newPasswordProblem(newPassword, currentPassword);
  if (problem) throw Error(problem);
  // A current password with a line break cannot be the right one and would
  // shift the lines on stdin
  if (CONTROL.test(currentPassword) || currentPassword.length > 1024) {
    await sleep(WRONG_DELAY_MS);
    throw Error(MESSAGES.wrong);
  }
  if (recentWrong(Date.now()) >= MAX_WRONG) throw Error(MESSAGES.tooManyWrong);

  return serialized(async () => {
    if (recentWrong(Date.now()) >= MAX_WRONG) throw Error(MESSAGES.tooManyWrong);
    let word;
    try {
      word = await runOnHost("change", [currentPassword, newPassword]);
    } catch (e) {
      logs.error(`Box password change failed: ${e.message}`);
      throw Error(MESSAGES.failed);
    } finally {
      cached = null;
    }
    if (word === "WRONG") {
      wrongTries.push(Date.now());
      await sleep(WRONG_DELAY_MS);
      throw Error(MESSAGES.wrong);
    }
    if (word === "NOUSER") throw Error(MESSAGES.noUser);
    if (word !== "CHANGED") {
      logs.error(`Box password change failed: the host answered ${word}`);
      throw Error(MESSAGES.failed);
    }
    wrongTries = [];
    cached = { isDefault: false, at: Date.now() };
  });
}

/**
 * Whether the `avado` user still has the factory password `avado`.
 * @returns {Promise<boolean|null>} true / false; null when there is no
 *   `avado` user or the check could not run (logged once, as a warning)
 */
let warned = false;
function isDefaultPassword() {
  if (cached && Date.now() - cached.at < CHECK_CACHE_MS) return Promise.resolve(cached.isDefault);
  if (!checkInFlight) {
    checkInFlight = serialized(async () => {
      try {
        const word = await runOnHost("check", [DEFAULT_PASSWORD]);
        const isDefault = word === "MATCH" ? true : word === "WRONG" ? false : null;
        cached = { isDefault, at: Date.now() };
        return isDefault;
      } catch (e) {
        if (!warned) logs.warn(`Could not check whether the box password is the factory one: ${e.message}`);
        warned = true;
        return null;
      }
    }).finally(() => (checkInFlight = null));
  }
  return checkInFlight;
}

module.exports = {
  changePassword,
  isDefaultPassword,
  newPasswordProblem,
  MESSAGES,
  MIN_LENGTH,
  MAX_LENGTH,
  // Tests only
  PERL_SCRIPT,
  hostArgs,
  _setTimings({ wrongDelayMs, hostTimeout } = {}) {
    if (wrongDelayMs !== undefined) WRONG_DELAY_MS = wrongDelayMs;
    if (hostTimeout !== undefined) HOST_TIMEOUT = hostTimeout;
  },
  _reset() {
    wrongTries = [];
    cached = null;
    checkInFlight = null;
    warned = false;
    queue = Promise.resolve();
  }
};
