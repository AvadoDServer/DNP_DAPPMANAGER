const fs = require("fs");
const getPath = require("utils/getPath");
const restartPatch = require("modules/restartPatch");
const params = require("params");
const docker = require("modules/docker");
const { eventBus, eventBusTag } = require("eventBus");

/**
 * Calls docker rm and docker up on a package
 *
 * @param {string} id DNP .eth name
 */
const restartPackage = async ({ id, timeout = 180 }) => {
  if (!id) throw Error("kwarg id must be defined");

  const dockerComposePath = getPath.dockerComposeSmart(id, params);
  if (!fs.existsSync(dockerComposePath)) {
    throw Error(`No docker-compose found: ${dockerComposePath}`);
  }

  // The DAPPMANAGER cannot stop itself: compose stop would kill this process
  // before rm and up run, and a container stopped on purpose is not brought
  // back by "restart: always". The restart container recreates it instead.
  if (id.includes("dappmanager.dnp.dappnode.eth")) {
    await restartPatch(id);
    return {
      message: `Restarting package: ${id}`,
      logMessage: true,
      userAction: true
    };
  }

  // Combining rm && up doesn't prevent the installer from crashing
  await docker.compose.stop(dockerComposePath, { timeout });
  await docker.compose.rm(dockerComposePath);
  await docker.safe.compose.up(dockerComposePath);

  // Emit packages update
  eventBus.emit(eventBusTag.emitPackages);

  return {
    message: `Restarted package: ${id}`,
    logMessage: true,
    userAction: true
  };
};

module.exports = restartPackage;
