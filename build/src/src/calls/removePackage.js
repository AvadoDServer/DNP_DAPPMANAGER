const fs = require("fs");
const db = require("db");
const params = require("params");
const { eventBus, eventBusTag } = require("eventBus");
const logs = require("logs.js")(module);
// Modules
const docker = require("modules/docker");
const dockerList = require("modules/dockerList");
// Utils
const parseManifestPorts = require("utils/parseManifestPorts");
const getPath = require("utils/getPath");
const shell = require("utils/shell");
const { stringIncludes } = require("utils/strings");

/**
 * Remove package data: docker down + disk files
 *
 * @param {string} id DNP .eth name
 * @param {bool} deleteVolumes flag to also clear permanent package data
 */
const removePackage = async ({ id, deleteVolumes = false }) => {
  if (!id) throw Error("kwarg id must be defined");

  const packageRepoDir = getPath.packageRepoDir(id, params);

  logs.info(
    `Removing package from packageRepoDir ${packageRepoDir} params=` + JSON.stringify(params)
  );


  const dockerComposePath = getPath.dockerComposeSmart(id, params);
  if (!fs.existsSync(dockerComposePath)) {
    throw Error(`No docker-compose found: ${dockerComposePath}`);
  }

  logs.info(
    `Removing package from dockerComposePath ${dockerComposePath}`
  );


  if (id.includes("dappmanager.dnp.dappnode.eth")) {
    throw Error("The installer cannot be restarted");
  }

  // CLOSE PORTS
  // portsToClose: [ {number: 30303, type: 'UDP'}, ...]
  const dnpList = await dockerList.listContainers();
  const dnp = dnpList.find(_dnp => stringIncludes(_dnp.name, id));
  if (!dnp) {
    throw Error(
      `No DNP was found for name ${id}, so its ports cannot be closed`
    );
  }
  // Get manifest
  let mappedPortsToClose = [];
  try {
    const manifestPath = getPath.manifest(id, params, dnp.isCore);
    const manifestFileData = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(manifestFileData);
    mappedPortsToClose = parseManifestPorts(manifest);
  } catch (e) {
    logs.error(
      `Error getting mappedPortsToClose from manifest of ${dnp.name}: ${
        e.stack
      }`
    );
  }
  // Skip if there are no ports to open or if UPnP is not available
  const upnpAvailable = await db.get("upnpAvailable");
  // dnp.portsToClose = [ {number: 30303, type: 'UDP'}, ...] - will always be defined and an array
  const portsToClose = [...mappedPortsToClose, ...dnp.portsToClose];
  if (dnp.portsToClose.length && upnpAvailable) {
    eventBus.emit(eventBusTag.call, {
      callId: "managePorts",
      kwargs: {
        action: "close",
        ports: portsToClose
      }
    });
  }

  logs.info(
    `removing containers from ${dockerComposePath}`
  );

  // Remove container (and) volumes
  await docker.compose.down(dockerComposePath, {
    volumes: Boolean(deleteVolumes)
  });

  logs.info(
    `removing package dir`
  );

  // Remove DNP folder and files
  await shell(`rm -rf ${packageRepoDir}`);

  // Emit packages update
  eventBus.emit(eventBusTag.emitPackages);
  eventBus.emit(eventBusTag.packageModified);


  logs.info(
    `removed package ${id}`
  );

  return {
    message: `Removed package: ${id}`,
    logMessage: true,
    userAction: true
  };
};

module.exports = removePackage;
