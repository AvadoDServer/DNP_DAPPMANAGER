const proxyquire = require("proxyquire");
const chai = require("chai");
const expect = require("chai").expect;
const shell = require("shelljs");
const fs = require("fs");
const getPath = require("utils/getPath");
const { stringifyEnvs } = require("utils/parse");

chai.should();

describe("Call function: listPackages", function() {
  mockTest();
});

function mockTest() {
  let hasListed = false;
  let envs = { VAR1: "VALUE1" };
  let mockList = [
    {
      name: "test.dnp.dappnode.eth"
    }
  ];
  // Result should extend the package list with the env variables and the
  // autoupdate flag (default true when nothing is stored)
  let expectedResult = [
    Object.assign({ envs, manifest: { autoupdate: true } }, mockList[0])
  ];

  // Mock docker calls
  const dockerCalls = {
    listContainers: async () => {
      hasListed = true;
      return mockList;
    }
  };

  // Mock params
  const params = {
    DNCORE_DIR: "DNCORE",
    REPO_DIR: "test_files/"
  };

  // initialize call
  // Volume info comes from a real `docker system df`; not in a unit test
  const docker = {
    systemDf: async () => {
      throw Error("docker not available in unit tests");
    }
  };
  const db = { get: async () => undefined };

  const listPackages = proxyquire("calls/listPackages", {
    "modules/dockerList": dockerCalls,
    "modules/docker": docker,
    "../db": db,
    params: params
  });

  before(() => {
    // Write mock data on the test folder
    const ENV_PATH = getPath.envFile(mockList[0].name, params);
    shell.mkdir("-p", getParentDir(ENV_PATH));
    fs.writeFileSync(ENV_PATH, stringifyEnvs(envs));
  });

  describe("mock test", function() {
    let res;
    it("should list packages with correct arguments", async () => {
      res = await listPackages();
      expect(hasListed).to.be.true;
    });

    it("should return a stringified object containing lists", () => {
      expect(res).to.be.ok;
      expect(res).to.have.property("message");
      expect(res).to.deep.include({
        result: expectedResult
      });
    });
  });
}

function getParentDir(fullPath) {
  return fullPath.replace(/\/[^/]+$/, "");
}
