const proxyquire = require("proxyquire");
const chai = require("chai");
const expect = require("chai").expect;
const sinon = require("sinon");
const fs = require("fs");
const getPath = require("utils/getPath");
const validate = require("utils/validate");

chai.should();

describe("Call function: resetBeaconData", function() {
  const params = {
    DNCORE_DIR: "DNCORE",
    REPO_DIR: "test_files/"
  };
  const VOL = "teku_data";
  const createdFiles = [];

  function writeCompose(id) {
    const p = getPath.dockerCompose(id, params);
    validate.path(p);
    fs.writeFileSync(p, "docker-compose");
    createdFiles.push(p);
    return getPath.dockerComposeSmart(id, params);
  }

  /**
   * Builds the call with every dependency stubbed.
   * opts.settings: string returned for `cat settings.json` (or Error)
   * opts.existing: paths (relative to the volume) that exist
   * opts.rmFails: make the delete command fail
   * opts.volumes: override volumes of the container
   */
  function setup(id, opts = {}) {
    const existing = new Set(opts.existing || []);
    const commands = [];
    const shell = sinon.stub().callsFake(async cmd => {
      commands.push(cmd);
      if (cmd.includes("cat /vol/settings.json")) {
        if (opts.settings instanceof Error) throw opts.settings;
        return opts.settings;
      }
      if (cmd.includes("ls -d")) {
        return [...existing].map(p => `/vol/${p}`).join("\n");
      }
      if (cmd.includes("du -sk")) {
        return [...existing].map(p => `1000000\t/vol/${p}`).join("\n");
      }
      if (cmd.includes("rm -rf")) {
        if (opts.rmFails) throw Error("boom /vol/secret/path");
        existing.clear();
        return "";
      }
      if (cmd.startsWith("docker rm -f reset-beacon-")) return "";
      throw Error(`unexpected command ${cmd}`);
    });
    const docker = {
      safe: { compose: { up: sinon.fake() } },
      compose: { stop: sinon.fake(), rm: sinon.fake() }
    };
    const dockerList = {
      listContainers: async () => [
        { name: "other.dnp.dappnode.eth", volumes: [{ type: "volume", name: "x" }] },
        {
          name: id,
          running: opts.runningAfter !== false,
          volumes: opts.volumes || [
            { type: "volume", name: VOL, path: "/data" },
            { type: "bind", name: "/etc/hosts", path: "/etc/hosts" }
          ]
        }
      ]
    };
    const logUi = sinon.fake();
    const call = proxyquire("calls/resetBeaconData", {
      "modules/docker": docker,
      "modules/dockerList": dockerList,
      "utils/shell": shell,
      "utils/logUi": logUi,
      params: params
    });
    return { call, docker, shell, commands, logUi };
  }

  const settingsOf = (o = {}) =>
    JSON.stringify(
      Object.assign(
        { network: "mainnet", initial_state: "https://sync.example.org" },
        o
      )
    );

  const TEKU = "teku.avado.dnp.dappnode.eth";
  let tekuCompose;
  before(() => {
    tekuCompose = writeCompose(TEKU);
  });
  after(() => {
    createdFiles.forEach(p => fs.unlinkSync(p));
  });

  describe("path table", () => {
    const { BEACON_DATA } = require("calls/resetBeaconData");
    it("teku and lighthouse delete only data-<net>/beacon", () => {
      for (const id of Object.keys(BEACON_DATA)) {
        if (/^(teku|lighthouse)/.test(id)) {
          expect(BEACON_DATA[id].paths("mainnet")).to.deep.equal([
            "data-mainnet/beacon"
          ]);
          expect(BEACON_DATA[id].paths("gnosis")).to.deep.equal([
            "data-gnosis/beacon"
          ]);
        }
      }
    });
    it("nimbus deletes only data-<net>/db", () => {
      for (const id of Object.keys(BEACON_DATA)) {
        if (/^nimbus/.test(id)) {
          expect(BEACON_DATA[id].paths("holesky")).to.deep.equal([
            "data-holesky/db"
          ]);
        }
      }
    });
    it("prysm deletes beaconchaindata, blobs and data-columns", () => {
      expect(
        BEACON_DATA["prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth"].paths(
          "mainnet"
        )
      ).to.deep.equal(["beaconchaindata", "blobs", "data-columns"]);
    });
    it("covers exactly the supported packages, not the validator", () => {
      expect(Object.keys(BEACON_DATA).sort()).to.deep.equal(
        [
          "teku.avado.dnp.dappnode.eth",
          "teku-gnosis.avado.dnp.dappnode.eth",
          "teku-holesky.avado.dnp.dappnode.eth",
          "teku-prater.avado.dnp.dappnode.eth",
          "lighthouse.avado.dnp.dappnode.eth",
          "lighthouse-gnosis.avado.dnp.dappnode.eth",
          "lighthouse-holesky.avado.dnp.dappnode.eth",
          "nimbus.avado.dnp.dappnode.eth",
          "nimbus-holesky.avado.dnp.dappnode.eth",
          "nimbus-prater.avado.dnp.dappnode.eth",
          "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth"
        ].sort()
      );
    });
  });

  async function expectRefusal(t, id, regex) {
    let err;
    try {
      await t.call({ id });
    } catch (e) {
      err = e;
    }
    expect(err, "should have thrown").to.be.instanceOf(Error);
    expect(err.message).to.match(regex);
    expect(err.message).to.not.include("/vol");
    sinon.assert.notCalled(t.docker.compose.stop);
    sinon.assert.notCalled(t.docker.compose.rm);
    sinon.assert.notCalled(t.docker.safe.compose.up);
    expect(t.commands.filter(c => c.includes("rm -rf"))).to.deep.equal([]);
  }

  it("refuses an unknown package without calling stop, rm or shell", async () => {
    const t = setup("eth2validator.avado.dnp.dappnode.eth");
    await expectRefusal(t, "eth2validator.avado.dnp.dappnode.eth", /not a consensus client/);
    sinon.assert.notCalled(t.shell);
  });

  it("refuses when initial_state is an empty string", async () => {
    const t = setup(TEKU, {
      settings: settingsOf({ initial_state: " " }),
      existing: ["data-mainnet/beacon"]
    });
    await expectRefusal(t, TEKU, /no checkpoint sync address/);
  });

  it("refuses when initial_state is missing", async () => {
    const t = setup(TEKU, {
      settings: JSON.stringify({ network: "mainnet" }),
      existing: ["data-mainnet/beacon"]
    });
    await expectRefusal(t, TEKU, /no checkpoint sync address/);
  });

  it("refuses when settings.json is invalid or unreadable", async () => {
    await expectRefusal(setup(TEKU, { settings: "not json" }), TEKU, /Could not read/);
    await expectRefusal(
      setup(TEKU, { settings: Error("no such file") }),
      TEKU,
      /Could not read/
    );
  });

  it("refuses a network value with unexpected characters", async () => {
    for (const network of ["main net", "../x", "mainnet; rm -rf /", "", "Main", 5]) {
      const t = setup(TEKU, {
        settings: settingsOf({ network }),
        existing: ["data-mainnet/beacon"]
      });
      await expectRefusal(t, TEKU, /network/);
    }
  });

  it("refuses when the container has no single named volume", async () => {
    const t = setup(TEKU, { volumes: [{ type: "bind", name: "/a" }] });
    await expectRefusal(t, TEKU, /Nothing was changed/);
    const t2 = setup(TEKU, {
      volumes: [{ type: "volume", name: "a" }, { type: "volume", name: "b" }]
    });
    await expectRefusal(t2, TEKU, /Nothing was changed/);
  });

  it("refuses when none of the listed paths exist", async () => {
    const t = setup(TEKU, { settings: settingsOf(), existing: [] });
    await expectRefusal(t, TEKU, /no beacon data to delete/);
  });

  it("refuses when the compose file is missing", async () => {
    // an id no other test writes a compose file for
    const id = "teku-prater.avado.dnp.dappnode.eth";
    const t = setup(id, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"]
    });
    await expectRefusal(t, id, /missing its configuration/);
  });

  it("deletes only the beacon folder of Teku mainnet, then starts it", async () => {
    const t = setup(TEKU, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"]
    });
    const res = await t.call({ id: TEKU });

    sinon.assert.calledWith(t.docker.compose.stop, tekuCompose, { timeout: 300 });
    sinon.assert.calledWith(t.docker.compose.rm, tekuCompose);
    sinon.assert.calledWith(t.docker.safe.compose.up, tekuCompose);
    sinon.assert.callOrder(
      t.docker.compose.stop,
      t.docker.compose.rm,
      t.docker.safe.compose.up
    );

    const rmCalls = t.shell.getCalls().filter(c => c.args[0].includes("rm -rf"));
    expect(rmCalls).to.have.length(1);
    expect(rmCalls[0].args[0]).to.match(
      new RegExp(`^docker run --rm --name reset-beacon-\\d+ -v ${VOL}:/vol busybox rm -rf '/vol/data-mainnet/beacon'$`)
    );
    expect(rmCalls[0].args[1]).to.deep.equal({ timeout: 60 * 60 * 1000 });
    // settings are read read-only, before the stop
    expect(t.commands[0]).to.equal(
      `docker run --rm -v ${VOL}:/vol:ro busybox cat /vol/settings.json`
    );
    sinon.assert.callOrder(t.shell, t.docker.compose.stop);

    expect(res.result.deleted).to.deep.equal(["data-mainnet/beacon"]);
    expect(res.result.freedBytes).to.equal(1000000 * 1024);
    expect(res.message).to.include("Deleted");
    expect(res.message).to.not.include("/vol");
    expect(t.logUi.called).to.equal(true);
  });

  it("deletes the exact prysm paths", async () => {
    const id = "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth";
    writeCompose(id);
    const t = setup(id, {
      settings: settingsOf(),
      existing: ["beaconchaindata", "blobs", "data-columns"]
    });
    await t.call({ id });
    const rm = t.commands.find(c => c.includes("rm -rf"));
    expect(rm).to.match(
      new RegExp(`^docker run --rm --name reset-beacon-\\d+ -v ${VOL}:/vol busybox rm -rf '/vol/beaconchaindata' '/vol/blobs' '/vol/data-columns'$`)
    );
  });

  it("deletes nimbus db and only existing paths", async () => {
    const id = "nimbus.avado.dnp.dappnode.eth";
    writeCompose(id);
    const t = setup(id, {
      settings: settingsOf({ network: "holesky" }),
      existing: ["data-holesky/db"]
    });
    await t.call({ id });
    expect(t.commands.find(c => c.includes("rm -rf"))).to.match(
      new RegExp(`^docker run --rm --name reset-beacon-\\d+ -v ${VOL}:/vol busybox rm -rf '/vol/data-holesky/db'$`)
    );
  });

  it("still starts the package and rethrows when the delete fails", async () => {
    const t = setup(TEKU, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"],
      rmFails: true
    });
    let err;
    try {
      await t.call({ id: TEKU });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.not.include("/vol");
    sinon.assert.calledOnce(t.docker.compose.stop);
    sinon.assert.calledWith(t.docker.safe.compose.up, tekuCompose);
  });

  it("removes the throwaway container by name when the delete fails, before starting again", async () => {
    const t = setup(TEKU, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"],
      rmFails: true
    });
    let err;
    try {
      await t.call({ id: TEKU });
    } catch (e) {
      err = e;
    }
    expect(err.message).to.match(/Deleting the beacon data of Teku failed/);
    const rmf = t.commands.find(c => c.startsWith("docker rm -f reset-beacon-"));
    expect(rmf).to.be.a("string");
    const name = rmf.replace("docker rm -f ", "");
    expect(t.commands.find(c => c.includes("rm -rf"))).to.include(`--name ${name} `);
    // the container is removed before the package is started again
    expect(t.commands.indexOf(rmf)).to.be.greaterThan(-1);
    sinon.assert.calledWith(t.docker.safe.compose.up, tekuCompose);
  });

  it("reports a plain error when the package does not start again after a good delete", async () => {
    const t = setup(TEKU, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"],
      runningAfter: false
    });
    let err;
    try {
      await t.call({ id: TEKU });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.match(/^Deleted 1\.0 GB of beacon data from Teku, but Teku did not start/);
    expect(err.message).to.not.include("/vol");
    sinon.assert.calledWith(t.docker.safe.compose.up, tekuCompose);
  });

  it("keeps the delete error when the start fails too", async () => {
    const t = setup(TEKU, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"],
      rmFails: true,
      runningAfter: false
    });
    let err;
    try {
      await t.call({ id: TEKU });
    } catch (e) {
      err = e;
    }
    expect(err.message).to.include("Deleting the beacon data of Teku failed.");
    expect(err.message).to.include("Teku did not start");
    expect(err.message).to.not.include("/vol");
  });

  it("starts the package again when compose rm fails after the stop", async () => {
    const t = setup(TEKU, {
      settings: settingsOf(),
      existing: ["data-mainnet/beacon"]
    });
    t.docker.compose.rm = sinon.fake.rejects(Error("Command failed: docker-compose rm -sf /vol/x"));
    let err;
    try {
      await t.call({ id: TEKU });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(Error);
    sinon.assert.calledWith(t.docker.safe.compose.up, tekuCompose);
    expect(t.commands.find(c => c.includes("rm -rf"))).to.equal(undefined);
  });
});
