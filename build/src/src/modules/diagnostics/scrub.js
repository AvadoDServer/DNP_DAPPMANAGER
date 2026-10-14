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
 * - 12 or more short lowercase words in a row (a mnemonic): <12+ words redacted>
 */

const LONG_HEX = /[0-9a-fA-F]{64,}/g;
const USERINFO = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g;
const BEARER = /\bBearer\s+\S+/gi;
// The name may be followed by a closing quote, as in JSON: "password": "x"
const KEY_VALUE = /(password|passphrase|token|secret|mnemonic|seed|jwt|apikey|api_key|private[_-]?key)["']?\s*[=:]\s*\S+/gi;
// BIP39 words are 3 to 8 letters
const MNEMONIC = /\b[a-z]{3,8}(?:\s+[a-z]{3,8}){11,}\b/g;

function scrub(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(LONG_HEX, m => `${m.slice(0, 6)}…`)
    .replace(USERINFO, "$1<redacted>@")
    .replace(BEARER, "Bearer <redacted>")
    .replace(KEY_VALUE, "$1=<redacted>")
    .replace(MNEMONIC, "<12+ words redacted>");
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
