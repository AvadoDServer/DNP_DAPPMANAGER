const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");
const fs = require("fs");
const getPath = require("utils/getPath");
const validate = require("utils/validate");
const operations = require("modules/operations");

describe("Call function: resetIpfsData", function() {
  const IPFS = "ipfs.dnp.dappnode.eth";
  const CONTAINER = "DAppNodeCore-ipfs.dnp.dappnode.eth";
  const VOL = "dncore_ipfsdnpdappnodeeth_data";
  const EXPORT = "dncore_ipfsdnpdappnodeeth_export";
  const params = { DNCORE_DIR: "test_files/DNCORE_ipfs", REPO_DIR: "test_files/" };
  const dcPath = getPath.dockerCompose(IPFS, params, true);
  // The volume compose would use for that compose file (project "dncoreipfs")
  const EXPECTED_VOL = "dncoreipfs_ipfsdnpdappnodeeth_data";

  const ipfsContainer = (o = {}) =>
    Object.assign(
      {
        name: IPFS,
        isCore: true,
        running: true,
        state: "restarting",
        volumes: [
          { type: "volume", name: EXPORT, mountPath: "/export" },
          { type: "volume", name: VOL, mountPath: "/data/ipfs" }
        ]
      },
      o
    );

  /**
   * The call with docker, shell and the IPFS API stubbed.
   * opts.containers: listContainers result before the reset
   * opts.after: the IPFS container listContainers returns after the start
   * opts.stopFails / markerFails / duFails / emptyFails / leftover / upFails
   * opts.answers: waitForApi result (default true)
   * opts.volumeExists: `docker volume inspect` finds the volume (default true)
   * opts.pending: what the db holds under ipfsResetRunning
   */
  function setup(opts = {}) {
    const commands = [];
    const shell = sinon.stub().callsFake(async cmd => {
      commands.push(cmd);
      if (cmd.startsWith("docker volume inspect")) {
        if (opts.volumeInspectFails) {
          throw Object.assign(Error(`Command failed: ${cmd}`), { stderr: "Cannot connect to the Docker daemon" });
        }
        if (opts.volumeExists === false) {
          throw Object.assign(Error("Command failed"), { stderr: "Error: No such volume: x" });
        }
        return cmd.split(" ").pop();
      }
      if (cmd.startsWith("docker ps -aq --filter name=ipfs-reset-")) return opts.leftoverContainers || "";
      if (cmd.includes("rm -rf /v/*")) {
        if (opts.emptyFails) throw Error(`Command failed: ${cmd}\nrm: busy`);
        return "";
      }
      if (cmd.endsWith("busybox rm -f /v/migrate3")) {
        if (opts.markerFails) throw Error("marker failed");
        return "";
      }
      if (cmd.includes("du -sk /v")) {
        if (opts.duFails) throw Error("du failed");
        return `1258291\t/v`;
      }
      if (cmd.includes("rm -rf /v/*")) {
        if (opts.emptyFails) throw Error(`Command failed: ${cmd}\nrm: busy`);
        return "";
      }
      if (cmd.includes("ls -A /v")) return opts.leftover || "";
      if (/^docker rm -f (ipfs-reset-|[0-9a-f]+)/.test(cmd)) return "";
      throw Error(`unexpected command ${cmd}`);
    });
    const docker = {
      compose: {
        stop: sinon.stub().callsFake(async () => {
          if (opts.stopFails) throw Error("stop failed");
        }),
        up: sinon.stub().callsFake(async () => {
          if (opts.upFails) throw Error("up failed");
        }),
        down: sinon.fake(),
        rm: sinon.fake()
      },
      safe: { compose: { up: sinon.fake() } },
      volume: { rm: sinon.fake() }
    };
    let listed = 0;
    const dockerList = {
      listContainers: async () => {
        listed++;
        if (listed === 1) return opts.containers || [{ name: "other.dnp.dappnode.eth", volumes: [] }, ipfsContainer()];
        return opts.after === null ? [] : [opts.after || ipfsContainer({ state: "running" })];
      }
    };
    let pending = opts.pending || null;
    const db = {
      get: sinon.stub().callsFake(async () => pending),
      set: sinon.stub().callsFake(async (k, v) => {
        if (opts.dbSetFails) throw Error("EROFS: read-only file system, open './dappmanagerdb.json'");
        pending = v;
      }),
      remove: sinon.stub().callsFake(async () => {
        pending = null;
      })
    };
    const ipfsNode = {
      waitForApi: sinon.stub().resolves(opts.answers !== false),
      connectStorePeers: sinon.stub().resolves(1),
      countPeers: sinon.stub().resolves(12)
    };
    const logUi = sinon.fake();
    const call = proxyquire("calls/resetIpfsData", {
      "modules/docker": docker,
      "modules/dockerList": dockerList,
      "modules/ipfsNode": ipfsNode,
      "utils/shell": shell,
      "utils/logUi": logUi,
      db,
      params
    });
    return { call, docker, shell, commands, ipfsNode, logUi, db, pending: () => pending };
  }

  async function run(t) {
    try {
      return { res: await t.call() };
    } catch (e) {
      return { err: e };
    }
  }

  // Nothing but the IPFS data volume is ever written to, and never removed
  function expectSafe(t, vol = VOL) {
    sinon.assert.notCalled(t.docker.compose.down);
    sinon.assert.notCalled(t.docker.compose.rm);
    sinon.assert.notCalled(t.docker.volume.rm);
    for (const cmd of t.commands) {
      expect(cmd).to.not.include(EXPORT);
      expect(cmd).to.not.match(/docker volume rm/);
      if (cmd.includes("docker run")) expect(cmd).to.include(`-v ${vol}:/v`);
      // the IPFS container is stopped, never removed
      expect(cmd).to.not.include(CONTAINER);
    }
  }

  before(() => {
    validate.path(dcPath);
    fs.writeFileSync(dcPath, "docker-compose");
  });
  after(() => {
    fs.unlinkSync(dcPath);
  });
  beforeEach(() => operations._reset());
  afterEach(() => operations._reset());

  it("empties the data volume, starts IPFS and reconnects to the store", async () => {
    const t = setup();
    const { res, err } = await run(t);
    expect(err).to.equal(undefined);
    expect(res.result).to.deep.equal({
      removedKb: 1258291,
      restarted: true,
      peersConnected: 12,
      storePeersConnected: 1
    });
    expect(res.message).to.equal("Deleted 1.3 GB of IPFS storage. IPFS is running again.");
    expect(res.userAction).to.equal(true);

    sinon.assert.calledWith(t.docker.compose.stop, dcPath, { timeout: 300 });
    sinon.assert.calledOnce(t.docker.compose.up);
    sinon.assert.calledWith(t.docker.compose.up, dcPath);
    sinon.assert.calledOnce(t.ipfsNode.connectStorePeers);
    expect(t.ipfsNode.waitForApi.firstCall.args[0]).to.be.at.most(120 * 1000);
    // init marker first, then measure, empty, check, in this order
    const steps = t.commands.map(c =>
      c.includes("rm -rf") ? "empty" : c.includes("migrate3") ? "marker" : c.includes("du -sk") ? "du" : c.includes("ls -A") ? "check" : c
    );
    expect(steps).to.deep.equal(["marker", "du", "empty", "check"]);
    sinon.assert.callOrder(t.docker.compose.stop, t.shell, t.docker.compose.up);
    expect(t.commands[0]).to.match(/^docker run --rm --name ipfs-reset-marker-\d+-\d+ -v dncore_ipfsdnpdappnodeeth_data:\/v busybox rm -f \/v\/migrate3$/);
    const empty = t.commands.find(c => c.includes("rm -rf"));
    expect(empty).to.match(/^docker run --rm --name ipfs-reset-rm-\d+-\d+ -v dncore_ipfsdnpdappnodeeth_data:\/v busybox sh -c 'rm -f \/v\/migrate3; rm -rf \/v\/\* \/v\/\.\[!\.\]\* \/v\/\.\.\?\*'$/);
    // remembered while it ran, cleared at the end
    expect(t.db.set.firstCall.args[0]).to.equal("ipfsResetRunning");
    expect(t.pending()).to.equal(null);
    // measuring and checking mount the volume read-only
    for (const c of t.commands.filter(c => c.includes("du -sk") || c.includes("ls -A"))) {
      expect(c).to.include(`-v ${VOL}:/v:ro`);
    }
    expectSafe(t);
  });

  it("refuses a second reset while one runs", async () => {
    const t = setup();
    const end = operations.begin("resetIpfsData", IPFS);
    const { err } = await run(t);
    end();
    expect(err.message).to.equal("Resetting the IPFS storage is already running.");
    sinon.assert.notCalled(t.docker.compose.stop);
    sinon.assert.notCalled(t.shell);
  });

  it("answers 'already running' to a second click on the same box", async () => {
    const t = setup();
    let release;
    t.docker.compose.stop = sinon.stub().returns(new Promise(r => (release = r)));
    const first = t.call();
    const { err } = await run(t);
    expect(err.message).to.match(/already running/);
    release();
    await first;
    expect(operations.list()).to.deep.equal([]);
  });

  for (const [kind, regex] of [
    ["installPackage", /An app is being installed or updated\. Try again when it is done\. Nothing was changed\./],
    ["resetBeaconData", /Free up space is running/],
    ["recoverLostData", /Data is being recovered/]
  ]) {
    it(`refuses while ${kind} runs`, async () => {
      const t = setup();
      const end = operations.begin(kind, "some.dnp.dappnode.eth");
      const { err } = await run(t);
      end();
      expect(err.message).to.match(regex);
      sinon.assert.notCalled(t.docker.compose.stop);
      sinon.assert.notCalled(t.shell);
    });
  }

  it("IPFS container missing, volume there: empties the volume compose uses and starts IPFS", async () => {
    const t = setup({ containers: [{ name: "other.dnp.dappnode.eth", volumes: [] }] });
    const { res, err } = await run(t);
    expect(err).to.equal(undefined);
    expect(res.result.restarted).to.equal(true);
    sinon.assert.notCalled(t.docker.compose.stop);
    sinon.assert.calledOnce(t.docker.compose.up);
    expect(t.commands[0]).to.equal(`docker volume inspect --format '{{.Name}}' ${EXPECTED_VOL}`);
    expect(t.commands.filter(c => c.includes("rm -rf"))).to.have.length(1);
    expectSafe(t, EXPECTED_VOL);
  });

  it("IPFS container missing and the volume cannot be checked: plain error, nothing changed", async () => {
    const t = setup({ containers: [], volumeInspectFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal("Could not check the IPFS storage. Nothing was changed.");
    expect(err.message).to.not.include("docker");
    sinon.assert.notCalled(t.docker.compose.up);
    sinon.assert.notCalled(t.db.set);
  });

  it("the reset cannot be remembered: refused before IPFS is stopped", async () => {
    const t = setup({ dbSetFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal("Could not prepare the reset. Nothing was changed.");
    sinon.assert.notCalled(t.docker.compose.stop);
    sinon.assert.notCalled(t.docker.compose.up);
    sinon.assert.notCalled(t.shell);
    expect(operations.list()).to.deep.equal([]);
  });

  it("IPFS container and volume both missing: only starts IPFS", async () => {
    const t = setup({ containers: [], volumeExists: false });
    const { res } = await run(t);
    expect(res.message).to.equal("IPFS was set up again. IPFS is running again.");
    expect(t.commands.filter(c => c.includes("docker run"))).to.deep.equal([]);
    sinon.assert.calledOnce(t.docker.compose.up);
  });

  it("refuses a data volume it does not recognise, the export volume included", async () => {
    for (const volumes of [
      [{ type: "volume", name: EXPORT, mountPath: "/data/ipfs" }],
      [{ type: "bind", name: "/srv/ipfs", mountPath: "/data/ipfs" }],
      [{ type: "volume", name: "dncore_ipfsdnpdappnodeeth_data;rm", mountPath: "/data/ipfs" }],
      [{ type: "volume", name: "other_data", mountPath: "/data/ipfs" }],
      []
    ]) {
      const t = setup({ containers: [ipfsContainer({ volumes })] });
      const { err } = await run(t);
      expect(err.message).to.match(/does not store its data in the way this tool expects\. Nothing was changed\./);
      sinon.assert.notCalled(t.docker.compose.stop);
      sinon.assert.notCalled(t.shell);
    }
  });

  it("refuses when the compose file is missing", async () => {
    const t = setup();
    fs.renameSync(dcPath, `${dcPath}.away`);
    try {
      const { err } = await run(t);
      expect(err.message).to.equal("IPFS is missing its configuration. Nothing was changed.");
    } finally {
      fs.renameSync(`${dcPath}.away`, dcPath);
    }
    sinon.assert.notCalled(t.docker.compose.stop);
  });

  it("stop fails: deletes nothing and starts IPFS again", async () => {
    const t = setup({ stopFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal("IPFS could not be stopped. Nothing was deleted; IPFS is being started again.");
    expect(t.commands.filter(c => c.includes("rm -rf"))).to.deep.equal([]);
    sinon.assert.calledOnce(t.docker.compose.up);
    expectSafe(t);
  });

  it("deleting the init marker fails: empties nothing and starts IPFS again", async () => {
    const t = setup({ markerFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal("Deleting the IPFS storage failed. IPFS is being started again.");
    expect(t.commands.filter(c => c.includes("rm -rf"))).to.deep.equal([]);
    sinon.assert.calledOnce(t.docker.compose.up);
    expect(t.pending()).to.equal(null);
  });

  it("measuring fails: still empties, size unknown", async () => {
    const t = setup({ duFails: true });
    const { res } = await run(t);
    expect(res.result.removedKb).to.equal(null);
    expect(res.message).to.equal("Deleted the IPFS storage. IPFS is running again.");
    expect(t.commands.filter(c => /^docker rm -f ipfs-reset-du-/.test(c))).to.have.length(1);
  });

  it("emptying fails: removes the busybox by name, starts IPFS again, no command in the error", async () => {
    const t = setup({ emptyFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal("Deleting the IPFS storage failed. IPFS is being started again.");
    expect(err.message).to.not.include("docker");
    expect(t.commands.filter(c => /^docker rm -f ipfs-reset-rm-/.test(c))).to.have.length(1);
    sinon.assert.calledOnce(t.docker.compose.up);
    expectSafe(t);
  });

  it("something left after emptying: fails and starts IPFS again", async () => {
    const t = setup({ leftover: "blocks\n" });
    const { err } = await run(t);
    expect(err.message).to.equal("Some of the IPFS storage could not be deleted. IPFS is being started again.");
    sinon.assert.calledOnce(t.docker.compose.up);
  });

  it("up fails after emptying: says the storage was emptied and IPFS did not start", async () => {
    const t = setup({ upFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal(
      "IPFS storage was emptied but IPFS did not start again. Restart your AVADO or contact AVADO support."
    );
    sinon.assert.notCalled(t.ipfsNode.waitForApi);
  });

  it("emptying and up both fail: names both", async () => {
    const t = setup({ emptyFails: true, upFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal(
      "Deleting the IPFS storage failed. IPFS did not start again. Restart your AVADO or contact AVADO support."
    );
  });

  it("stop and up both fail: names both", async () => {
    const t = setup({ stopFails: true, upFails: true });
    const { err } = await run(t);
    expect(err.message).to.equal(
      "IPFS could not be stopped. Nothing was deleted. IPFS did not start again. Restart your AVADO or contact AVADO support."
    );
  });

  it("IPFS runs but does not answer within 2 minutes: restarted false", async () => {
    const t = setup({ answers: false });
    const { res } = await run(t);
    expect(res.result.restarted).to.equal(false);
    expect(res.result.peersConnected).to.equal(null);
    expect(res.message).to.equal("Deleted 1.3 GB of IPFS storage. IPFS is still starting.");
    sinon.assert.notCalled(t.ipfsNode.connectStorePeers);
  });

  it("IPFS exited, created or missing after the start: did not start again", async () => {
    for (const after of [
      ipfsContainer({ running: false, state: "exited" }),
      ipfsContainer({ running: true, state: "created" }),
      null
    ]) {
      const t = setup({ answers: false, after });
      const { err } = await run(t);
      expect(err.message).to.match(/^IPFS storage was emptied but IPFS did not start again\./);
    }
  });

  it("IPFS crash-loops on the new repo: not reported as done, even if it answered once", async () => {
    // dockerList calls a restarting container running (its Status is not "Exited")
    for (const answers of [true, false]) {
      const t = setup({ answers, after: ipfsContainer({ running: true, state: "restarting" }) });
      const { res, err } = await run(t);
      expect(res).to.equal(undefined);
      expect(err.message).to.equal(
        "IPFS storage was emptied but IPFS did not start again. Restart your AVADO or contact AVADO support."
      );
      sinon.assert.notCalled(t.ipfsNode.connectStorePeers);
    }
  });

  describe("recoverInterruptedReset (DAPPMANAGER start)", () => {
    it("does nothing when no reset was running", async () => {
      const t = setup();
      expect(await t.call.recoverInterruptedReset()).to.equal(false);
      sinon.assert.notCalled(t.docker.compose.up);
      sinon.assert.notCalled(t.shell);
    });

    it("after an interrupted reset: removes the leftover busybox and starts IPFS", async () => {
      const t = setup({
        pending: { at: "2026-10-13T08:00:00Z" },
        leftoverContainers: "abc123\ndef456\n",
        containers: [ipfsContainer({ state: "running" })]
      });
      expect(await t.call.recoverInterruptedReset()).to.equal(true);
      expect(t.commands).to.deep.equal([
        "docker ps -aq --filter name=ipfs-reset-",
        "docker rm -f abc123 def456"
      ]);
      sinon.assert.calledOnce(t.docker.compose.up);
      sinon.assert.calledWith(t.docker.compose.up, dcPath);
      expect(t.pending()).to.equal(null);
      expect(operations.list()).to.deep.equal([]);
    });
  });

  it("is ready for another reset after a failure", async () => {
    await run(setup({ emptyFails: true }));
    expect(operations.list()).to.deep.equal([]);
    const { res } = await run(setup());
    expect(res.result.restarted).to.equal(true);
  });

  it("resetBeaconData and recoverLostData register themselves while they run", async () => {
    const seen = [];
    const dockerList = {
      listContainers: async () => {
        seen.push(operations.list().map(op => op.kind));
        return [];
      }
    };
    const resetBeaconData = proxyquire("calls/resetBeaconData", { "modules/dockerList": dockerList });
    await resetBeaconData({ id: "teku.avado.dnp.dappnode.eth" }).catch(() => {});
    const recoverLostData = proxyquire("calls/recoverLostData", { "modules/dockerList": dockerList });
    await recoverLostData({ id: "some.dnp.dappnode.eth", volume: "v" }).catch(() => {});
    expect(seen).to.deep.equal([["resetBeaconData"], ["recoverLostData"]]);
    expect(operations.list()).to.deep.equal([]);
  });

  describe("installPackage while the reset runs", () => {
    it("is refused in plain words", async () => {
      const installPackage = proxyquire("calls/installPackage", {});
      const end = operations.begin("resetIpfsData", IPFS);
      let err;
      try {
        await installPackage({ id: "some.dnp.dappnode.eth" });
      } catch (e) {
        err = e;
      }
      end();
      expect(err.message).to.match(/^The IPFS storage is being reset/);
    });
  });

  describe("command builders", () => {
    const { emptyCommand, sizeCommand, leftCommand, markerCommand } = require("calls/resetIpfsData");
    it("only take the IPFS data volume", () => {
      for (const build of [emptyCommand, sizeCommand, leftCommand, markerCommand]) {
        expect(() => build("n", VOL)).to.not.throw();
        for (const v of [EXPORT, "teku_data", "x; rm -rf /", "", undefined, `${VOL} -v /:/host`]) {
          expect(() => build("n", v)).to.throw("unexpected volume name");
        }
      }
    });
  });
});
