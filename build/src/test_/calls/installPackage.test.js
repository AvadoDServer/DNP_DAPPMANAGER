const fs = require("fs");
const os = require("os");
const path = require("path");
const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");
const { eventBusTag } = require("eventBus");
const getPath = require("utils/getPath");

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
    "./updateDNS": async () => ({}),
    params: params,
    db: db
  });

  // before(() => {
  //     const DOCKERCOMPOSE_PATH = getPath.dockerCompose(PACKAGE_NAME, params);
  //     validate.path(DOCKERCOMPOSE_PATH);
  //     fs.writeFileSync(DOCKERCOMPOSE_PATH, dockerComposeTemplate);
  // });

  it("runs two installs requested at once one after the other", async () => {
    // A core update of the Admin followed by one of the DAPPMANAGER used to run
    // in parallel: the DAPPMANAGER's self-restart then killed the Admin install
    // half-way (old container stopped, new one never created).
    const runOrder = [];
    let releaseFirst;
    const slowPackages = {
      download: sinon.fake.resolves(),
      run: sinon.stub().callsFake(async ({ pkg }) => {
        runOrder.push(`${pkg.name} start`);
        if (runOrder.length === 1) await new Promise(resolve => (releaseFirst = resolve));
        runOrder.push(`${pkg.name} end`);
      })
    };
    const installPackageSlow = proxyquire("calls/installPackage", {
      "modules/packages": slowPackages,
      "modules/dappGet": sinon.fake.resolves({ message: "ok", state: { [pkgName]: pkgVer } }),
      "modules/getManifest": getManifest,
      "modules/dockerList": dockerList,
      "modules/lockPorts": sinon.fake.resolves([]),
      eventBus: { eventBus: { emit: sinon.stub() }, eventBusTag },
      "utils/isSyncing": isSyncing,
      "./updateDNS": async () => ({}),
      params: params,
      db: db
    });
    const first = installPackageSlow({ id: pkgName });
    const second = installPackageSlow({ id: pkgName });
    // Let the first install reach packages.run and park there
    for (let i = 0; i < 20 && !releaseFirst; i++) await new Promise(resolve => setImmediate(resolve));
    expect(runOrder).to.deep.equal([`${pkgName} start`]);
    releaseFirst();
    await first;
    await second;
    expect(runOrder).to.deep.equal([
      `${pkgName} start`,
      `${pkgName} end`,
      `${pkgName} start`,
      `${pkgName} end`
    ]);
  });

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
          },
          noStart: false
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
          },
          noStart: false
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

  // The package repo, in a temp dir: packages.download writes the new version's
  // manifest and docker-compose there before it loads the image
  const params = {
    CONTAINER_NAME_PREFIX: "DAppNodePackage-",
    DNCORE_DIR: "DNCORE",
    REPO_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "installPackage-test-"))
  };
  const packageFiles = name => [
    getPath.manifest(name, params, false),
    getPath.dockerCompose(name, params, false)
  ];
  const writeFiles = (name, data) => {
    for (const file of packageFiles(name)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
  };
  const readFiles = name =>
    packageFiles(name).map(file =>
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    );

  const packages = {
    download: sinon.stub().callsFake(async ({ pkg }) => {
      writeFiles(pkg.name, `new version of ${pkg.name}`);
      await onDownload();
    }),
    run: sinon.stub().resolves()
  };
  const lockPorts = sinon.stub().resolves([]);
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
    "modules/lockPorts": lockPorts,
    "utils/isSyncing": async () => false,
    "utils/envsHelper": envsHelper,
    "utils/logUi": () => {},
    "./updateDNS": async () => ({}),
    eventBus: { eventBus: { emit: () => {} }, eventBusTag },
    db: { get: async () => false },
    params
  });

  const container = (name, state, isCore = false) => ({
    name,
    packageName: `${isCore ? "DAppNodeCore-" : "DAppNodePackage-"}${name}`,
    state,
    isCore
  });
  // docker-compose 1.x's renamed old container, left exited by a failed update
  const leftover = name => ({
    ...container(name, "exited"),
    packageName: `2cdce2f4ef32_DAppNodePackage-${name}`
  });

  beforeEach(() => {
    packages.download.resetHistory();
    packages.run.resetHistory();
    lockPorts.resetHistory();
    onDownload = () => {};
    fs.rmSync(params.REPO_DIR, { recursive: true, force: true });
  });

  after(() => {
    fs.rmSync(params.REPO_DIR, { recursive: true, force: true });
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

  it("refuses to run when the user stops a package during the download, and puts its files back", async () => {
    containers = [container(pkgName, "running"), container(depName, "running")];
    writeFiles(pkgName, "installed version");
    writeFiles(depName, "installed dependency");
    onDownload = () => {
      containers = [
        container(pkgName, "exited"),
        container(depName, "running")
      ];
    };
    expect(await installError({ KEEP_STOPPED: true })).to.equal(
      `Not starting stopped package ${pkgName} (exited); start it, or update from the Admin`
    );
    sinon.assert.called(packages.download);
    sinon.assert.notCalled(packages.run);
    // The installed version's manifest and docker-compose, not the new ones
    expect(readFiles(pkgName)).to.deep.equal([
      "installed version",
      "installed version"
    ]);
    expect(readFiles(depName)).to.deep.equal([
      "installed dependency",
      "installed dependency"
    ]);
  });

  it("keeps the new files when the update runs", async () => {
    containers = [container(pkgName, "running"), container(depName, "running")];
    writeFiles(pkgName, "installed version");
    expect(await installError({ KEEP_STOPPED: true })).to.equal(null);
    expect(readFiles(pkgName)).to.deep.equal([
      `new version of ${pkgName}`,
      `new version of ${pkgName}`
    ]);
  });

  it("installs a package left created by an update whose container failed to start", async () => {
    containers = [
      leftover(pkgName),
      { ...container(pkgName, "created"), startFailed: true },
      container(depName, "running")
    ];
    expect(await installError({ KEEP_STOPPED: true })).to.equal(null);
    sinon.assert.callCount(packages.run, 2);
  });

  it("refuses a paused package even next to an exited leftover", async () => {
    containers = [
      leftover(pkgName),
      container(pkgName, "exited"),
      container(depName, "running")
    ];
    expect(await installError({ KEEP_STOPPED: true })).to.include(
      `Not starting stopped package ${pkgName} (exited, exited)`
    );
    sinon.assert.notCalled(packages.download);
  });

  it("installs a stopped core package", async () => {
    containers = [
      container(pkgName, "exited", true),
      container(depName, "running")
    ];
    expect(await installError({ KEEP_STOPPED: true })).to.equal(null);
    sinon.assert.callCount(packages.run, 2);
  });

  it("a manual update from the Admin (no KEEP_STOPPED) still installs a stopped package, without starting it", async () => {
    containers = [container(pkgName, "exited"), container(depName, "exited")];
    expect(await installError({})).to.equal(null);
    sinon.assert.callCount(packages.run, 2);
    for (const call of packages.run.getCalls())
      expect(call.args[0].noStart).to.equal(true);
  });
});

// The Admin's Install / Update (no options): a package the user stopped is
// updated but stays stopped, dependencies included, as DAppNode's installer does
describe("Call function: installPackage, stopped packages stay stopped", function() {
  const pkgName = "fulcrum.avado.dnp.dappnode.eth";
  const depName = "bitcoincore.avado.dnp.dappnode.eth";
  const ver = "0.1.1";

  let containers;
  let onDownload;
  let emitted;

  const params = {
    CONTAINER_NAME_PREFIX: "DAppNodePackage-",
    DNCORE_DIR: "DNCORE",
    REPO_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "installPackage-test-"))
  };
  const packages = {
    download: sinon.stub().callsFake(async () => onDownload()),
    run: sinon.stub().resolves()
  };
  const lockPorts = sinon.stub().resolves([{ number: 32769, type: "UDP" }]);
  const installPackage = proxyquire("calls/installPackage", {
    "modules/packages": packages,
    "modules/dappGet": async () => ({ state: { [pkgName]: ver, [depName]: ver } }),
    "modules/getManifest": async ({ name }) => ({
      name,
      type: "service",
      image: { ports: ["50001:50001"] }
    }),
    "modules/dockerList": { listContainers: async () => containers },
    "modules/lockPorts": lockPorts,
    "utils/isSyncing": async () => false,
    "utils/envsHelper": { getManifestEnvs: () => ({}), load: () => ({}), write: () => {} },
    "utils/logUi": () => {},
    "./updateDNS": async () => ({}),
    eventBus: { eventBus: { emit: (...args) => emitted.push(args) }, eventBusTag },
    db: { get: async key => key === "upnpAvailable" },
    params
  });

  const container = (name, state, extra = {}) => ({
    name,
    packageName: `DAppNodePackage-${name}`,
    state,
    isCore: false,
    ...extra
  });
  const runs = () =>
    Object.fromEntries(
      packages.run.getCalls().map(call => [call.args[0].pkg.name, call.args[0].noStart])
    );
  const lockedPortsOf = () => lockPorts.getCalls().map(call => call.args[0].pkg.name);

  beforeEach(() => {
    packages.download.resetHistory();
    packages.run.resetHistory();
    lockPorts.resetHistory();
    onDownload = () => {};
    emitted = [];
  });

  after(() => {
    fs.rmSync(params.REPO_DIR, { recursive: true, force: true });
  });

  it("updates a stopped package and its stopped dependency without starting either", async () => {
    containers = [container(pkgName, "exited"), container(depName, "exited")];
    const res = await installPackage({ id: pkgName });
    expect(runs()).to.deep.equal({ [pkgName]: true, [depName]: true });
    // lockPorts would read the running container's ports and docker-compose up
    expect(lockedPortsOf()).to.deep.equal([]);
    expect(res.message).to.equal(
      `Installed ${pkgName}. Still stopped, as you left it: fulcrum, bitcoincore`
    );
  });

  it("installing an app does not start its stopped dependency (Electrum and a stopped Bitcoin Node)", async () => {
    containers = [container(depName, "exited")];
    const res = await installPackage({ id: pkgName });
    expect(runs()).to.deep.equal({ [pkgName]: false, [depName]: true });
    expect(lockedPortsOf()).to.deep.equal([pkgName]);
    expect(res.message).to.include("Still stopped, as you left it: bitcoincore");
  });

  it("a new install starts, and a running dependency restarts", async () => {
    containers = [container(depName, "running")];
    const res = await installPackage({ id: pkgName });
    expect(runs()).to.deep.equal({ [pkgName]: false, [depName]: false });
    expect(lockedPortsOf()).to.deep.equal([pkgName, depName]);
    expect(res.message).to.equal(`Installed ${pkgName}`);
  });

  it("a running package restarts as before", async () => {
    containers = [container(pkgName, "running"), container(depName, "running")];
    await installPackage({ id: pkgName });
    expect(runs()).to.deep.equal({ [pkgName]: false, [depName]: false });
  });

  it("a package kept stopped by an earlier update (created, never started) stays stopped", async () => {
    containers = [
      container(pkgName, "created", { startFailed: false }),
      container(depName, "created", { startFailed: true })
    ];
    await installPackage({ id: pkgName });
    // The dependency's last start failed: that is a fix to install and start
    expect(runs()).to.deep.equal({ [pkgName]: true, [depName]: false });
  });

  it("a package the user stops during the download stays stopped", async () => {
    containers = [container(pkgName, "running"), container(depName, "running")];
    onDownload = () => {
      containers = [container(pkgName, "running"), container(depName, "exited")];
    };
    await installPackage({ id: pkgName });
    expect(runs()).to.deep.equal({ [pkgName]: false, [depName]: true });
  });

  it("still opens the mapped ports of a package kept stopped", async () => {
    containers = [container(pkgName, "exited"), container(depName, "exited")];
    await installPackage({ id: pkgName });
    const opened = emitted.filter(([tag, call]) => tag === eventBusTag.call && call.callId === "managePorts");
    expect(opened).to.have.length(2);
  });
});
