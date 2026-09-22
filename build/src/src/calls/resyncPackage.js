const fs = require("fs");
const getPath = require("utils/getPath");
const params = require("params");
const docker = require("modules/docker");
const dockerList = require("modules/dockerList");
const shellExec = require("utils/shell");
const { eventBus, eventBusTag } = require("eventBus");
const { stringIncludes } = require("utils/strings");
const logs = require("logs.js")(module);

/**
 * Subdirectory names/patterns to PRESERVE inside a volume (case-insensitive).
 * These contain validator keys, slashing protection, and other critical data
 * that must survive a resync.
 */
const PRESERVE_DIR_PATTERNS = [
  "validator",
  "validators",
  "keys",
  "key-manager",
  "key_manager",
  "slashing-protection",
  "slashing_protection",
  "wallet",
  "wallets",
  "passwords",
  "tls",
  "certs",
  "certificates",
];

/**
 * Subdirectory names/patterns that indicate chain/beacon data to DELETE (case-insensitive).
 */
const CHAINDATA_DIR_PATTERNS = [
  "beacon",
  "beaconchaindata",
  "chaindata",
  "network",
  "db",
  "protoarray",
];

/**
 * Checks if a directory name matches any of the given patterns (case-insensitive).
 * @param {string} dirName
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesPatterns(dirName, patterns) {
  const lower = dirName.toLowerCase();
  return patterns.some((p) => lower === p || lower.includes(p));
}

/**
 * Resyncs a package by selectively deleting only chain/beacon data
 * WITHIN volumes, while preserving validator keys, wallets, and config.
 *
 * This is critical because many consensus clients (e.g. Teku) store both
 * beacon chain data and validator data inside the SAME Docker volume.
 * Simply deleting the volume would destroy validator keys.
 *
 * Strategy:
 * 1. Stop the container
 * 2. For each volume, mount it in a temporary busybox container
 * 3. List top-level directories and recursively scan for beacon/chain dirs
 * 4. Delete only directories matching chain data patterns, NEVER touching
 *    directories matching validator/key patterns
 * 5. Restart the container
 *
 * @param {string} id DNP .eth name
 */
async function resyncPackage({ id }) {
  if (!id) throw Error("kwarg id must be defined");

  const dnpList = await dockerList.listContainers();
  const dnp = dnpList.find((_dnp) => stringIncludes(_dnp.name, id));
  if (!dnp) {
    throw Error(`Could not find a container with the name: ${id}`);
  }

  const dockerComposePath = getPath.dockerComposeSmart(id, params);
  if (!fs.existsSync(dockerComposePath)) {
    throw Error(`No docker-compose found: ${dockerComposePath}`);
  }

  if (id.includes("dappmanager.dnp.dappnode.eth")) {
    throw Error("The installer cannot be resynced");
  }

  // Only work with named Docker volumes (not bind mounts)
  const namedVolumes = (dnp.volumes || []).filter((v) => v.type === "volume");
  if (!namedVolumes.length) {
    return {
      message: `${id} has no named volumes`,
    };
  }

  // Stop the container(s) first
  logs.info(`Resyncing ${id}: stopping container...`);
  if (dnp.isCore) {
    await docker.compose.rm(dockerComposePath);
  } else {
    await docker.compose.stop(dockerComposePath);
    await docker.compose.rm(dockerComposePath);
  }

  // For each volume, selectively delete chain data subdirectories
  let deletedPaths = [];
  let preservedPaths = [];

  for (const vol of namedVolumes) {
    try {
      const result = await cleanVolumeChainData(vol.name);
      deletedPaths = deletedPaths.concat(result.deleted);
      preservedPaths = preservedPaths.concat(result.preserved);
    } catch (e) {
      logs.error(`Error cleaning volume ${vol.name}: ${e.message}`);
    }
  }

  if (!deletedPaths.length) {
    // Still restart even if nothing was found - user explicitly requested resync
    logs.warn(`No chain data directories found in volumes for ${id}`);
  }

  logs.info(
    `Resyncing ${id}: deleted [${deletedPaths.join(
      ", ",
    )}], preserved [${preservedPaths.join(", ")}]`,
  );

  // Restart the package
  await docker.safe.compose.up(dockerComposePath);

  // Emit packages update
  eventBus.emit(eventBusTag.emitPackages);

  return {
    message: `Resyncing ${id} chain data (preserving validators). Deleted: ${
      deletedPaths.length ? deletedPaths.join(", ") : "none"
    }. Preserved: ${
      preservedPaths.length ? preservedPaths.join(", ") : "none"
    }.`,
    logMessage: true,
    userAction: true,
  };
}

/**
 * Mounts a Docker volume in a temporary busybox container and
 * selectively deletes chain data directories while preserving
 * validator/key directories.
 *
 * Recursively scans up to 3 levels deep to find beacon/chain dirs.
 *
 * @param {string} volumeName Docker volume name
 * @returns {{ deleted: string[], preserved: string[] }}
 */
async function cleanVolumeChainData(volumeName) {
  const deleted = [];
  const preserved = [];

  // List all entries recursively up to 3 levels deep inside the volume
  // Using `find` with maxdepth to get directory structure
  let dirListing;
  try {
    dirListing = await shellExec(
      `docker run --rm -v ${volumeName}:/vol busybox find /vol -maxdepth 3 -type d`,
      { timeout: 30000 },
    );
  } catch (e) {
    logs.warn(`Could not list volume ${volumeName}: ${e.message}`);
    return { deleted, preserved };
  }

  const dirs = (dirListing || "")
    .split("\n")
    .map((d) => d.trim())
    .filter((d) => d && d !== "/vol");

  // Sort deepest first so we process leaf directories before parents
  dirs.sort((a, b) => b.split("/").length - a.split("/").length);

  // Collect directories to delete and preserve
  const toDelete = [];
  const toPreserve = [];

  for (const dir of dirs) {
    const dirName = dir.split("/").pop();

    if (matchesPatterns(dirName, PRESERVE_DIR_PATTERNS)) {
      toPreserve.push(dir);
    } else if (matchesPatterns(dirName, CHAINDATA_DIR_PATTERNS)) {
      // Only delete if this dir is NOT inside a preserved directory
      const isInsidePreserved = toPreserve.some((p) => dir.startsWith(p + "/"));
      if (!isInsidePreserved) {
        toDelete.push(dir);
      }
    }
  }

  // Also check: a directory to delete must NOT contain a preserved directory
  const safeToDelete = toDelete.filter((delDir) => {
    const containsPreserved = toPreserve.some((presDir) =>
      presDir.startsWith(delDir + "/"),
    );
    if (containsPreserved) {
      logs.warn(
        `Skipping deletion of ${delDir} because it contains preserved directory`,
      );
      return false;
    }
    return true;
  });

  // Execute deletions
  for (const dir of safeToDelete) {
    try {
      await shellExec(
        `docker run --rm -v ${volumeName}:/vol busybox rm -rf "${dir}"`,
        { timeout: 120000 },
      );
      deleted.push(`${volumeName}:${dir.replace("/vol", "")}`);
      logs.info(`Deleted chain data: ${volumeName}:${dir}`);
    } catch (e) {
      logs.error(`Failed to delete ${dir} in ${volumeName}: ${e.message}`);
    }
  }

  for (const dir of toPreserve) {
    preserved.push(`${volumeName}:${dir.replace("/vol", "")}`);
  }

  return { deleted, preserved };
}

module.exports = resyncPackage;
