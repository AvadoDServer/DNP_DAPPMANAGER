const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");

// All stubs resolve without timers, so one macrotask drains the whole run
const flush = () => new Promise(resolve => setImmediate(resolve));

describe("Watcher: autoupdate", () => {
  const storeHash = "QmStoreHash";
  const newHash = "/ipfs/QmNewVersion";

  let installed = []; // what listPackages returns
  let store = { packages: [] }; // the store the watcher fetches from IPFS
  const logged = [];
  const loggedErrors = [];

  const installPackage = sinon.stub();
  const calls = {
    "@noCallThru": true,
    listPackages: async () => ({ result: installed }),
    installPackage
  };
  const ipfs = {
    "@noCallThru": true,
    cat: async hash => {
      if (hash !== storeHash) throw Error(`Unknown hash ${hash}`);
      return JSON.stringify(store);
    }
  };
  // No autoupdate key stored: autoupdate is on
  const db = { "@noCallThru": true, get: async () => undefined };
  const jayson = {
    "@noCallThru": true,
    client: {
      https: function() {
        return {
          request: (method, params, callback) =>
            callback(null, { result: JSON.stringify({ hash: storeHash }) })
        };
      }
    }
  };
  const logs = () => ({
    info: msg => logged.push(msg),
    warn: () => {},
    error: msg => loggedErrors.push(msg),
    debug: () => {}
  });
  logs["@noCallThru"] = true;

  let clock;
  let monitorUpdates;

  before(async () => {
    // The module schedules an hourly run when loaded
    clock = sinon.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    monitorUpdates = proxyquire("watchers/autoupdate", {
      "../../calls": calls,
      "../../modules/ipfs": ipfs,
      "../../db": db,
      jayson,
      "logs.js": logs
    });
    // Let the run it starts on load finish (nothing installed)
    await flush();
  });

  after(() => {
    clock.restore();
  });

  beforeEach(() => {
    installPackage.reset();
    installPackage.resolves({});
    logged.length = 0;
    loggedErrors.length = 0;
  });

  function pkg(name, state, extra = {}) {
    return {
      name,
      packageName: `${extra.isCore ? "DAppNodeCore-" : "DAppNodePackage-"}${name}`,
      version: "0.0.1",
      state,
      isCore: false,
      manifest: { autoupdate: true },
      ...extra
    };
  }

  // The old container docker-compose 1.x leaves behind, renamed and exited,
  // when the new container of an update fails
  function leftover(name) {
    return pkg(name, "exited", {
      packageName: `2cdce2f4ef32_DAppNodePackage-${name}`
    });
  }

  function storeHas(...names) {
    store = {
      packages: names.map(name => ({
        manifest: { name, version: "0.0.2" },
        manifesthash: newHash
      }))
    };
  }

  async function runWatcher() {
    await monitorUpdates();
    await flush();
  }

  const teku = "teku.avado.dnp.dappnode.eth";
  const nimbus = "nimbus.avado.dnp.dappnode.eth";

  it("updates a running package", async () => {
    installed = [pkg(teku, "running")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    sinon.assert.calledWithExactly(installPackage, {
      id: `${teku}@${newHash}`,
      options: { KEEP_STOPPED: true }
    });
  });

  it("updates a crash-looping (restarting) package, so it gets its fix", async () => {
    installed = [pkg(teku, "restarting")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    expect(installPackage.firstCall.args[0].id).to.equal(`${teku}@${newHash}`);
  });

  it("skips a package the user stopped, and logs it", async () => {
    installed = [pkg(teku, "exited")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.notCalled(installPackage);
    expect(logged.join("\n")).to.match(
      new RegExp(`${teku} has an update .* but is stopped \\(state=exited\\)`)
    );
  });

  it("updates a created package: an update whose container failed to start gets its fix", async () => {
    installed = [pkg(teku, "created")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    expect(installPackage.firstCall.args[0].id).to.equal(`${teku}@${newHash}`);
  });

  it("updates a package left created after a failed recreate (exited leftover + created)", async () => {
    installed = [leftover(teku), pkg(teku, "created")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.called(installPackage);
    for (const call of installPackage.getCalls())
      expect(call.args[0].id).to.equal(`${teku}@${newHash}`);
  });

  it("updates a running package next to an exited leftover", async () => {
    installed = [leftover(teku), pkg(teku, "running")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.called(installPackage);
    expect(installPackage.firstCall.args[0].id).to.equal(`${teku}@${newHash}`);
  });

  it("updates a package whose only container is an exited leftover", async () => {
    installed = [leftover(teku)];
    storeHas(teku);
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
  });

  it("updates a stopped core package", async () => {
    const admin = "admin.dnp.dappnode.eth";
    installed = [pkg(admin, "exited", { isCore: true })];
    storeHas(admin);
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    expect(installPackage.firstCall.args[0].id).to.equal(`${admin}@${newHash}`);
  });

  it("a stopped package does not take the hourly update slot", async () => {
    installed = [pkg(teku, "exited"), pkg(nimbus, "running")];
    storeHas(teku, nimbus);
    // The watcher picks one random package per run
    for (let i = 0; i < 10; i++) await runWatcher();
    sinon.assert.callCount(installPackage, 10);
    for (const call of installPackage.getCalls())
      expect(call.args[0].id).to.equal(`${nimbus}@${newHash}`);
  });

  it("logs an install the installer refused as skipped, instead of leaving it unhandled", async () => {
    installed = [pkg(teku, "running")];
    storeHas(teku);
    installPackage.rejects(Error(`Not starting stopped package ${teku}`));
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    expect(logged.join("\n")).to.include(
      `auto-update of ${teku}@${newHash} skipped: Not starting stopped package ${teku}`
    );
    expect(loggedErrors).to.deep.equal([]);
  });

  it("logs a failed install as an error, with its stack", async () => {
    installed = [pkg(teku, "running")];
    storeHas(teku);
    installPackage.rejects(Error("Can't download teku image: timeout"));
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    expect(loggedErrors).to.have.length(1);
    expect(loggedErrors[0]).to.include(
      `auto-update of ${teku}@${newHash} failed: Error: Can't download teku image: timeout`
    );
    expect(loggedErrors[0]).to.include("autoupdate.test.js"); // the stack
  });
});
