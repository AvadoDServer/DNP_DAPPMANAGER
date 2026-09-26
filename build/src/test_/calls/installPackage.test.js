const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");
const { eventBusTag } = require("eventBus");

describe("Call function: installPackage", function() {
  const params = {
    DNCORE_DIR: "DNCORE",
    REPO_DIR: "test_files/"
  };

  const pkgName = "dapp.dnp.dappnode.eth";
  const pkgVer = "0.1.1";
  const pkgManifest = {
    name: pkgName,
    type: "service"
  };

  const depName = "kovan.dnp.dappnode.eth";
  const depVer = "0.1.1";
  const depManifest = {
    name: depName,
    type: "library"
  };
  const depPortsToOpen = [
    { number: 32769, type: "UDP" },
    { number: 32769, type: "TCP" }
  ];

  // Stub packages module. Resolve always returning nothing
  const packages = {
    download: sinon.fake.resolves(),
    run: sinon.fake.resolves()
  };

  const dappGet = sinon.fake.resolves({
    message: "Found compatible state",
    state: { [pkgName]: pkgVer, [depName]: depVer }
  });

  const getManifest = sinon.stub().callsFake(async function(pkg) {
    if (pkg.name === pkgName) return pkgManifest;
    else if (pkg.name === depName) return depManifest;
    else throw Error(`[SINON STUB] Manifest of ${pkg.name} not available`);
  });

  const eventBusPackage = {
    eventBus: {
      emit: sinon.stub()
    },
    eventBusTag
  };

  const dockerList = {
    listContainers: async () => {}
  };

  // Simulate that only the dependency has p2p ports
  const lockPorts = sinon.stub().callsFake(async ({ pkg }) => {
    if (pkg.name === depName) return depPortsToOpen;
    else return [];
  });

  // Simulated the chain is already synced
  const isSyncing = async () => false;

  // db to know UPnP state
  const db = {
    get: async key => {
      if (key === "upnpAvailable") return true;
    }
  };

  const installPackage = proxyquire("calls/installPackage", {
    "modules/packages": packages,
    "modules/dappGet": dappGet,
    "modules/getManifest": getManifest,
    "modules/dockerList": dockerList,
    "modules/lockPorts": lockPorts,
    eventBus: eventBusPackage,
    "utils/isSyncing": isSyncing,
    params: params,
    db: db
  });

  // before(() => {
  //     const DOCKERCOMPOSE_PATH = getPath.dockerCompose(PACKAGE_NAME, params);
  //     validate.path(DOCKERCOMPOSE_PATH);
  //     fs.writeFileSync(DOCKERCOMPOSE_PATH, dockerComposeTemplate);
  // });

  it("should install the package with correct arguments", async () => {
    const res = await installPackage({ id: pkgName });
    expect(res).to.be.an("object");
    expect(res).to.have.property("message");
  });

  // Step 1: Parse request
  // Step 2: Resolve the request
  it("should have called dappGet with correct arguments", async () => {
    sinon.assert.calledWith(dappGet, { name: pkgName, req: pkgName, ver: "*" });
  });

  // Step 3: Format the request and filter out already updated packages
  // Step 4: Download requested packages
  it("should have called download", async () => {
    sinon.assert.callCount(packages.download, 2);
    expect(packages.download.getCall(0).args).to.deep.equal(
      [
        {
          id: pkgName,
          pkg: {
            manifest: { ...pkgManifest },
            name: pkgName,
            ver: pkgVer
          }
        }
      ],
      `should call packages.download first for package ${pkgName}`
    );
    expect(packages.download.getCall(1).args).to.deep.equal(
      [
        {
          id: pkgName,
          pkg: {
            manifest: { ...depManifest },
            name: depName,
            ver: depVer
          }
        }
      ],
      `should call packages.download second for dependency ${depName}`
    );
  });

  // Step 5: Run requested packages
  it("should have called run", async () => {
    sinon.assert.callCount(packages.run, 2);
    expect(packages.run.getCall(0).args).to.deep.equal(
      [
        {
          id: pkgName,
          pkg: {
            manifest: { ...pkgManifest },
            name: pkgName,
            ver: pkgVer
          }
        }
      ],
      `should call packages.run second for dependency ${depName}`
    );
    expect(packages.run.getCall(1).args).to.deep.equal(
      [
        {
          id: pkgName,
          pkg: {
            manifest: { ...depManifest },
            name: depName,
            ver: depVer
          }
        }
      ],
      `should call packages.run second for dependency ${depName}`
    );
  });

  // Step 6: P2P ports: modify docker-compose + open ports
  it("should emit an internal call to the eventBus", async () => {
    sinon.assert.callCount(lockPorts, 2);
    // eventBus should be called once to open ports, and then to emitPackages
    sinon.assert.callCount(eventBusPackage.eventBus.emit, 3);
    expect(eventBusPackage.eventBus.emit.getCall(0).args).to.deep.equal(
      [
        eventBusTag.call,
        {
          callId: "managePorts",
          kwargs: {
            action: "open",
            ports: depPortsToOpen
          }
        }
      ],
      `eventBus.emit first call must be to open the dependencies' ports`
    );
  });

  // Step FINAL:
  it("should request to emit packages to refresh the UI", async () => {
    expect(eventBusPackage.eventBus.emit.getCall(1).args).to.deep.equal(
      [eventBusTag.emitPackages],
      `eventBus.emit second call must be to request emit packages`
    );
  });

  // it('should throw an error with wrong package name', async () => {
  //     let error = '--- removePackage did not throw ---';
  //     try {
  //         await removePackage({id: PACKAGE_NAME});
  //     } catch (e) {
  //         error = e.message;
  //     }
  //     expect(error).to.include('No docker-compose found');
  // });
});

// The auto-updater passes KEEP_STOPPED: an update must not start a package the
// user stopped (docker-compose up would), dependencies included
describe("Call function: installPackage, KEEP_STOPPED", function() {
  const pkgName = "dapp.dnp.dappnode.eth";
  const depName = "teku.avado.dnp.dappnode.eth";
  const ver = "0.1.1";

  let containers; // what docker reports as installed
  let onDownload; // runs during the download, e.g. the user pauses a package

  const packages = {
    download: sinon.stub().callsFake(async () => onDownload()),
    run: sinon.stub().resolves()
  };
  const dappGet = async () => ({
    state: { [pkgName]: ver, [depName]: ver }
  });
  const getManifest = async ({ name }) => ({ name, type: "service" });
  const dockerList = { listContainers: async () => containers };
  const envsHelper = {
    getManifestEnvs: () => ({}),
    load: () => ({}),
    write: () => {}
  };

  const installPackage = proxyquire("calls/installPackage", {
    "modules/packages": packages,
    "modules/dappGet": dappGet,
    "modules/getManifest": getManifest,
    "modules/dockerList": dockerList,
    "modules/lockPorts": async () => [],
    "utils/isSyncing": async () => false,
    "utils/envsHelper": envsHelper,
    "utils/logUi": () => {},
    "./updateDNS": async () => ({}),
    eventBus: { eventBus: { emit: () => {} }, eventBusTag },
    db: { get: async () => false }
  });

  const container = (name, state, isCore = false) => ({ name, state, isCore });

  beforeEach(() => {
    packages.download.resetHistory();
    packages.run.resetHistory();
    onDownload = () => {};
  });

  async function installError(options) {
    try {
      await installPackage({ id: pkgName, options });
    } catch (e) {
      return e.message;
    }
    return null;
  }

  it("installs when the package and its dependency run", async () => {
    containers = [
      container(pkgName, "running"),
      container(depName, "restarting")
    ];
    expect(await installError({ KEEP_STOPPED: true })).to.equal(null);
    sinon.assert.callCount(packages.run, 2);
  });

  it("refuses before writing anything when a dependency is stopped", async () => {
    containers = [container(pkgName, "running"), container(depName, "exited")];
    expect(await installError({ KEEP_STOPPED: true })).to.include(
      `Not starting stopped package ${depName} (exited)`
    );
    sinon.assert.notCalled(packages.download);
    sinon.assert.notCalled(packages.run);
  });

  it("refuses to run when the user stops a package during the download", async () => {
    containers = [container(pkgName, "running"), container(depName, "running")];
    onDownload = () => {
      containers = [
        container(pkgName, "exited"),
        container(depName, "running")
      ];
    };
    expect(await installError({ KEEP_STOPPED: true })).to.include(
      `Not starting stopped package ${pkgName} (exited)`
    );
    sinon.assert.called(packages.download);
    sinon.assert.notCalled(packages.run);
  });

  it("installs a stopped core package", async () => {
    containers = [
      container(pkgName, "exited", true),
      container(depName, "running")
    ];
    expect(await installError({ KEEP_STOPPED: true })).to.equal(null);
    sinon.assert.callCount(packages.run, 2);
  });

  it("a manual update from the Admin (no KEEP_STOPPED) still installs a stopped package", async () => {
    containers = [container(pkgName, "exited"), container(depName, "exited")];
    expect(await installError({})).to.equal(null);
    sinon.assert.callCount(packages.run, 2);
  });
});
