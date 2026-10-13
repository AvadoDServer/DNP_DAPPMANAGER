const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");
const operations = require("modules/operations");

describe("Module: ipfsNode and call getIpfsHealth", function() {
  const CONTAINER = "DAppNodeCore-ipfs.dnp.dappnode.eth";
  const inspectOut = (o = {}) =>
    JSON.stringify([
      {
        Id: o.id || "c1",
        RestartCount: o.restartCount === undefined ? 0 : o.restartCount,
        State: Object.assign(
          { Status: "running", Running: true, Restarting: false, StartedAt: "2026-10-13T08:00:00Z" },
          o.state || {}
        )
      }
    ]);

  function setup({ inspect, logs = "", axiosPost } = {}) {
    const commands = [];
    const shell = sinon.stub().callsFake(async cmd => {
      commands.push(cmd);
      if (cmd === `docker inspect ${CONTAINER}`) {
        const out = typeof inspect === "function" ? inspect() : inspect;
        if (out instanceof Error) throw out;
        return out;
      }
      if (cmd.startsWith(`docker logs --tail 10 ${CONTAINER}`)) return logs;
      throw Error(`unexpected command ${cmd}`);
    });
    const ipfsNode = proxyquire("modules/ipfsNode", {
      "utils/shell": shell,
      axios: { post: axiosPost || sinon.stub().rejects(Error("down")) }
    });
    ipfsNode._resetSamples();
    return { ipfsNode, shell, commands };
  }

  it("a healthy IPFS: no logs read", async () => {
    const t = setup({ inspect: inspectOut() });
    const h = await t.ipfsNode.readHealth();
    expect(h).to.deep.equal({
      exists: true,
      running: true,
      restarting: false,
      restartCount: 0,
      restartsLastHour: 0,
      startedAt: "2026-10-13T08:00:00Z",
      lastLogLines: []
    });
    expect(t.commands).to.deep.equal([`docker inspect ${CONTAINER}`]);
  });

  it("a restarting IPFS: the last 10 log lines, trimmed and without colours", async () => {
    const lines = Array.from({ length: 14 }, (_, i) => `  line ${i}  `);
    lines.push("\u001b[31mError: failed to open repo\u001b[0m", "x".repeat(400), "");
    const t = setup({
      inspect: inspectOut({ restartCount: 7, state: { Status: "restarting", Running: true, Restarting: true } }),
      logs: lines.join("\n")
    });
    const h = await t.ipfsNode.readHealth();
    expect(h.restarting).to.equal(true);
    expect(h.running).to.equal(false);
    expect(h.restartCount).to.equal(7);
    expect(h.lastLogLines).to.have.length(10);
    expect(h.lastLogLines[0]).to.equal("line 6");
    expect(h.lastLogLines[8]).to.equal("Error: failed to open repo");
    expect(h.lastLogLines[9]).to.equal(`${"x".repeat(300)}…`);
  });

  it("counts restarts in the last hour from earlier samples of the same container", async () => {
    let count = 2;
    let id = "c1";
    const t = setup({ inspect: () => inspectOut({ id, restartCount: count }) });
    const t0 = Date.parse("2026-10-13T08:00:00Z");
    expect((await t.ipfsNode.readHealth({ now: t0 })).restartsLastHour).to.equal(0);
    count = 4;
    expect((await t.ipfsNode.readHealth({ now: t0 + 10 * 60 * 1000 })).restartsLastHour).to.equal(2);
    count = 6;
    expect((await t.ipfsNode.readHealth({ now: t0 + 50 * 60 * 1000 })).restartsLastHour).to.equal(4);
    // the first sample is older than an hour now
    expect((await t.ipfsNode.readHealth({ now: t0 + 65 * 60 * 1000 })).restartsLastHour).to.equal(2);
    // a new container (after a reset) counts from 0 again
    id = "c2";
    count = 0;
    expect((await t.ipfsNode.readHealth({ now: t0 + 66 * 60 * 1000 })).restartsLastHour).to.equal(0);
  });

  it("no container: exists false", async () => {
    const t = setup({ inspect: Object.assign(Error("Command failed"), { stderr: "Error: No such object: x" }) });
    const h = await t.ipfsNode.readHealth();
    expect(h.exists).to.equal(false);
    expect(h.lastLogLines).to.deep.equal([]);
  });

  it("another docker error is thrown", async () => {
    const t = setup({ inspect: Error("Cannot connect to the Docker daemon") });
    let err;
    try {
      await t.ipfsNode.readHealth();
    } catch (e) {
      err = e;
    }
    expect(err.message).to.match(/Docker daemon/);
  });

  it("waitForApi: true once `id` answers, false after the limit", async () => {
    let calls = 0;
    const post = sinon.stub().callsFake(async url => {
      expect(url).to.match(/:5001\/api\/v0\/id$/);
      calls++;
      if (calls < 3) throw Error("ECONNREFUSED");
      return { data: { ID: "12D3KooW" } };
    });
    const t = setup({ axiosPost: post });
    expect(await t.ipfsNode.waitForApi(1000, 1)).to.equal(true);
    expect(calls).to.equal(3);

    const t2 = setup({ axiosPost: sinon.stub().rejects(Error("ECONNREFUSED")) });
    expect(await t2.ipfsNode.waitForApi(30, 10)).to.equal(false);
  });

  it("connectStorePeers counts the nodes that answered; countPeers reads swarm/peers", async () => {
    const post = sinon.stub().callsFake(async url => {
      if (url.includes("swarm/connect")) {
        expect(url).to.include(encodeURIComponent("/ip4/80.208.229.228/tcp/4001/p2p/"));
        return { data: { Strings: ["connect ... success"] } };
      }
      if (url.endsWith("swarm/peers")) return { data: { Peers: [{}, {}, {}] } };
      throw Error(url);
    });
    const t = setup({ axiosPost: post });
    expect(await t.ipfsNode.connectStorePeers()).to.equal(1);
    expect(await t.ipfsNode.countPeers()).to.equal(3);

    const t2 = setup({ axiosPost: sinon.stub().rejects(Error("down")) });
    expect(await t2.ipfsNode.connectStorePeers()).to.equal(0);
    expect(await t2.ipfsNode.countPeers()).to.equal(null);
  });

  describe("getIpfsHealth", () => {
    afterEach(() => operations._reset());
    it("adds whether a reset is running", async () => {
      const readHealth = sinon.stub().resolves({ exists: true, running: false, restarting: true, restartCount: 3, restartsLastHour: 3, startedAt: null, lastLogLines: ["x"] });
      const getIpfsHealth = proxyquire("calls/getIpfsHealth", { "modules/ipfsNode": { readHealth } });
      let res = await getIpfsHealth();
      expect(res.message).to.equal("IPFS is restarting");
      expect(res.result.resetRunning).to.equal(false);
      expect(res.result.lastLogLines).to.deep.equal(["x"]);
      const end = operations.begin("resetIpfsData", "ipfs.dnp.dappnode.eth");
      res = await getIpfsHealth();
      end();
      expect(res.result.resetRunning).to.equal(true);
    });
  });

  describe("operations", () => {
    afterEach(() => operations._reset());
    it("tracks an operation until it ends, also when it throws", async () => {
      let inside;
      await operations
        .track("installPackage", "a.dnp.dappnode.eth", async () => {
          inside = operations.isRunning("installPackage", "a.dnp.dappnode.eth");
          throw Error("x");
        })
        .catch(() => {});
      expect(inside).to.equal(true);
      expect(operations.isRunning("installPackage")).to.equal(false);
    });
    it("an install older than its maximum age (2 h) no longer counts as running", () => {
      expect(operations.MAX_AGE.installPackage).to.equal(2 * 60 * 60 * 1000);
      operations.begin("installPackage", "stalled.dnp.dappnode.eth");
      operations.begin("recoverLostData", "b");
      const later = Date.now() + 2 * 60 * 60 * 1000 + 1000;
      expect(operations.list("installPackage", undefined, { now: later })).to.deep.equal([]);
      // other kinds have no maximum age
      expect(operations.list("recoverLostData", undefined, { now: later })).to.have.length(1);
      expect(operations.list("installPackage", undefined, { now: Date.now() + 60 * 60 * 1000 })).to.have.length(1);
    });

    it("a real installPackage is registered while it runs, until it ends", async () => {
      let release;
      const installPackage = proxyquire("calls/installPackage", {
        "utils/isSyncing": async () => false,
        "modules/dappGet": () => new Promise((resolve, reject) => (release = reject))
      });
      const pending = installPackage({ id: "a.dnp.dappnode.eth" }).catch(() => {});
      await new Promise(r => setTimeout(r, 0));
      expect(operations.list("installPackage").map(op => op.id)).to.deep.equal(["a.dnp.dappnode.eth"]);
      release(Error("stalled"));
      await pending;
      expect(operations.list("installPackage")).to.deep.equal([]);
    });

    it("lists by kind and package; two installs at once are both listed", () => {
      const a = operations.begin("installPackage", "a");
      operations.begin("installPackage", "a");
      operations.begin("recoverLostData", "b");
      expect(operations.list("installPackage")).to.have.length(2);
      expect(operations.isRunning("recoverLostData", "a")).to.equal(false);
      a();
      a();
      expect(operations.list("installPackage")).to.have.length(1);
      expect(operations.list()).to.have.length(2);
    });
  });
});
