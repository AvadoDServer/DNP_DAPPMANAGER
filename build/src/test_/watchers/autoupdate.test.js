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
    error: () => {},
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
  });

  function pkg(name, state, extra = {}) {
    return {
      name,
      version: "0.0.1",
      state,
      isCore: false,
      manifest: { autoupdate: true },
      ...extra
    };
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

  it("skips a created but never started package", async () => {
    installed = [pkg(teku, "created")];
    storeHas(teku);
    await runWatcher();
    sinon.assert.notCalled(installPackage);
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

  it("logs an install the installer refused instead of leaving it unhandled", async () => {
    installed = [pkg(teku, "running")];
    storeHas(teku);
    installPackage.rejects(Error(`Not starting stopped package ${teku}`));
    await runWatcher();
    sinon.assert.calledOnce(installPackage);
    expect(logged.join("\n")).to.include(
      `auto-update of ${teku}@${newHash} did not run: Not starting stopped package ${teku}`
    );
  });
});
