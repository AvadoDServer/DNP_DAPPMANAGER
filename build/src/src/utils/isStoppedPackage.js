"use strict";

const params = require("params");

// Docker runs a container in these states, or is about to:
// - `restarting`: a crashed process waiting for its restart policy (a crash
//   loop alternates between `restarting` and `running`)
const ACTIVE_STATES = ["running", "restarting"];

/**
 * True when the user stopped this package: an install or update must not
 * start it (installPackage keeps it stopped, the auto-updater skips it).
 *
 * An update ends with `docker-compose up`, which starts the container again.
 * The Admin's Pause is `docker-compose stop`, so without this check a
 * validator the user stopped to move its keys to another machine would be
 * started at its next update and sign on both machines: slashing.
 *
 * Decided per package, over every container listed under its name.
 * docker-compose 1.x renames the old container to `<id>_DAppNodePackage-<name>`
 * while it recreates it, and leaves it behind, exited, when the new container
 * fails. The installer stopped that one, not the user. So a package is stopped
 * only when its own container `DAppNodePackage-<name>` exists and none of its
 * containers is running, restarting or created by a failed start. A
 * crash-looping app still receives its fix.
 *
 * `created` is a container that was made but never started. Docker records
 * why a start failed (dockerList's `startFailed`): that is an update whose new
 * container failed to start (a port clash, a bad entrypoint). Docker never
 * retries that start and the fix must install, so it counts as running.
 * Without a failed start, `created` is a package the installer or a restore
 * updated and kept stopped (`docker-compose up --no-start`): still stopped.
 *
 * Every other state (`exited`, `paused`, `dead`, `removing`) means Docker is
 * not running the container and will not start it by itself; its update waits
 * until the user starts it or updates it from the Admin. A container that
 * crashed and stayed down (no restart policy) is `exited` too, and its exit
 * code does not tell it apart from a user stop, so it waits as well.
 *
 * Core packages are never skipped: the system depends on them.
 *
 * @param {string} name DNP .eth name
 * @param {array} dnpList listPackages / dockerList.listContainers entries,
 *   with `name`, `packageName` (the container name), `state` (Docker's
 *   container state), `startFailed` (for `created` ones) and `isCore`
 * @returns {bool}
 */
function isStoppedPackage(name, dnpList) {
  const containers = (dnpList || []).filter(dnp => dnp && dnp.name === name);
  if (!containers.length || containers.some(dnp => dnp.isCore)) return false;
  const ownContainer = params.CONTAINER_NAME_PREFIX + name;
  return (
    containers.some(dnp => dnp.packageName === ownContainer) &&
    containers.every(dnp => !isActive(dnp))
  );
}

function isActive(dnp) {
  if (dnp.state === "created") return Boolean(dnp.startFailed);
  return ACTIVE_STATES.includes(dnp.state);
}

module.exports = isStoppedPackage;
