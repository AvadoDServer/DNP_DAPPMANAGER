"use strict";
const { spawn } = require("child_process");
const readline = require("readline");
const logs = require("logs.js")(module);
const dns = require("modules/dns");

/**
 * Keeps the package names in the box's DNS in line with the containers
 * (see modules/dns):
 * - at start: removes the names of packages that are no longer installed
 *   (after 10 s, then again after 1 and 5 minutes, because on a core update
 *   the bind may be recreated after the DAPPMANAGER)
 * - on docker events: a package container that starts, stops or goes away,
 *   or joins / leaves the box network, gets its name updated within about a
 *   second instead of at the next cron run (up to a minute)
 * - when the bind starts again (its entrypoint empties the zones): all
 *   names are written again after 5 s
 * - every 10 minutes, in case an event was missed
 */

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 3000;
const START_DELAYS_MS = [10 * 1000, 60 * 1000, 5 * 60 * 1000];
const INTERVAL_MS = 10 * 60 * 1000;
const BIND_START_DELAYS_MS = [5 * 1000, 30 * 1000];
const EVENTS_RESTART_MS = 10 * 1000;

let debounceTimer = null;
let firstEventAt = 0;

function runSync(reason) {
  dns.sync().catch(e => logs.warn(`DNS sync (${reason}) failed: ${e.message}`));
}

/** Coalesces a burst of events (stop, rm, create, start) into one pass */
function scheduleSync() {
  const now = Date.now();
  if (!debounceTimer) firstEventAt = now;
  clearTimeout(debounceTimer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstEventAt + MAX_WAIT_MS - now));
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSync("docker event");
  }, wait);
}

/**
 * What to do with one line of `docker events --format '{{json .}}'`
 * @param {string} line
 * @returns {"package"|"bind"|null}
 */
function classifyEvent(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch (e) {
    return null;
  }
  const type = ev.Type || ev.type;
  const action = ev.Action || ev.status || "";
  const attrs = (ev.Actor && ev.Actor.Attributes) || {};
  if (type === "container") {
    const name = attrs.name || "";
    if (name === dns.BIND_CONTAINER && action === "start") return "bind";
    if (dns.isPackageContainer(name)) return "package";
    return null;
  }
  if (type === "network") {
    // attrs.name is the network; the container is only an id here
    if (attrs.name === dns.NETWORK) return "package";
  }
  return null;
}

function onEvent(line) {
  const kind = classifyEvent(line);
  if (kind === "package") scheduleSync();
  else if (kind === "bind")
    for (const ms of BIND_START_DELAYS_MS) setTimeout(() => runSync("bind started"), ms);
}

function watchEvents() {
  const args = [
    "events",
    "--format",
    "{{json .}}",
    "--filter",
    "type=container",
    "--filter",
    "type=network",
    "--filter",
    "event=start",
    "--filter",
    "event=die",
    "--filter",
    "event=destroy",
    "--filter",
    "event=connect",
    "--filter",
    "event=disconnect"
  ];
  let child;
  try {
    child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    logs.warn(`DNS: cannot watch docker events: ${e.message}`);
    setTimeout(watchEvents, EVENTS_RESTART_MS);
    return;
  }
  readline.createInterface({ input: child.stdout }).on("line", onEvent);
  child.on("error", e => logs.warn(`DNS: docker events: ${e.message}`));
  child.on("close", () => {
    // Events may have been missed while it was down: one full pass after
    setTimeout(() => {
      watchEvents();
      runSync("events watcher restarted");
    }, EVENTS_RESTART_MS);
  });
}

function start() {
  watchEvents();
  for (const ms of START_DELAYS_MS) setTimeout(() => runSync("start"), ms);
  setInterval(() => runSync("interval"), INTERVAL_MS);
}

if (!process.env.TEST) start();

module.exports = { classifyEvent, scheduleSync };
