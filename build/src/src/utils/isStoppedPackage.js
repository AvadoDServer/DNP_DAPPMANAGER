"use strict";

// Docker runs a container in these states, or brings it back by itself:
// `restarting` is a crashed process waiting for its restart policy (a crash
// loop, which alternates between `restarting` and `running`).
const ACTIVE_STATES = ["running", "restarting"];

/**
 * True when an unattended update must leave this package alone because it is
 * stopped.
 *
 * An update ends with `docker-compose up`, which starts the container again.
 * The Admin's Pause is `docker-compose stop`, so without this check a
 * validator the user stopped to move its keys to another machine would be
 * started at its next update and sign on both machines: slashing.
 *
 * Only `running` and `restarting` packages get updated, so a crash-looping app
 * still receives its fix. Every other state (`exited`, `created`, `paused`,
 * `dead`, `removing`, or none) means Docker is not running the container and
 * will not start it by itself; its update waits for the user in the Admin.
 * A container that crashed and stayed down is `exited` too, and its exit code
 * does not tell it apart from a user stop, so it waits as well.
 *
 * Core packages are never skipped: the system depends on them.
 *
 * @param {object} dnp an entry of listPackages / dockerList.listContainers,
 *   with `state` (Docker's container state) and `isCore`
 * @returns {bool}
 */
function isStoppedPackage(dnp) {
  if (!dnp || dnp.isCore) return false;
  return !ACTIVE_STATES.includes(dnp.state);
}

module.exports = isStoppedPackage;
