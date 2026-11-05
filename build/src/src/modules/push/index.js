"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");
const params = require("params");
const logs = require("logs.js")(module);

/**
 * Push alerts to the owner's phones (standard Web Push, RFC 8030 + VAPID
 * RFC 8292). No AVADO server and no paid service is involved:
 *
 * - The VAPID key pair is made on the box the first time it is needed and
 *   stays in DNCORE/push/vapid.json (readable by root only). The public key
 *   goes to the Admin, which gives it to the browser when the owner turns
 *   alerts on; the browser answers with a subscription (an https endpoint at
 *   its own push service: Google FCM for Chrome/Android, Apple for Safari and
 *   iPhone home-screen apps, Mozilla for Firefox).
 * - To alert, the box POSTs the encrypted message to that endpoint, signed
 *   with its private key. The push service delivers it to the phone wherever
 *   it is, so the phone never has to reach the box. Those push services are
 *   free and are what every browser uses for web push.
 *
 * The same route as DAppNode's notifications (dappnode/DNP_DAPPMANAGER
 * admin-ui sw.js + notifier: VAPID key on the box, browser push service).
 *
 * Subscriptions live in DNCORE/push/subscriptions.json. A push service that
 * answers 404 or 410 has dropped the subscription (the browser unsubscribed,
 * the app was removed), so it is removed here too.
 */

// Shown to the push services as the sender's contact (RFC 8292 "sub")
const SUBJECT = "https://ava.do";
const MAX_SUBSCRIPTIONS = 20;
const SEND_TIMEOUT_MS = 15 * 1000;
// A phone that is off for a day still gets the alert when it comes back
const DEFAULT_TTL_S = 24 * 60 * 60;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

let dir = path.join(params.DNCORE_DIR, "push");

function file(name) {
  return path.join(dir, name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") logs.warn(`Push alerts: could not read ${name}: ${e.message}`);
    return fallback;
  }
}

/** Written to a temp file first, so a power cut never leaves half a file */
function writeJson(name, value) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file(name)}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(name));
}

/* ---------------- VAPID keys ---------------- */

let vapidCache = null;

function isVapid(v) {
  return Boolean(v && typeof v.publicKey === "string" && typeof v.privateKey === "string" && BASE64URL.test(v.publicKey) && BASE64URL.test(v.privateKey));
}

/** The box's VAPID key pair, made and saved on first use */
function getVapidKeys() {
  if (vapidCache) return vapidCache;
  const saved = readJson("vapid.json", null);
  if (isVapid(saved)) {
    vapidCache = saved;
    return vapidCache;
  }
  const keys = webpush.generateVAPIDKeys();
  const value = { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() };
  writeJson("vapid.json", value);
  logs.info("Push alerts: made a new VAPID key pair for this box");
  vapidCache = value;
  return vapidCache;
}

function getPublicKey() {
  return getVapidKeys().publicKey;
}

/* ---------------- subscriptions ---------------- */

function listSubscriptions() {
  const list = readJson("subscriptions.json", []);
  return Array.isArray(list) ? list.filter(s => s && typeof s.endpoint === "string") : [];
}

function saveSubscriptions(list) {
  writeJson("subscriptions.json", list);
}

/**
 * Checks a browser PushSubscription (its toJSON()) and returns the parts the
 * box keeps. Throws a plain sentence when it is not one.
 */
function cleanSubscription(subscription) {
  const s = subscription || {};
  let url;
  try {
    url = new URL(String(s.endpoint || ""));
  } catch (e) {
    throw Error("This browser sent no valid push address. Reload the page and try again.");
  }
  if (url.protocol !== "https:") throw Error("This browser sent no valid push address. Reload the page and try again.");
  const keys = s.keys || {};
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || !BASE64URL.test(keys.p256dh) || !BASE64URL.test(keys.auth))
    throw Error("This browser sent no valid push keys. Reload the page and try again.");
  return { endpoint: url.toString(), keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** A short plain name for the list (never shown to anyone outside the box) */
function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const n = String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60);
  return n || "Phone";
}

/** Adds or replaces (same endpoint) a subscription. Returns the number kept. */
function addSubscription(subscription, name) {
  const clean = cleanSubscription(subscription);
  const list = listSubscriptions().filter(s => s.endpoint !== clean.endpoint);
  if (list.length >= MAX_SUBSCRIPTIONS)
    throw Error(`Alerts are already on for ${MAX_SUBSCRIPTIONS} devices. Turn them off on a device you no longer use first.`);
  list.push({ ...clean, name: cleanName(name), addedAt: new Date().toISOString(), lastOkAt: null, lastError: null });
  saveSubscriptions(list);
  return list.length;
}

function removeSubscription(endpoint) {
  const list = listSubscriptions();
  const kept = list.filter(s => s.endpoint !== endpoint);
  if (kept.length !== list.length) saveSubscriptions(kept);
  return list.length - kept.length;
}

function hasSubscription(endpoint) {
  return listSubscriptions().some(s => s.endpoint === endpoint);
}

function updateSubscription(endpoint, fields) {
  const list = listSubscriptions();
  const i = list.findIndex(s => s.endpoint === endpoint);
  if (i < 0) return;
  list[i] = { ...list[i], ...fields };
  saveSubscriptions(list);
}

/* ---------------- sending ---------------- */

// Push services accept a "Topic" of up to 32 URL-safe characters: a newer
// message with the same topic replaces one still waiting for the phone
function topicFor(id) {
  return crypto.createHash("sha256").update(String(id)).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

let sendImpl = (sub, body, options) => webpush.sendNotification(sub, body, options);

/**
 * Sends one message to one subscription.
 * @param {object} payload { title, body, url, tag } (read by the Admin's sw.js)
 * @returns {object} { ok, status, gone }
 */
async function sendTo(sub, payload, { ttl = DEFAULT_TTL_S, urgency = "high" } = {}) {
  const vapid = getVapidKeys();
  const options = {
    TTL: ttl,
    urgency,
    timeout: SEND_TIMEOUT_MS,
    vapidDetails: { subject: SUBJECT, publicKey: vapid.publicKey, privateKey: vapid.privateKey }
  };
  if (payload && payload.tag) options.topic = topicFor(payload.tag);
  try {
    const res = await sendImpl({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), options);
    updateSubscription(sub.endpoint, { lastOkAt: new Date().toISOString(), lastError: null });
    return { ok: true, status: (res && res.statusCode) || 201, gone: false };
  } catch (e) {
    const status = e && Number.isFinite(e.statusCode) ? e.statusCode : null;
    const gone = status === 404 || status === 410;
    const host = (() => {
      try {
        return new URL(sub.endpoint).host;
      } catch (err) {
        return "?";
      }
    })();
    // Never log the endpoint itself: it is the address of the owner's phone
    logs.warn(`Push alerts: ${host} refused the message${status ? ` (${status})` : ""}: ${String((e && e.message) || e).slice(0, 200)}`);
    if (gone) removeSubscription(sub.endpoint);
    else updateSubscription(sub.endpoint, { lastError: status ? `HTTP ${status}` : "not reachable" });
    return { ok: false, status, gone };
  }
}

/** Sends to every subscription. Returns { sent, failed } */
async function sendToAll(payload, options) {
  let sent = 0;
  let failed = 0;
  for (const sub of listSubscriptions()) {
    const r = await sendTo(sub, payload, options);
    if (r.ok) sent++;
    else failed++;
  }
  return { sent, failed };
}

// Tests only
function _setDir(d) {
  dir = d;
  vapidCache = null;
}
function _setSendImpl(fn) {
  sendImpl = fn;
}

module.exports = {
  SUBJECT,
  MAX_SUBSCRIPTIONS,
  getVapidKeys,
  getPublicKey,
  listSubscriptions,
  addSubscription,
  removeSubscription,
  hasSubscription,
  cleanSubscription,
  sendTo,
  sendToAll,
  topicFor,
  readJson,
  writeJson,
  _setDir,
  _setSendImpl
};
