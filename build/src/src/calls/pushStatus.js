const push = require("modules/push");

/**
 * Whether this browser gets alerts (the box may have forgotten it, e.g.
 * after its push service dropped the subscription). Not a user action.
 *
 * @param {object} kwargs { endpoint } this browser's push endpoint, if any
 * @returns {object} result: { subscribed, devices }
 */
const pushStatus = async ({ endpoint } = {}) => ({
  message: "Push alerts status",
  result: {
    subscribed: Boolean(endpoint) && push.hasSubscription(String(endpoint)),
    devices: push.listSubscriptions().length
  }
});

module.exports = pushStatus;
