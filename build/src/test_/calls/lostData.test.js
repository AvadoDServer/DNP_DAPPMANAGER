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
   * opts.probe: { [volume]: { entries, kb } | Error } (ls -A and du -sk)
   * opts.duFail: volumes whose du -sk fails
   * opts.inspect: { [volume]: string | Error }
   * opts.copy: stdout of the copy command, or an Error
   * opts.db: initial content of the dappmanager db
   */
  function setup(opts = {}) {
    const commands = [];
    const shell = sinon.stub().callsFake(async cmd => {
      commands.push(cmd);
      if (cmd === "docker volume ls --format '{{.Name}}'") {
        return (opts.volumes || []).join("\n");
      }
      if (cmd.includes("ls -A")) {
        // batched: -v <vol>:/v<i>:ro for each volume
        const mounts = [...cmd.matchAll(/-v (\S+):(\/v\d+):ro/g)];
        const out = [];
        for (const [, vol, dir] of mounts) {
          const p = (opts.probe || {})[vol];
          if (p instanceof Error) throw p;
          out.push(`__VOL__ ${dir}`, ...((p && p.entries) || []));
        }
        return out.join("\n");
      }
      if (cmd.includes(" busybox du -sk /vol")) {
        const vol = cmd.match(/-v (\S+):\/vol:ro/)[1];
        if ((opts.duFail || []).includes(vol)) throw Error("du failed");
        const p = (opts.probe || {})[vol];
        return `${(p && p.kb) || 4}\t/vol`;
      }
      if (cmd.startsWith("docker volume inspect --format '{{.CreatedAt}}' ")) {
        const vol = cmd.split(" ").pop();
        const v = (opts.inspect || {})[vol];
        if (v instanceof Error) throw v;
        return v || "2026-09-01T10:00:00Z";
      }
      if (cmd.includes("avado-recover-tmp")) {
        if (opts.copyHook) await opts.copyHook();
        if (opts.copy instanceof Error) throw opts.copy;
        return opts.copy !== undefined ? opts.copy : "FILES 12\nSKIPPED 0 0\n2048\t/to";
      }
      if (cmd.startsWith("docker rm -f recover-data-")) return "";
      if (cmd.startsWith("docker rm -f lostdata-")) return "";
      throw Error(`unexpected command ${cmd}`);
    });
    const containers = opts.containers || defaultContainers();
    const dockerList = {
      listContainers: sinon.stub().resolves(containers),
      listMountedVolumeNames: sinon.stub().resolves(opts.otherMounts || [])
    };
    const logs = { info: sinon.fake(), warn: sinon.fake(), error: sinon.fake(), debug: sinon.fake() };
    const store = Object.assign({}, opts.db || {});
    const db = {
      get: sinon.fake(async key => store[key]),
      set: sinon.fake(async (key, value) => {
        store[key] = value;
      })
    };
    const lostData = proxyquire("modules/lostData", {
      "utils/shell": shell,
      "modules/dockerList": dockerList,
      "logs.js": () => logs,
      db
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
      db,
      store,
      docker,
      dockerList,
      logs,
      logUi,
      eventBus
    };
  }

  const full = (entries, kb = 100) => ({ entries, kb });
  const probed = t => t.commands.filter(c => c.includes("ls -A"));

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
          confidence: "high",
          createdAt: "2026-09-01T10:00:00Z",
          entries: ["data", ".rocketpool"],
          sizeKb: 300,
          target: RP_LIVE
        },
        {
          name: v1,
          anonymous: false,
          confidence: "high",
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
      expect(
        result.candidates.map(c => [c.name, c.anonymous, c.confidence, c.target])
      ).to.deep.equal([[ANON, true, "low", RP_LIVE]]);
      // one batched, read-only ls over both anonymous volumes and the live one
      expect(probed(t)).to.have.length(1);
      for (const v of [ANON, ANON2, RP_LIVE]) expect(probed(t)[0]).to.match(new RegExp(`-v ${v}:/v\\d+:ro`));
      // du only for the final candidate
      const du = t.commands.filter(c => c.includes("du -sk"));
      expect(du).to.have.length(1);
      expect(du[0]).to.include(`-v ${ANON}:/vol:ro`);
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
        probe: { [RP_LIVE]: full(["wallet"]), [ANON]: full(["wallet"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.live.map(l => l.name)).to.deep.equal([RP_LIVE]);
      expect(result.candidates.map(c => c.name)).to.deep.equal([ANON]);
    });
  });

  describe("scan: compose volume keys", () => {
    const NM = "nethermind.avado.dnp.dappnode.eth";
    const NM_DB = "nethermindavadodnpdappnodeeth_nethermind_db";
    const NM_LOGS = "nethermindavadodnpdappnodeeth_logs";

    it("matches a key that contains _ (nethermind_db) in another project-name spelling", async () => {
      const oldDb = "nethermind-avado-dnp-dappnode-eth_nethermind_db";
      const oldLogs = "nethermind_avado_dnp_dappnode_eth_logs";
      const t = setup({
        volumes: [NM_DB, NM_LOGS, oldDb, oldLogs, "nethermind-avado-dnp-dappnode-eth_db", "nethermind-avado-dnp-dappnode-eth_nethermind"],
        containers: [container(NM, [NM_DB, NM_LOGS])],
        probe: {
          [oldDb]: full(["nethermind_db"]),
          [oldLogs]: full(["log.txt"]),
          "nethermind-avado-dnp-dappnode-eth_db": full(["x"]),
          "nethermind-avado-dnp-dappnode-eth_nethermind": full(["x"])
        }
      });
      const { result } = await t.findLostData({ id: NM });
      expect(result.candidates.map(c => [c.name, c.target, c.confidence])).to.deep.equal([
        [oldDb, NM_DB, "high"],
        [oldLogs, NM_LOGS, "high"]
      ]);
    });

    it("lower-cases the prefix before comparing, and does not ignore extra upper-case letters", async () => {
      const upper = "RocketPool-Avado-Dnp-Dappnode-Eth_rocketpool";
      const extra = "XYZrocketpoolavadodnpdappnodeeth_rocketpool";
      const t = setup({
        volumes: [RP_LIVE, upper, extra],
        containers: [container(RP, [RP_LIVE])],
        probe: { [upper]: full(["data"]), [extra]: full(["data"]) }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates.map(c => c.name)).to.deep.equal([upper]);
    });

    it("needs the same key, not only the same last part", async () => {
      const t = setup({
        volumes: [NM_DB, "nethermind-avado-dnp-dappnode-eth_other_db"],
        containers: [container(NM, [NM_DB])],
        probe: { "nethermind-avado-dnp-dappnode-eth_other_db": full(["x"]) }
      });
      const { result } = await t.findLostData({ id: NM });
      expect(result.candidates).to.deep.equal([]);
      expect(probed(t)).to.deep.equal([]);
    });
  });

  describe("scan: anonymous volumes are low confidence and tightly limited", () => {
    const GETH = "geth.avado.dnp.dappnode.eth";
    const GETH_LIVE = "gethavadodnpdappnodeeth_geth";

    it("(a) are never part of listLostData, and listLostData does not probe them", async () => {
      const t = setup({
        volumes: [RP_LIVE, TEKU_LIVE, ANON],
        containers: [container(RP, [RP_LIVE])],
        probe: { [RP_LIVE]: full(["wallet"]), [ANON]: full(["wallet"]) }
      });
      expect((await t.listLostData()).result).to.deep.equal([]);
      expect(probed(t)).to.deep.equal([]);
      // the package page still shows it, as low confidence
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates.map(c => [c.name, c.confidence])).to.deep.equal([[ANON, "low"]]);
    });

    it("(b) are never offered to validator or consensus client packages", async () => {
      for (const id of [
        TEKU,
        "nimbus.avado.dnp.dappnode.eth",
        "lighthouse.avado.dnp.dappnode.eth",
        "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth",
        "eth2validator.avado.dnp.dappnode.eth",
        "validator-tools.avado.dnp.dappnode.eth"
      ]) {
        const live = "x_" + id.replace(/[^a-z0-9]/g, "");
        const t = setup({
          volumes: [live, ANON],
          containers: [container(id, [live])],
          probe: { [live]: full(["slashing.sqlite"]), [ANON]: full(["slashing.sqlite"]) }
        });
        const { result } = await t.findLostData({ id });
        expect(result.candidates, id).to.deep.equal([]);
        // nothing that could receive it, so nothing is probed
        expect(probed(t), id).to.deep.equal([]);
      }
    });

    it("(c) ignore generic and hidden names when looking for a shared entry", async () => {
      const generic = ["settings.json", "settings", "data", "config", "keys", "logs", "db", "validators", "validator", ".rocketpool", "Data"];
      const t = setup({
        volumes: [RP_LIVE, ANON],
        containers: [container(RP, [RP_LIVE])],
        probe: { [RP_LIVE]: full(generic), [ANON]: full(generic) }
      });
      expect((await t.findLostData({ id: RP })).result.candidates).to.deep.equal([]);

      const t2 = setup({
        volumes: [RP_LIVE, ANON],
        containers: [container(RP, [RP_LIVE])],
        probe: { [RP_LIVE]: full(generic.concat(["backups"])), [ANON]: full(["data", "backups"]) }
      });
      expect((await t2.findLostData({ id: RP })).result.candidates.map(c => c.name)).to.deep.equal([ANON]);
    });

    it("(c) need exactly one live volume", async () => {
      const t = setup({
        volumes: [RP_LIVE, "rocketpoolavadodnpdappnodeeth_eth1", ANON],
        containers: [container(RP, [RP_LIVE, "rocketpoolavadodnpdappnodeeth_eth1"])],
        probe: { [RP_LIVE]: full(["wallet"]), [ANON]: full(["wallet"]) }
      });
      expect((await t.findLostData({ id: RP })).result.candidates).to.deep.equal([]);
    });

    it("(d) are offered to none when they fit two packages", async () => {
      const t = setup({
        volumes: [RP_LIVE, GETH_LIVE, ANON],
        containers: [container(RP, [RP_LIVE]), container(GETH, [GETH_LIVE])],
        probe: { [RP_LIVE]: full(["wallet"]), [GETH_LIVE]: full(["wallet"]), [ANON]: full(["wallet"]) }
      });
      expect((await t.findLostData({ id: RP })).result.candidates).to.deep.equal([]);
      expect((await t.findLostData({ id: GETH })).result.candidates).to.deep.equal([]);
    });

    it("(d) a validator package that fits blocks the offer to another package", async () => {
      const t = setup({
        volumes: [RP_LIVE, TEKU_LIVE, ANON],
        containers: [container(RP, [RP_LIVE]), container(TEKU, [TEKU_LIVE])],
        probe: { [RP_LIVE]: full(["wallet"]), [TEKU_LIVE]: full(["wallet"]), [ANON]: full(["wallet"]) }
      });
      expect((await t.findLostData({ id: RP })).result.candidates).to.deep.equal([]);
    });

    it("(d) one anonymous volume per package when each fits only one", async () => {
      const t = setup({
        volumes: [RP_LIVE, GETH_LIVE, ANON, ANON2],
        containers: [container(RP, [RP_LIVE]), container(GETH, [GETH_LIVE])],
        probe: {
          [RP_LIVE]: full(["wallet"]),
          [GETH_LIVE]: full(["geth"]),
          [ANON]: full(["wallet"]),
          [ANON2]: full(["geth", "keystore"])
        }
      });
      expect((await t.findLostData({ id: RP })).result.candidates.map(c => c.name)).to.deep.equal([ANON]);
      expect((await t.findLostData({ id: GETH })).result.candidates.map(c => c.name)).to.deep.equal([ANON2]);
    });

    it("are offered to none when a single live volume cannot be read", async () => {
      const t = setup({
        volumes: [RP_LIVE, GETH_LIVE, ANON],
        containers: [container(RP, [RP_LIVE]), container(GETH, [GETH_LIVE])],
        probe: { [RP_LIVE]: full(["wallet"]), [GETH_LIVE]: Error("boom"), [ANON]: full(["wallet"]) }
      });
      expect((await t.findLostData({ id: RP })).result.candidates).to.deep.equal([]);
    });

    it("a batch that fails is retried one volume at a time", async () => {
      const t = setup({
        volumes: [RP_LIVE, ANON, ANON2],
        containers: [container(RP, [RP_LIVE])],
        probe: { [RP_LIVE]: full(["wallet"]), [ANON]: full(["wallet"]), [ANON2]: Error("boom") }
      });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates.map(c => c.name)).to.deep.equal([ANON]);
      expect(probed(t)).to.have.length(4);
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

    it("probes with the exact read-only busybox commands: ls, then du only for candidates", async () => {
      const t = setup({ volumes: [RP_LIVE, old], probe: { [old]: full(["data"]) } });
      await t.findLostData({ id: RP });
      const named = t.commands
        .filter(c => c.startsWith("docker run"))
        .map(c => c.replace(/lostdata-(ls|du)-\d+-\d+/, "lostdata-$1-N"));
      expect(named).to.deep.equal([
        `docker run --rm --name lostdata-ls-N -v ${old}:/v0:ro busybox sh -c 'for d in /v0; do echo "__VOL__ $d"; ls -A "$d" | head -50; done'`,
        `docker run --rm --name lostdata-du-N -v ${old}:/vol:ro busybox du -sk /vol`
      ]);
    });

    it("drops a candidate whose du fails", async () => {
      const t = setup({ volumes: [RP_LIVE, old], probe: { [old]: full(["data"]) }, duFail: [old] });
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
    });

    it("removes a failed probe container by name", async () => {
      const t = setup({ volumes: [RP_LIVE, old], probe: { [old]: Error("timed out") } });
      await t.findLostData({ id: RP });
      const ls = probed(t)[0];
      const name = ls.match(/--name (lostdata-ls-\d+-\d+) /)[1];
      expect(t.commands).to.include(`docker rm -f ${name}`);
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
    const { copyScript } = require("calls/recoverLostData");
    const suffixOf = cmd => cmd.match(/(\.avado-recover-tmp-[0-9a-f]{8})"/)[1];
    const old = "rocketpool-avado-dnp-dappnode-eth_rocketpool";
    const base = () => ({ volumes: [RP_LIVE, TEKU_LIVE, old], probe: { [old]: full(["data"], 2048) } });
    const recoverCalls = t => t.commands.filter(c => c.includes("avado-recover-tmp"));

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
      const copy = t.shell.getCalls().filter(c => c.args[0].includes("avado-recover-tmp"));
      expect(copy).to.have.length(1);
      const at = text => t.commands.findIndex(c => c.includes(text));
      expect(at("STOP")).to.be.greaterThan(-1);
      expect(at("STOP")).to.be.lessThan(at("avado-recover-tmp"));
      expect(at("avado-recover-tmp")).to.be.lessThan(at("UP"));
      expect(copy[0].args[0]).to.match(new RegExp(`^docker run --rm --name recover-data-\\d+ `));
      expect(copy[0].args[0].replace(/recover-data-\d+/, "recover-data-N")).to.equal(
        `docker run --rm --name recover-data-N -v ${old}:/from:ro -v ${RP_LIVE}:/to busybox sh -c '${copyScript(suffixOf(copy[0].args[0]))}'`
      );
      expect(copy[0].args[1]).to.deep.equal({ timeout: 10 * 60 * 1000 });

      expect(res.result).to.deep.equal({ files: 12, copied: 12, skipped: 0, sizeKb: 2048 });
      expect(res.message).to.equal(`Recovered 12 files into ${RP_LIVE} from ${old}`);
      expect(res.logMessage).to.equal(true);
      expect(res.userAction).to.equal(true);
      sinon.assert.calledWith(t.eventBus.emit, "emitPackages");
      expect(t.logUi.called).to.equal(true);
      for (const cmd of t.commands) expect(cmd).to.not.match(/docker volume rm|rm -rf|volume prune/);
    });

    it("throws when files could not be copied and still starts the package again", async () => {
      const err0 = Error("Command failed: docker run ...");
      err0.stdout = "FILES 9\nSKIPPED 3 1\nFAILED 2 ./data/wallet\n";
      err0.code = 1;
      const t = setup(Object.assign(base(), { copy: err0 }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.equal(
        "Recovering the data failed: 2 files could not be copied (first: ./data/wallet). Nothing was deleted; contact AVADO support."
      );
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

    it("throws on a FAILED line in a zero-exit output too", async () => {
      const t = setup(Object.assign(base(), { copy: "FILES 3\nSKIPPED 0 0\nFAILED 1 ./x\n10\t/to" }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.match(/^Recovering the data failed: 1 file could not be copied \(first: \.\/x\)\./);
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

    it("refuses a second recovery of the same app while one is running", async () => {
      let release;
      const gate = new Promise(r => (release = r));
      const t = setup(Object.assign(base(), { copyHook: () => gate }));
      const first = t.recoverLostData({ id: RP, volume: old });
      // wait until the first one is copying
      while (!t.commands.some(c => c.includes("avado-recover-tmp"))) {
        await new Promise(r => setImmediate(r));
      }
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.equal("A recovery for this app is already running.");
      release();
      await first;
      // the lock is released: the next call gets past it
      const err2 = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err2.message).to.equal(
        "That volume is not on the list any more. Reload the page and try again."
      );
      expect(recoverCalls(t)).to.have.length(1);
    });

    it("releases the lock when a recovery fails", async () => {
      const t = setup(Object.assign(base(), { copy: Error("boom") }));
      await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.not.include("already running");
    });

    it("the copy script walks with -print0, copies through a temporary name and never deletes", () => {
      const script = copyScript(".avado-recover-tmp-0a1b2c3d");
      expect(script).to.not.include("'");
      expect(script).to.include("find . -mindepth 1 -print0");
      expect(script).to.include('read -r -d ""');
      // a file goes to <name><suffix> first, then mv -n; mv -n returns 0 when
      // it did not move, so the temporary name must be gone afterwards
      expect(script).to.include('t="/to/$f.avado-recover-tmp-0a1b2c3d"');
      expect(script).to.include(
        'if [ -e "$t" ] || [ -L "$t" ]; then false; else cp -af "$f" "$t" && mv -n "$t" "/to/$f" && [ ! -e "$t" ] && [ ! -L "$t" ]; fi'
      );
      expect(script).to.include('[ -L "/to/$p" ]');
      expect(script).to.not.match(/\brm\b|rmdir|unlink|--remove/);
    });

    it("the copy script checks the walk against an independent count", () => {
      const script = copyScript(".avado-recover-tmp-0a1b2c3d");
      expect(script).to.include('found=$(find . -type f -print0 | tr -cd "\\000" | wc -c)');
      expect(script).to.include('if [ "$files" -ne "$found" ]; then echo "FAILED walk $files/$found"; exit 1; fi');
      expect(script).to.include(
        'if [ "$found" -gt 0 ] && [ $((copied+skipped)) = 0 ]; then echo "FAILED walk 0/$found"; exit 1; fi'
      );
    });

    it("the copy script counts a kept key file only when it differs from the old one", () => {
      const script = copyScript(".avado-recover-tmp-0a1b2c3d");
      expect(script).to.include('if [ "$linked" = 1 ] || ! cmp -s "$f" "/to/$f"; then');
    });

    it("refuses a temporary suffix that is not .avado-recover-tmp-<8 hex>", () => {
      for (const bad of ["", ".avado-recover-tmp", ".avado-recover-tmp-0a1b2c3", ".avado-recover-tmp-0a1b2c3d;x", ".x-0a1b2c3d"]) {
        expect(() => copyScript(bad), bad).to.throw();
      }
    });

    it("uses a new random temporary suffix for every run", async () => {
      const suffixes = [];
      for (let i = 0; i < 3; i++) {
        const t = setup(base());
        await t.recoverLostData({ id: RP, volume: old });
        suffixes.push(suffixOf(recoverCalls(t)[0]));
      }
      expect(new Set(suffixes).size).to.equal(3);
    });

    it("fails with a plain message when the walk did not see every file, and does not remember the volume", async () => {
      const err0 = Error("Command failed");
      err0.stdout = "FILES 0\nSKIPPED 0 0\nFAILED walk 0/2\n";
      err0.code = 1;
      const t = setup(Object.assign(base(), { copy: err0 }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.equal(
        "Recovering the data failed: only 0 of the 2 files in the old storage could be read. Nothing was deleted; contact AVADO support."
      );
      expect(t.store.lostDataRecovered).to.equal(undefined);
      sinon.assert.calledOnce(t.docker.safe.compose.up);
    });

    it("fails when the copy output has no FILES line", async () => {
      const t = setup(Object.assign(base(), { copy: "2048\t/to" }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.match(/^Recovering the data failed: the copy did not report what it copied\./);
      expect(t.store.lostDataRecovered).to.equal(undefined);
    });

    it("refuses when the compose file is missing", async () => {
      const t = setup(base());
      const err = await expectThrow(t.recoverLostData({ id: TEKU, volume: old }));
      expect(err.message).to.match(/Nothing was changed/);
      sinon.assert.notCalled(t.docker.compose.stop);
    });

    it("remembers the recovered volume: no longer a candidate, listed under recovered", async () => {
      const t = setup(base());
      await t.recoverLostData({ id: RP, volume: old });
      expect(t.store.lostDataRecovered).to.have.length(1);
      expect(t.store.lostDataRecovered[0]).to.include({ volume: old, package: RP });
      expect(t.store.lostDataRecovered[0].at).to.be.a("string");

      const probesBefore = probed(t).length;
      const { result } = await t.findLostData({ id: RP });
      expect(result.candidates).to.deep.equal([]);
      expect(result.recovered).to.deep.equal([
        { volume: old, at: t.store.lostDataRecovered[0].at }
      ]);
      // a recovered volume is not even probed again
      expect(probed(t).length).to.equal(probesBefore);
      expect((await t.listLostData()).result).to.deep.equal([]);
      // and cannot be recovered a second time
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.equal(
        "That volume is not on the list any more. Reload the page and try again."
      );
    });

    it("keeps other recovered entries and shows each under its own package", async () => {
      const other = "rocketpoolavado-dnp-dappnode-eth_rocketpool";
      const t = setup(
        Object.assign(base(), {
          volumes: [RP_LIVE, TEKU_LIVE, old, other],
          probe: { [old]: full(["data"], 2048), [other]: full(["data"]) },
          db: {
            lostDataRecovered: [
              { volume: "tekuavadodnpdappnodeeth_old_data", package: TEKU, at: "2026-10-01T00:00:00.000Z" },
              { volume: other, package: RP, at: "2026-10-02T00:00:00.000Z" }
            ]
          }
        })
      );
      const before = await t.findLostData({ id: RP });
      expect(before.result.candidates.map(c => c.name)).to.deep.equal([old]);
      expect(before.result.recovered).to.deep.equal([
        { volume: other, at: "2026-10-02T00:00:00.000Z" }
      ]);
      await t.recoverLostData({ id: RP, volume: old });
      expect(t.store.lostDataRecovered.map(r => r.volume)).to.deep.equal([
        "tekuavadodnpdappnodeeth_old_data",
        other,
        old
      ]);
      const teku = await t.findLostData({ id: TEKU });
      expect(teku.result.recovered.map(r => r.volume)).to.deep.equal([
        "tekuavadodnpdappnodeeth_old_data"
      ]);
    });

    it("does not remember a volume when the copy failed", async () => {
      const t = setup(Object.assign(base(), { copy: "FILES 3\nSKIPPED 0 0\nFAILED 1 ./x\n10\t/to" }));
      await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(t.store.lostDataRecovered).to.equal(undefined);
    });

    it("reports files that already existed as skipped, without a warning", async () => {
      const t = setup(Object.assign(base(), { copy: "FILES 12\nSKIPPED 3 0\n2048\t/to" }));
      const res = await t.recoverLostData({ id: RP, volume: old });
      expect(res.result).to.deep.equal({ files: 12, copied: 9, skipped: 3, sizeKb: 2048 });
      // the message counts only the files that were copied
      expect(res.message).to.equal(`Recovered 9 files into ${RP_LIVE} from ${old}`);
    });

    it("warns when a kept file is named like a wallet or password", async () => {
      const t = setup(Object.assign(base(), { copy: "FILES 12\nSKIPPED 3 1\n2048\t/to" }));
      const res = await t.recoverLostData({ id: RP, volume: old });
      expect(res.result).to.deep.equal({
        files: 12,
        copied: 9,
        skipped: 3,
        sizeKb: 2048,
        warning:
          "Some files already existed in the app's storage and were kept; the copy from the old storage was not used for them."
      });
    });

    it("names the 10 minute limit when the copy times out, and still starts the package", async () => {
      const cmd = "docker run --rm --name recover-data-1 -v a:/from:ro -v b:/to busybox sh -c '...'";
      const t = setup(Object.assign(base(), { copy: Error(`cmd "${cmd}" timed out (600000 ms)`) }));
      const err = await expectThrow(t.recoverLostData({ id: RP, volume: old }));
      expect(err.message).to.equal(
        "Recovering the data took longer than 10 minutes and was stopped. Files already copied were kept; contact AVADO support."
      );
      expect(t.commands.some(c => c.startsWith("docker rm -f recover-data-"))).to.equal(true);
      sinon.assert.calledOnce(t.docker.safe.compose.up);
      expect(t.commands.indexOf("UP")).to.be.greaterThan(
        t.commands.findIndex(c => c.startsWith("docker rm -f recover-data-"))
      );
      expect(t.store.lostDataRecovered).to.equal(undefined);
    });
  });
});
