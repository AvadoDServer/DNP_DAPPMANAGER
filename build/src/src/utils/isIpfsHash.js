const { isIPFS } = require("ipfs-http-client");

function isMultihash(hash) {
  return isIPFS.cid(hash);
}

/**
 * Checks if the given string is a valid IPFS CID or path
 *
 * isIPFS.cid('QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o') // true (CIDv0)
 * isIPFS.cid('zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7') // true (CIDv1)
 * isIPFS.cid('noop') // false
 *
 * @param {string} hash
 * @returns {bool}
 */
function isIpfsHash(hash) {
  if (!hash || typeof hash !== "string") return false;
  // Correct hash prefix
  if (hash.includes("ipfs/")) {
    hash = hash.split("ipfs/")[1];
  }
  hash.replace("/", "");
  // Make sure hash if valid
  return isMultihash(hash);
}

module.exports = isIpfsHash;
