const ethUtil = require("ethereumjs-util");
const db = require("../db");

const actions = ["checkout", "portal"];
const plans = ["monthly", "yearly"];

/**
 * Signs a Priority Support billing request with this box's identity key, so
 * the billing backend can tell the request comes from the box that owns the
 * nodeid and not from someone who merely knows it.
 *
 * Only this fixed message layout is ever signed (as an EIP-191 personal
 * message, same scheme as utils/recoverSignature), so the call cannot be used
 * to sign arbitrary data. The backend builds the identical string, see
 * avado-priority-support-backend/src/utils/boxSignature.js
 *
 * @param {string} action "checkout" | "portal"
 * @param {string} plan "monthly" | "yearly", only for "checkout"
 * @param {number} timestamp unix seconds, the billing backend's serverTime.
 * The box's own clock is only a fallback, it is often wrong.
 * @returns {object} result = {
 *   nodeid: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23", {string}
 *   timestamp: 1790000000, {number}
 *   message: "avado-priority-support:v1\naction:...", {string}
 *   signature: "0xd61c45...", {string}
 * }
 */
const signPrioritySupportRequest = async ({ action, plan, timestamp }) => {
  if (!actions.includes(action))
    throw Error(`kwarg action must be one of: ${actions.join(", ")}`);
  if (action === "checkout" && !plans.includes(plan))
    throw Error(`kwarg plan must be one of: ${plans.join(", ")}`);
  if (timestamp === undefined) timestamp = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || timestamp < 0)
    throw Error("kwarg timestamp must be a positive integer (unix seconds)");

  const address = await db.get("address");
  const privateKey = await db.get("privateKey");
  if (!address || !privateKey) throw Error("This AVADO has no identity yet");

  const nodeid = address.toLowerCase();
  const message = [
    "avado-priority-support:v1",
    `action:${action}`,
    `nodeid:${nodeid}`,
    `plan:${action === "checkout" ? plan : ""}`,
    `ts:${timestamp}`
  ].join("\n");

  const msgHash = ethUtil.hashPersonalMessage(Buffer.from(message));
  const { v, r, s } = ethUtil.ecsign(
    msgHash,
    Buffer.from(privateKey.replace(/^0x/, ""), "hex")
  );

  // No logMessage / userAction: signatures do not belong in userActionLogs
  return {
    message: "Signed Priority Support request",
    result: {
      nodeid,
      timestamp,
      message,
      signature: ethUtil.toRpcSig(v, r, s)
    }
  };
};

module.exports = signPrioritySupportRequest;
