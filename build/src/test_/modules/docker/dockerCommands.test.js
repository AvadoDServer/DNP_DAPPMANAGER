const dockerCommands = require("modules/docker/dockerCommands");
const expect = require("chai").expect;

describe("docker commands", function() {
  const dcPath = "dnp_repo/my.dnp.dappnode.eth/docker-compose.yml";
  const compose = `docker-compose -p mydnpdappnodeeth -f ${dcPath}`;
  const imagePath = "./myImage";

  it(".up should call docker/compose with correct arguments", () => {
    expect(dockerCommands.compose.up(dcPath)).to.equal(`${compose} up -d`);
  });

  it(".stop should call docker/compose with correct arguments", () => {
    expect(dockerCommands.compose.stop(dcPath, { timeout: 0 })).to.equal(
      `${compose} stop --timeout 0`
    );
  });

  it(".start should call docker/compose with correct arguments", () => {
    expect(dockerCommands.compose.start(dcPath)).to.equal(`${compose} start`);
  });

  it(".down should call docker/compose with correct arguments", () => {
    expect(dockerCommands.compose.down(dcPath, { timeout: 0 })).to.equal(
      `${compose} down --timeout 0`
    );
  });

  it(".log should call docker/compose with correct arguments", () => {
    expect(dockerCommands.compose.logs(dcPath, { timestamps: true })).to.equal(
      `${compose} logs --timestamps 2>&1`
    );
  });

  it(".loadImage should call REGULAR DOCKER with correct arguments", () => {
    expect(dockerCommands.load(imagePath)).to.equal(`docker load -i ./myImage`);
  });

  // docker-compose 1.20.1 (bundled up to 10.0.45) stripped "-" and "_" from
  // the project name, compose v2 keeps them. Installed packages must keep the
  // project name they were created with, or their volumes are not found.
  describe("project name as docker-compose 1.20.1 computed it", () => {
    const cases = {
      "dnp_repo/ethchain-geth.public.dappnode.eth/docker-compose.yml":
        "ethchaingethpublicdappnodeeth",
      "dnp_repo/qa-probe_pkg.public.dappnode.eth/docker-compose.yml":
        "qaprobepkgpublicdappnodeeth",
      "/usr/src/app/dnp_repo/Teku.Avado.dnp.dappnode.eth/docker-compose.yml":
        "tekuavadodnpdappnodeeth",
      "DNCORE/docker-compose-dappmanager.yml": "dncore",
      "/usr/src/app/DNCORE/docker-compose-restart.yml": "dncore"
    };
    for (const [path, projectName] of Object.entries(cases)) {
      it(`${path} => ${projectName}`, () => {
        expect(dockerCommands.compose.up(path)).to.equal(
          `docker-compose -p ${projectName} -f ${path} up -d`
        );
      });
    }
  });
});
