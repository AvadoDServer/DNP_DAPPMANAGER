const push = require("modules/push");

/**
 * Turns push alerts on for one browser or phone.
 *
 * @param {object} kwargs { subscription: the browser's PushSubscription
 *   (toJSON(): { endpoint, keys: { p256dh, auth } }), name: "iPhone" }
 *   The endpoint and keys never reach a log (utils/logSafeObjects).
 * @returns {object} result: { devices } how many devices get alerts now
 */
const pushSubscribe = async ({ subscription, name } = {}) => {
  const devices = push.addSubscription(subscription, name);
  return {
    message: "Alerts turned on for a device",
    result: { devices },
    logMessage: true,
    userAction: true
  };
};

module.exports = pushSubscribe;
