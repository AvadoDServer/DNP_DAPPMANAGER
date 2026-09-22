const fs = require("fs");
const getPath = require("utils/getPath");
const validate = require("utils/validate");
const parse = require("utils/parse");
const docker = require("modules/docker");
const params = require("params");

/**
 * The DAPPMANAGER is unable to reset itself. When it calls docker-compose up it
 * will first stop the current package which cancels the call and the container
 * stays exited forcing the user to ssh into the server to regain control of
 * her/his DAppNode.
 *
 * This package spins a secondary container with the sole purpose of calling
 * docker-compose up on the DAPPMANAGER. Then it will end execution and remain exited
 * The name of the container is DAppNodeTool-restart.dnp.dappnode.eth so it doesn't
 * shows up in the ADMIN UI's package list
 */

async function restartPatch(IMAGE_NAME = "") {
  if (!IMAGE_NAME.includes(":")) {
    // Use the image the DAPPMANAGER compose file names: it is what the restart
    // container will bring up anyway. The running container's tag is not
    // reliable, docker reports a digest once the tag points at another image,
    // and compose would then hang on an interactive pull prompt.
    const dappmanagerCompose = getPath.dockerCompose(
      "dappmanager.dnp.dappnode.eth",
      params,
      true
    );
    IMAGE_NAME = parse.getUniqueDockerComposeService(dappmanagerCompose).image;
  }

  const DOCKERCOMPOSE_RESTART_PATH = getPath.dockerCompose(
    "restart.dnp.dappnode.eth",
    params,
    true
  );
  const PATH_LOCAL = "/usr/src/dappnode/DNCORE/docker-compose-dappmanager.yml";
  const PATH_REMOTE = "/usr/src/app/DNCORE/docker-compose-dappmanager.yml";
  const DOCKERCOMPOSE_DATA = `version: '3.4'

services:
    restart.dnp.dappnode.eth:
        image: ${IMAGE_NAME}
        container_name: DAppNodeTool-restart.dnp.dappnode.eth
        volumes:
            - '${PATH_LOCAL}:${PATH_REMOTE}'
            - '/usr/local/bin/docker-compose:/usr/local/bin/docker-compose'
            - '/var/run/docker.sock:/var/run/docker.sock'
        entrypoint:
            docker-compose -f ${PATH_REMOTE} up -d --force-recreate`;

  validate.path(DOCKERCOMPOSE_RESTART_PATH);
  await fs.writeFileSync(DOCKERCOMPOSE_RESTART_PATH, DOCKERCOMPOSE_DATA);
  await docker.compose.up(DOCKERCOMPOSE_RESTART_PATH);
}

module.exports = restartPatch;
