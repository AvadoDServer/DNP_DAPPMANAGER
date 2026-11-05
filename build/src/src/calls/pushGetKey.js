const push = require("modules/push");

/**
 * The box's public VAPID key for push alerts (made on first use). The Admin
 * hands it to the browser when the owner turns alerts on. Not a user action.
 *
 * @returns {object} result: { publicKey } (base64url)
 */
const pushGetKey = async () => ({
  message: "Push alerts key",
  result: { publicKey: push.getPublicKey() }
});

module.exports = pushGetKey;
