const push = require("modules/push");

/**
 * Turns push alerts off for one browser or phone.
 *
 * @param {object} kwargs { endpoint } the browser's push endpoint
 * @returns {object} result: { removed } 1 or 0
 */
const pushUnsubscribe = async ({ endpoint } = {}) => {
  const removed = push.removeSubscription(String(endpoint || ""));
  return {
    message: removed ? "Alerts turned off for a device" : "Alerts were not on for this device",
    result: { removed },
    logMessage: true,
    userAction: true
  };
};

module.exports = pushUnsubscribe;
