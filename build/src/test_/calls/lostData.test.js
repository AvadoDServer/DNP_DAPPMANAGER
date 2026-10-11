const proxyquire = require("proxyquire");
const chai = require("chai");
const expect = require("chai").expect;
const sinon = require("sinon");
const fs = require("fs");
const getPath = require("utils/getPath");
const validate = require("utils/validate");

chai.should();

describe("Call functions: listLostData, findLostData, recoverLostData", function() {
  const params = {
    DNCORE_DIR: "DNCORE",
    REPO_DIR: "test_files/"
  };
  const createdFiles = [];

  function writeCompose(id) {
    const p = getPath.dockerCompose(id, params);
    validate.path(p);
    fs.writeFileSync(p, "docker-compose");
    createdFiles.push(p);
    return getPath.dockerComposeSmart(id, params);
  }

  const RP = "rocketpool.avado.dnp.dappnode.eth";
  const RP_LIVE = "rocketpoolavadodnpdappnodeeth_rocketpool";
  const TEKU = "teku.avado.dnp.dappnode.eth";
  const TEKU_LIVE = "tekuavadodnpdappnodeeth_data";
  const ANON = "a".repeat(64);
  const ANON2 = "b".repeat(64);

  const container = (name, volumes, extra = {}) =>
    Object.assign(
      {
        name,
        isCore: false,
        running: true,
        volumes: volumes.map(v =>
          typeof v === "string"
            ? { type: "volume", name: v, path: `/var/lib/docker/volumes/${v}/_data`, mountPath: "/data" }
            : v
        )
      },
      extra
    );

  const defaultContainers = () => [
    container(RP, [RP_LIVE, { type: "bind", name: undefined, path: "/etc/hosts" }]),
    container(TEKU, [TEKU_LIVE]),
    container("dappmanager.dnp.dappnode.eth", ["dncore_dappmanagerdnpdappnodeeth_data"], { isCore: true })
  ];

  /**
   * opts.volumes: output lines of `docker volume ls`
   * opts.containers: dockerList.listContainers() result
   * opts.otherMounts: volume names mounted by containers that are not packages
   * opts.probe: { [volume]: { entries, kb } | Error }
   * opts.inspect: { [volume]: string | Error }
   * opts.copy: stdout of the copy command, or an Error
   */
  function setup(opts = {}) {
    const commands = [];
    const shell = sinon.stub().callsFake(async cmd => {
      commands.push(cmd);
      if (cmd === "docker volume ls --format '{{.Name}}'") {
        return (opts.volumes || []).join("\n");
      }
      if (cmd.includes("__SIZE__")) {
        const vol = cmd.match(/^docker run --rm -v (\S+):\/vol:ro busybox /)[1];
        const p = (opts.probe || {})[vol];
        if (p instanceof Error) throw p;
        if (!p) return `__SIZE__\n4\t/vol`;
        return `${p.entries.join("\n")}\n__SIZE__\n${p.kb}\t/vol`;
      }
      if (cmd.startsWith("docker volume inspect --format '{{.CreatedAt}}' ")) {
        const vol = cmd.split(" ").pop();
        const v = (opts.inspect || {})[vol];
        if (v instanceof Error) throw v;
        return v || "2026-09-01T10:00:00Z";
      }
      if (cmd.includes("cp -an")) {
        if (opts.copy instanceof Error) throw opts.copy;
        return opts.copy !== undefined ? opts.copy : "12\n2048\t/to";
      }
      if (cmd.startsWith("docker rm -f recover-data-")) return "";
      throw Error(`unexpected command ${cmd}`);
    });
    const containers = opts.containers || defaultContainers();
    const dockerList = {
      listContainers: sinon.stub().resolves(containers),
      listMountedVolumeNames: sinon.stub().resolves(opts.otherMounts || [])
    };
    const logs = { info: sinon.fake(), warn: sinon.fake(), error: sinon.fake(), debug: sinon.fake() };
    const lostData = proxyquire("modules/lostData", {
      "utils/shell": shell,
      "modules/dockerList": dockerList,
      "logs.js": () => logs
    });
    // stop and up are recorded in `commands` too, to check the order
    const docker = {
      safe: { compose: { up: sinon.fake(async () => commands.push("UP")) } },
      compose: { stop: sinon.fake(async () => commands.push("STOP")) }
    };
    const logUi = sinon.fake();
    const eventBus = { emit: sinon.fake() };
    const deps = {
      "modules/lostData": lostData,
      "modules/docker": docker,
      "modules/dockerList": dockerList,
      "utils/shell": shell,
      "utils/logUi": logUi,
      "logs.js": () => logs,
      eventBus: { eventBus, eventBusTag: { emitPackages: "emitPackages" } },
      params
    };
    return {
      lostData,
      listLostData: proxyquire("calls/listLostData", deps),
      findLostData: proxyquire("calls/findLostData", deps),
      recoverLostData: proxyquire("calls/recoverLostData", deps),
      shell,
      commands,
      docker,
      dockerList,
      logs,
      logUi,
      eventBus
    };
  }

  const full = (entries, kb = 100) => ({ entries, kb });
  const probed = t => t.commands.filter(c => c.includes("__SIZE__"));

  let rpCompose;
  before(() => {
    rpCompose = writeCompose(RP);
  });
  after(() => {
    createdFiles.forEach(p => fs.unlinkSync(p));
  });

  describe("scan: name match", () => {
    it("matches the compose v1 and v2 project-name variants of the same short name", async () => {
      const v2 = "rocketpool-avado-dnp-dappnode-eth_rocketpool";
      const v1 = "rocketpool_avado.dnp.dappnode.eth_rocketpool";
      const t = setup({
        volumes: [RP_LIVE, TEKU_LIVE, v2, v1],
        probe: { [v2]: full(["data", ".rocketpool"], 300), [v1]: full(["data"], 7) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.package).to.equal(RP);
      expect(result.live).to.deep.equal([{ name: RP_LIVE, mountPath: "/data" }]);
      expect(result.candidates).to.deep.equal([
        {
          name: v2,
          anonymous: false,
          createdAt: "2026-09-01T10:00:00Z",
          entries: ["data", ".rocketpool"],
          sizeKb: 300,
          target: RP_LIVE
        },
        {
          name: v1,
          anonymous: false,
          createdAt: "2026-09-01T10:00:00Z",
          entries: ["data"],
          sizeKb: 7,
          target: RP_LIVE
        }
      ]);
    });

    it("does not match a volume of another package or a different short name", async () => {
      const t = setup({
        // the teku volume is unused here: teku is not installed
        volumes: [RP_LIVE, TEKU_LIVE, "rocketpoolavadodnpdappnodeeth_other", "xrocketpoolavadodnpdappnodeeth_rocketpool"],
        containers: [container(RP, [RP_LIVE])],
        probe: {
          [TEKU_LIVE]: full(["beacon"]),
          rocketpoolavadodnpdappnodeeth_other: full(["x"]),
          xrocketpoolavadodnpdappnodeeth_rocketpool: full(["x"])
        }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
      // nothing matched, so nothing was probed
      expect(probed(t)).to.deep.equal([]);
    });

    it("excludes a volume mounted by any container, also a stopped one or a non-package one", async () => {
      const old = "rocketpool-avado-dnp-dappnode-eth_rocketpool";
      const other = "rocketpool.avado.dnp.dappnode.eth_rocketpool";
      const t = setup({
        volumes: [RP_LIVE, old, other],
        containers: [
          container(RP, [RP_LIVE]),
          container("leftover.dnp.dappnode.eth", [old], { running: false, state: "exited" })
        ],
        otherMounts: [other],
        probe: { [old]: full(["data"]), [other]: full(["data"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
      expect(probed(t)).to.deep.equal([]);
    });
  });

  describe("scan: anonymous volumes", () => {
    it("includes one with an entry in common with the single live volume", async () => {
      const t = setup({
        volumes: [RP_LIVE, ANON, ANON2],
        containers: [container(RP, [RP_LIVE])],
        probe: {
          [RP_LIVE]: full(["user-settings.yml"]),
          [ANON]: full(["data", "user-settings.yml"], 50),
          [ANON2]: full(["chaindata"], 9000)
        }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates.map(c => [c.name, c.anonymous, c.target])).to.deep.equal([
        [ANON, true, RP_LIVE]
      ]);
      // the live volume is probed once, read-only
      expect(probed(t).filter(c => c.includes(`-v ${RP_LIVE}:/vol:ro `))).to.have.length(1);
    });

    it("excludes anonymous volumes when the package has more than one live volume", async () => {
      const t = setup({
        volumes: [RP_LIVE, "rocketpoolavadodnpdappnodeeth_eth1", ANON],
        containers: [container(RP, [RP_LIVE, "rocketpoolavadodnpdappnodeeth_eth1"])],
        probe: { [RP_LIVE]: full(["data"]), [ANON]: full(["data"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
      expect(probed(t)).to.deep.equal([]);
    });

    it("excludes an anonymous volume with no entry in common", async () => {
      const t = setup({
        volumes: [RP_LIVE, ANON],
        containers: [container(RP, [RP_LIVE])],
        probe: { [RP_LIVE]: full(["data"]), [ANON]: full(["geth"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
    });

    it("does not count a mounted anonymous volume as a live volume", async () => {
      const t = setup({
        volumes: [RP_LIVE, ANON, ANON2],
        containers: [container(RP, [RP_LIVE, ANON2])],
        probe: { [RP_LIVE]: full(["data"]), [ANON]: full(["data"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.live.map(l => l.name)).to.deep.equal([RP_LIVE]);
      expect(result.candidates.map(c => c.name)).to.deep.equal([ANON]);
    });
  });

  describe("scan: probes", () => {
    const old = "rocketpool-avado-dnp-dappnode-eth_rocketpool";

    it("drops an empty volume", async () => {
      const t = setup({ volumes: [RP_LIVE, old], probe: { [old]: full([], 4) } });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
    });

    it("drops a volume whose probe fails, and logs it", async () => {
      const t = setup({ volumes: [RP_LIVE, old], probe: { [old]: Error("boom") } });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
      sinon.assert.calledWithMatch(t.logs.warn, sinon.match(old));
    });

    it("sets createdAt to null when inspect fails", async () => {
      const t = setup({
        volumes: [RP_LIVE, old],
        probe: { [old]: full(["data"]) },
        inspect: { [old]: Error("no such volume") }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.have.length(1);
      expect(result.candidates[0].createdAt).to.equal(null);
    });

    it("probes with the exact read-only busybox command", async () => {
      const t = setup({ volumes: [RP_LIVE, old], probe: { [old]: full(["data"]) } });
      await t.findLostData({ id: RP });
      expect(probed(t)).to.deep.equal([
        `docker run --rm -v ${old}:/vol:ro busybox sh -c 'ls -A /vol | head -50; echo __SIZE__; du -sk /vol'`
      ]);
    });

    it("costs one volume ls and the container list on a healthy box", async () => {
      const t = setup({ volumes: [RP_LIVE, TEKU_LIVE] });
      const { result } = await t.listLostData();
      expect(result).to.deep.equal([]);
      expect(t.commands).to.deep.equal(["docker volume ls --format '{{.Name}}'"]);
    });
  });

  describe("validation", () => {
    it("never puts a volume name with a space or ; into a command", async () => {
      // each of these would be a name match without the validation
      const bad = [
        "rocketpool avado.dnp.dappnode.eth_rocketpool",
        "rocketpool;avado.dnp.dappnode.eth_rocketpool",
        "rocketpool.avado.dnp.dappnode.eth$(touch)_rocketpool"
      ];
      const t = setup({ volumes: [RP_LIVE].concat(bad) });
      const { result } = await t.listLostData();
      expect(result).to.deep.equal([]);
      for (const cmd of t.commands) {
        for (const b of bad) expect(cmd).to.not.include(b);
        expect(cmd).to.not.match(/;avado|\$\(/);
      }
      for (const call of t.shell.getCalls()) {
        for (const b of bad) expect(call.args[0]).to.not.include(b);
      }
      expect(t.logs.warn.called).to.equal(true);
    });

    it("ignores a live volume with an unexpected name", async () => {
      const badLive = "rocketpool;x_data";
      const t = setup({
        volumes: [badLive, ANON],
        containers: [container(RP, [badLive])],
        probe: { [ANON]: full(["data"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.live).to.deep.equal([]);
      for (const cmd of t.commands) expect(cmd).to.not.include(badLive);
    });

    it("recoverLostData refuses a volume name that is not a candidate, before any command", async () => {
      const t = setup({ volumes: [RP_LIVE] });
      let err;
      try {
        await t.recoverLostData({ id: RP, volume: "x; docker volume rm y" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal(
        "That volume is not on the list any more. Reload the page and try again."
      );
      for (const cmd of t.commands) expect(cmd).to.not.include("docker volume rm");
    });
  });

  describe("listLostData and findLostData", () => {
    it("skips core packages and returns only packages with candidates", async () => {
      const coreOld = "dncore-dappmanagerdnpdappnodeeth_data";
      const rpOld = "rocketpool-avado-dnp-dappnode-eth_rocketpool";
      const t = setup({
        volumes: [RP_LIVE, TEKU_LIVE, rpOld, coreOld, "dappmanagerdnpdappnodeeth_data"],
        probe: {
          [rpOld]: full(["data"]),
          dappmanagerdnpdappnodeeth_data: full(["x"]),
          [coreOld]: full(["x"])
        }
      });
      const res = await t.listLostData();
      expect(res.message).to.be.a("string");
      expect(res.result.map(e => e.package)).to.deep.equal([RP]);
      expect(res.result[0].title).to.equal("Rocketpool");
      expect(res.result[0].candidates.map(c => c.name)).to.deep.equal([rpOld]);
      expect(t.commands.join("\n")).to.not.include("dappmanagerdnpdappnodeeth_data");
    });

    it("findLostData requires an id", async () => {
      const t = setup();
      let err;
      try {
        await t.findLostData({});
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(Error);
    });

    it("findLostData returns no candidates for a package without lost data", async () => {
      const t = setup({ volumes: [RP_LIVE, TEKU_LIVE] });
      const { result } = await t.findLostData({ id: TEKU });
      expect(result.package).to.equal(TEKU);
      expect(result.candidates).to.deep.equal([]);
    });
  });

  describe("recoverLostData", () => {
    const old = "rocketpool-avado-dnp-dappnode-eth_rocketpool";
    const base = () => ({ volumes: [RP_LIVE, TEKU_LIVE, old], probe: { [old]: full(["data"], 2048) } });
    const recoverCalls = t => t.commands.filter(c => c.includes("cp -an"));

    async function expectThrow(promise) {
      let err;
      try {
        await promise;
      } catch (e) {
        err = e;
      }
      expect(err, "should have thrown").to.be.instanceOf(Error);
      return err;
    }

    it("refuses a volume that is not on the list without stopping or copying", async () => {
      const t = setup(base());
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: TEKU_LIVE }));
      expect(err.message).to.equal(
        "That volume is not on the list any more. Reload the page and try again."
      );
      expect(recoverCalls(t)).to.deep.equal([]);
      sinon.assert.notCalled(t.docker.compose.stop);
      sinon.assert.notCalled(t.docker.safe.compose.up);
    });

    it("refuses core packages and the dappmanager", async () => {
      const t = setup(
        Object.assign(base(), {
          containers: defaultContainers().concat([
            container("bind.dnp.dappnode.eth", ["dncore_binddnpdappnodeeth_data"], { isCore: true })
          ])
        })
      );
      for (const id of ["dappmanager.dnp.dappnode.eth", "bind.dnp.dappnode.eth"]) {
        const err = await expectThrow(t.recoverLostData({ id, volume: old }));
        expect(err.message).to.match(/Nothing was changed/);
      }
      expect(recoverCalls(t)).to.deep.equal([]);
      sinon.assert.notCalled(t.docker.compose.stop);
    });

    it("requires id and volume", async () => {
      const t = setup(base());
      await expectThrow(t.recoverLostData({ volume: old }));
      await expectThrow(t.recoverLostData({ id: RP }));
      sinon.assert.notCalled(t.shell);
    });

    it("stops, copies without overwriting, starts again, and reports what it copied", async () => {
      const t = setup(base());
      const res = await t.recoverLostData({ id: RP, volume: old });

      sinon.assert.calledWith(t.docker.compose.stop, rpCompose);
      sinon.assert.calledWith(t.docker.safe.compose.up, rpCompose);
      const copy = t.shell.getCalls().filter(c => c.args[0].includes("cp -an"));
      expect(copy).to.have.length(1);
      const at = text => t.commands.findIndex(c => c.includes(text));
      expect(at("STOP")).to.be.greaterThan(-1);
      expect(at("STOP")).to.be.lessThan(at("cp -an"));
      expect(at("cp -an")).to.be.lessThan(at("UP"));
      expect(copy[0].args[0]).to.match(new RegExp(`^docker run --rm --name recover-data-\\d+ `));
      expect(copy[0].args[0].replace(/recover-data-\d+/, "recover-data-N")).to.equal(
        `docker run --rm --name recover-data-N -v ${old}:/from:ro -v ${RP_LIVE}:/to busybox sh -c '` +
          `cd /from && find . -mindepth 1 | while IFS= read -r f; do [ -e "/to/$f" ] || [ -L "/to/$f" ] || cp -an "$f" "/to/$f" || exit 1; done` +
          ` && find . -type f | while IFS= read -r f; do [ -e "/to/$f" ] || { echo "MISSING $f"; exit 1; }; done` +
          ` && find . -type f | wc -l && du -sk /to'`
      );
      expect(copy[0].args[1]).to.deep.equal({ timeout: 10 * 60 * 1000 });

      expect(res.result).to.deep.equal({ files: 12, sizeKb: 2048 });
      expect(res.message).to.equal(`Recovered 12 files into ${RP_LIVE} from ${old}`);
      expect(res.logMessage).to.equal(true);
      expect(res.userAction).to.equal(true);
      sinon.assert.calledWith(t.eventBus.emit, "emitPackages");
      expect(t.logUi.called).to.equal(true);
      for (const cmd of t.commands) expect(cmd).to.not.match(/docker volume rm|rm -rf|volume prune/);
    });

    it("throws on a MISSING file and still starts the package again", async () => {
      const err0 = Error("Command failed: docker run ...");
      err0.stdout = "MISSING ./data/wallet\n";
      err0.code = 1;
      const t = setup(Object.assign(base(), { copy: err0 }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.match(/^Recovering the data failed: MISSING \.\/data\/wallet\./);
      expect(err.message).to.include("contact AVADO support");
      sinon.assert.calledWith(t.docker.safe.compose.up, rpCompose);
      sinon.assert.calledWith(t.eventBus.emit, "emitPackages");
      // the throwaway container is removed by name before the start
      const rmf = t.commands.find(c => c.startsWith("docker rm -f recover-data-"));
      expect(rmf).to.be.a("string");
      expect(t.commands.indexOf(rmf)).to.be.lessThan(t.commands.indexOf("UP"));
      expect(t.commands.indexOf("STOP")).to.be.lessThan(t.commands.indexOf(rmf));
      expect(recoverCalls(t)[0]).to.include(`--name ${rmf.replace("docker rm -f ", "")} `);
      for (const cmd of t.commands) expect(cmd).to.not.match(/docker volume rm|rm -rf|volume prune/);
    });

    it("throws on a MISSING line in a zero-exit output too", async () => {
      const t = setup(Object.assign(base(), { copy: "MISSING ./x\n3\n10\t/to" }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.match(/^Recovering the data failed: MISSING \.\/x\./);
      sinon.assert.calledOnce(t.docker.safe.compose.up);
    });

    it("throws with the first error line when the copy fails", async () => {
      const err0 = Error("Command failed: docker run --rm ...\ncp: write error: No space left on device");
      err0.stdout = "";
      err0.stderr = "cp: write error: No space left on device\nmore";
      const t = setup(Object.assign(base(), { copy: err0 }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.match(
        /^Recovering the data failed: cp: write error: No space left on device\./
      );
      sinon.assert.calledOnce(t.docker.safe.compose.up);
    });

    it("starts the package again when the stop fails", async () => {
      const t = setup(base());
      t.docker.compose.stop = sinon.fake.rejects(Error("stop failed"));
      await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(recoverCalls(t)).to.deep.equal([]);
      sinon.assert.calledOnce(t.docker.safe.compose.up);
    });

    it("refuses when the compose file is missing", async () => {
      const t = setup(base());
      const err = await expectThrow(t.recoverLostData({ id: TEKU, volume: old }));
      expect(err.message).to.match(/Nothing was changed/);
      sinon.assert.notCalled(t.docker.compose.stop);
    });
  });
});
