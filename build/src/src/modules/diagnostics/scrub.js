/**
 * Removes secrets from text before it leaves the box: every log line,
 * supervisor description and settings value getDiagnostics returns goes
 * through here.
 *
 * - hex strings of 64+ characters (keys, JWT secrets, hashes): first 6
 *   characters + "…". Addresses (0x + 40 hex) are shorter and stay.
 * - password=…, token: …, "secret": "…", private_key=… and the like:
 *   name=<redacted>
 * - Bearer <token>: Bearer <redacted>
 * - URL userinfo, https://user:pass@host: https://<redacted>@host
 * - secrets in a URL: ?key=…, &token=…, /apikey/… become key=<redacted>; a
 *   long random path segment (24+ letters and digits, an Infura-style key)
 *   becomes <redacted>
 * - 12 to 24 lowercase words of 3 to 8 letters in a row (a mnemonic):
 *   <12+ words redacted>, on a line whose message (after a docker timestamp,
 *   a time and a log level) is nothing but letters and spaces (an ordinary
 *   log sentence has a digit, a colon or a full stop), or on any line that
 *   names a mnemonic/seed/phrase/recovery
 */

const LONG_HEX = /[0-9a-fA-F]{64,}/g;
const USERINFO = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g;
const BEARER = /\bBearer\s+\S+/gi;
// The name may be followed by a closing quote, as in JSON: "password": "x"
// A value already redacted ("<12+ words redacted>") is left as it is
const KEY_VALUE = /(password|passphrase|token|secret|mnemonic|seed|jwt|apikey|api_key|private[_-]?key)["']?\s*[=:]\s*(?!<)\S+/gi;
const URL_PARAM = /([?&/])(key|token|apikey|api_key|secret|password)[=/][^&\s/]+/gi;
const URL = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const RANDOM_SEGMENT = /\/([A-Za-z0-9_-]{24,})(?=[/?#]|$)/g;
// BIP39 words are 3 to 8 letters; a mnemonic has 12 to 24 of them
const WORD_RUN = /\b[a-z]{3,8}(?:[ \t]+[a-z]{3,8}){11,23}\b/g;
const WORD_RUN_LOOSE = /\b[a-z]{3,8}(?:[\s,"']+[a-z]{3,8}){11,23}\b/g;
const ONLY_WORDS = /^[A-Za-z \t]*$/;
const MNEMONIC_HINT = /mnemonic|seed|phrase|recovery/i;
// What a log line starts with before its message: docker's --timestamps
// (2026-10-14T11:45:13.123456789Z), an application time (11:45:13.123) and a
// level (INFO, [WARN], ERROR -, …)
const LINE_PREFIX = /^\s*(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?\s+)?(?:\d\d:\d\d:\d\d(?:[.,]\d+)?\s+)?(?:[[-]?\s*(?:INFO|WARN|WARNING|ERROR|DEBUG|FATAL|TRACE)\s*[\]-]?\s+(?:-\s+)?)?/i;

function scrubMnemonics(text) {
  return text
    .split("\n")
    .map(line => {
      if (MNEMONIC_HINT.test(line)) return line.replace(WORD_RUN_LOOSE, "<12+ words redacted>");
      // The message itself must be nothing but letters and spaces
      const prefix = (line.match(LINE_PREFIX) || [""])[0];
      const message = line.slice(prefix.length);
      if (ONLY_WORDS.test(message)) return prefix + message.replace(WORD_RUN, "<12+ words redacted>");
      return line;
    })
    .join("\n");
}

const scrubUrl = url =>
  url
    .replace(URL_PARAM, "$1$2=<redacted>")
    .replace(RANDOM_SEGMENT, (m, seg) => (/\d/.test(seg) && /[A-Za-z]/.test(seg) ? "/<redacted>" : m));

function scrub(text) {
  if (typeof text !== "string" || !text) return text;
  return scrubMnemonics(
    text
      .replace(LONG_HEX, m => `${m.slice(0, 6)}…`)
      .replace(USERINFO, "$1<redacted>@")
      .replace(URL, scrubUrl)
      .replace(BEARER, "Bearer <redacted>")
  ).replace(KEY_VALUE, "$1=<redacted>");
}

const SECRET_KEY = /password|passphrase|token|secret|mnemonic|seed|private/i;

/**
 * A package's settings without secrets: keys that name a secret are removed
 * (at any depth), every string value is scrubbed
 */
function scrubSettings(value) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubSettings);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrubSettings(value[key]);
    }
    return out;
  }
  return value;
}

module.exports = { scrub, scrubSettings };
