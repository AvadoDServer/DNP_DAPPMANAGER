const proxyquire = require("proxyquire");
const chai = require("chai");
const expect = require("chai").expect;
const sinon = require("sinon");
const fs = require("fs");
const getPath = require("utils/getPath");
const validate = require("utils/validate");

chai.should();

describe("Call function: restartPackage", function() {
  const params = {
    DNCORE_DIR: "DNCORE",
    REPO_DIR: "test_files/"
  };

  const PACKAGE_NAME = "test.dnp.dappnode.eth";
  const DOCKERCOMPOSE_PATH = getPath.dockerCompose(PACKAGE_NAME, params);

  before(() => {
    validate.path(DOCKERCOMPOSE_PATH);
    fs.writeFileSync(DOCKERCOMPOSE_PATH, "docker-compose");
  });

  it("should restart the package", async () => {
    // Mock docker
    const docker = {
      safe: {
        compose: {
          up: sinon.fake()
        }
      },
      compose: {
        stop: sinon.fake(),
        rm: sinon.fake()
      }
    };
    // Mock parse
    const restartPackage = proxyquire("calls/restartPackage", {
      "modules/docker": docker,
      params: params
    });
    let res = await restartPackage({ id: PACKAGE_NAME });
    sinon.assert.calledWith(docker.compose.stop, DOCKERCOMPOSE_PATH, {
      timeout: 180
    });
    sinon.assert.calledWith(docker.compose.rm, DOCKERCOMPOSE_PATH);
    sinon.assert.calledWith(docker.safe.compose.up, DOCKERCOMPOSE_PATH);
    expect(res).to.be.ok;
    expect(res).to.have.property("message");
  });

  it("should hand the DAPPMANAGER to the restart container and never stop it", async () => {
    const id = "dappmanager.dnp.dappnode.eth";
    const dappmanagerComposePath = getPath.dockerCompose(id, params, true);
    validate.path(dappmanagerComposePath);
    fs.writeFileSync(dappmanagerComposePath, "docker-compose");

    const docker = {
      safe: { compose: { up: sinon.fake() } },
      compose: { stop: sinon.fake(), rm: sinon.fake() }
    };
    const restartPatch = sinon.fake();
    const restartPackage = proxyquire("calls/restartPackage", {
      "modules/docker": docker,
      "modules/restartPatch": restartPatch,
      params: params
    });
    const res = await restartPackage({ id });
    fs.unlinkSync(dappmanagerComposePath);

    sinon.assert.calledOnce(restartPatch);
    sinon.assert.calledWith(restartPatch, id);
    sinon.assert.notCalled(docker.compose.stop);
    sinon.assert.notCalled(docker.compose.rm);
    sinon.assert.notCalled(docker.safe.compose.up);
    expect(res).to.have.property("message");
  });

  after(() => {
    fs.unlinkSync(DOCKERCOMPOSE_PATH);
  });
});
