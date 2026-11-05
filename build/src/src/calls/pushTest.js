const push = require("modules/push");

/**
 * Sends a test alert to one browser or phone (the one pressing the button).
 * Fails with a plain sentence when it could not be delivered.
 *
 * @param {object} kwargs { endpoint } that browser's push endpoint
 */
const TEST_ALERT = {
  title: "Test alert from your AVADO",
  body: "Alerts work. You get one here when something on your AVADO needs you.",
  url: "/dashboard",
  tag: "test-alert"
};

const pushTest = async ({ endpoint } = {}) => {
  const sub = push.listSubscriptions().find(s => s.endpoint === String(endpoint || ""));
  if (!sub) throw Error("Alerts are not on for this device. Turn them on first.");
  const r = await push.sendTo(sub, TEST_ALERT, { ttl: 10 * 60 });
  if (r.ok) return { message: "Test alert sent", logMessage: true };
  if (r.gone) throw Error("This device's alerts have expired. Turn alerts off and on again.");
  if (r.status) throw Error(`The phone's alert service refused the test alert (error ${r.status}). Turn alerts off and on again.`);
  throw Error("Your AVADO could not reach the phone's alert service. Check that your AVADO is online and try again.");
};

pushTest.TEST_ALERT = TEST_ALERT;
module.exports = pushTest;
