const ethUtil = require("ethereumjs-util");
const db = require("../db");

const billingActions = ["checkout", "portal"];
// Priority Care actions: the box signs its own periodic health check-in and
// settings requests the same way it signs billing requests, so the backend
// can tell they come from the box that owns the nodeid. "Let AVADO in"
// remote help is out of scope for now; not among careActions.
const careActions = ["care-heartbeat", "care-settings"];
const actions = [...billingActions, ...careActions];
const plans = ["monthly", "yearly"];
// sha256 hex digest: 32 bytes as 64 lowercase hex characters.
const payloadHashRegex = /^[0-9a-f]{64}$/;
const maxClockSkewSec = 10 * 60;

/**
 * Signs a Priority Support / Priority Care request with this box's identity
 * key, so the billing backend can tell the request comes from the box that
 * owns the nodeid and not from someone who merely knows it.
 *
 * Only this fixed message layout is ever signed (as an EIP-191 personal
 * message, same scheme as utils/recoverSignature), so the call cannot be used
 * to sign arbitrary data. The backend builds the identical string, see
 * avado-priority-support-backend/src/utils/boxSignature.js
 *
 * For "checkout" and "portal" the signed message and its validation are
 * unchanged from before Priority Care: a caller-supplied timestamp (the
 * billing backend's serverTime; the box's own clock is only a fallback, it
 * is often wrong) with no plausibility check against the box clock, and
 * `result` carries the raw signed `message` string.
 *
 * For the new "care-heartbeat" / "care-settings" actions, `plan` is omitted
 * (the message carries an empty `plan:` line, like "portal" does today) and
 * a `payloadHash` kwarg is required: the sha256 hex digest of the exact
 * payload string the caller will send to the backend, bound into the signed
 * message as a `payload:<payloadHash>` line so the signature also commits to
 * that payload. The timestamp must additionally be within 10 minutes of this
 * box's own clock, since these requests are not routed through the billing
 * backend's serverTime. `result` does not repeat the raw message (the
 * backend reconstructs it from `action`, the recovered nodeid, `timestamp`
 * and `payloadHash`); it carries `action` and `payloadHash` instead so the
 * caller can pair them with the request it is about to send.
 *
 * @param {string} action "checkout" | "portal" | "care-heartbeat" | "care-settings"
 * @param {string} plan "monthly" | "yearly", only for "checkout"
 * @param {number} timestamp unix seconds
 * @param {string} payloadHash sha256 hex digest of the payload, only for
 * "care-heartbeat" / "care-settings"
 * @returns {object} result = {
 *   nodeid: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23", {string}
 *   timestamp: 1790000000, {number}
 *   message: "avado-priority-support:v1\naction:...", {string} // billing actions only
 *   action: "care-heartbeat", {string} // care actions only
 *   payloadHash: "9f86d0...", {string} // care actions only
 *   signature: "0xd61c45...", {string}
 * }
 */
const signPrioritySupportRequest = async ({
  action,
  plan,
  timestamp,
  payloadHash
}) => {
  if (!actions.includes(action))
    throw Error(`kwarg action must be one of: ${actions.join(", ")}`);
  const isCareAction = careActions.includes(action);

  if (action === "checkout" && !plans.includes(plan))
    throw Error(`kwarg plan must be one of: ${plans.join(", ")}`);

  if (isCareAction && !payloadHashRegex.test(payloadHash || ""))
    throw Error(
      "kwarg payloadHash must be 64 lowercase hex characters (the sha256 of the payload)"
    );

  if (timestamp === undefined) timestamp = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || timestamp < 0)
    throw Error("kwarg timestamp must be a positive integer (unix seconds)");

  if (isCareAction) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(timestamp - now) > maxClockSkewSec)
      throw Error(
        "kwarg timestamp must be within 10 minutes of this box's clock"
      );
  }

  const address = await db.get("address");
  const privateKey = await db.get("privateKey");
  if (!address || !privateKey) throw Error("This AVADO has no identity yet");

  const nodeid = address.toLowerCase();
  const messageLines = [
    "avado-priority-support:v1",
    `action:${action}`,
    `nodeid:${nodeid}`,
    `plan:${action === "checkout" ? plan : ""}`,
    `ts:${timestamp}`
  ];
  if (isCareAction) messageLines.push(`payload:${payloadHash}`);
  const message = messageLines.join("\n");

  const msgHash = ethUtil.hashPersonalMessage(Buffer.from(message));
  const { v, r, s } = ethUtil.ecsign(
    msgHash,
    Buffer.from(privateKey.replace(/^0x/, ""), "hex")
  );
  const signature = ethUtil.toRpcSig(v, r, s);

  // No logMessage / userAction: signatures do not belong in userActionLogs
  return {
    message: "Signed Priority Support request",
    result: isCareAction
      ? { nodeid, timestamp, action, payloadHash, signature }
      : { nodeid, timestamp, message, signature }
  };
};

module.exports = signPrioritySupportRequest;
