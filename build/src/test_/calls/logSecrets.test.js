const fs = require("fs");
const os = require("os");
const path = require("path");
const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();
const { eventBusTag } = require("eventBus");
const paramsDefault = require("params");

// Env values typed in the installer's setup fields or in an app's Settings
// must reach the .env file and no log: not the activity log
// (userActionLogs.log, also sent to the Admin) and not a log line
describe("Env values and secrets stay out of the logs", function() {
  const AUTHKEY = "tskey-auth-kQ3xExampleSecret-1234567890abcdef";
  const PLAIN = "my-plain-looking-value-42";
  const dnp = "tailscale.avado.dnp.dappnode.eth";

  let dir;
  let lines; // every log line, from every module
  let emitted; // what the activity log sends to the Admin
  let written; // what reached the .env files

  const logsStub = () => {
    const push = (...args) => lines.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    return { debug: push, info: push, warn: push, error: push };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logSecrets-test-"));
    lines = [];
    emitted = [];
    written = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // registerHandler with the real activity log, writing to a temp file
  function wrap(handler, event) {
    const userActionLogsFilename = path.join(dir, "userActionLogs.log");
    const logUserAction = proxyquire("logUserAction", {
      params: { ...paramsDefault, userActionLogsFilename },
      eventBus: { eventBus: { emit: (tag, info) => emitted.push(info) }, eventBusTag }
    });
    const { wrapErrors } = proxyquire("registerHandler", {
      "./logUserAction": logUserAction,
      "./logs": logsStub
    });
    const readFile = async () => {
      // winston writes the file asynchronously
      for (let i = 0; i < 100; i++) {
        if (fs.existsSync(userActionLogsFilename) && fs.readFileSync(userActionLogsFilename, "utf8").trim()) break;
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 50));
      return fs.readFileSync(userActionLogsFilename, "utf8");
    };
    return { call: kwargs => wrapErrors(handler, event)([], kwargs).then(JSON.parse), readFile };
  }

  function installPackageStub(opts = {}) {
    return proxyquire("calls/installPackage", {
      "logs.js": logsStub,
      "modules/packages": { download: async () => {}, run: async () => {
        if (opts.runFails) throw Error("docker-compose up failed");
      } },
      "modules/dappGet": async () => ({ state: { [dnp]: "0.0.3" } }),
      "modules/getManifest": async ({ name }) => ({ name, type: "service" }),
      "modules/dockerList": { listContainers: async () => [] },
      "modules/lockPorts": async () => [],
      "utils/isSyncing": async () => false,
      "utils/envsHelper": {
        getManifestEnvs: () => ({ TS_HOSTNAME: "avado" }),
        load: () => ({}),
        write: (name, isCore, envs) => written.push({ name, envs })
      },
      "utils/logUi": () => {},
      "./updateDNS": async () => ({}),
      eventBus: { eventBus: { emit: () => {} }, eventBusTag },
      db: { get: async () => false },
      params: { ...paramsDefault, REPO_DIR: dir }
    });
  }

  it("installPackage: userSetEnvs written for real, logged as names with ********", async () => {
    const { call, readFile } = wrap(installPackageStub(), "installPackage.dappmanager.dnp.dappnode.eth");
    const kwargs = { id: dnp, userSetEnvs: { [dnp]: { TS_AUTHKEY: AUTHKEY, TS_EXTRA_ARGS: PLAIN } } };
    const reply = await call(kwargs);
    expect(reply.success).to.equal(true);

    // The real values reached the .env file, and the caller's kwargs are unchanged
    expect(written).to.deep.equal([{ name: dnp, envs: { TS_HOSTNAME: "avado", TS_AUTHKEY: AUTHKEY, TS_EXTRA_ARGS: PLAIN } }]);
    expect(kwargs.userSetEnvs[dnp].TS_AUTHKEY).to.equal(AUTHKEY);

    const file = await readFile();
    const entry = JSON.parse(file.trim().split("\n").pop());
    expect(entry.kwargs).to.deep.equal({
      id: dnp,
      userSetEnvs: { [dnp]: { TS_AUTHKEY: "********", TS_EXTRA_ARGS: "********" } }
    });
    expect(emitted[0].kwargs).to.deep.equal(entry.kwargs);
    // The log line names the envs only
    expect(lines.join("\n")).to.include(`Wrote envs for DNP ${dnp} : TS_HOSTNAME, TS_AUTHKEY, TS_EXTRA_ARGS`);

    const everything = file + JSON.stringify(emitted) + lines.join("\n");
    expect(everything).to.not.include(AUTHKEY);
    expect(everything).to.not.include(PLAIN);
  });

  it("installPackage error: the activity log entry hides the values too", async () => {
    const { call, readFile } = wrap(installPackageStub({ runFails: true }), "installPackage.dappmanager.dnp.dappnode.eth");
    const reply = await call({ id: dnp, userSetEnvs: { [dnp]: { TS_AUTHKEY: AUTHKEY } } });
    expect(reply).to.deep.equal({ success: false, message: "docker-compose up failed" });
    const file = await readFile();
    const entry = JSON.parse(file.trim().split("\n").pop());
    expect(entry).to.include({ level: "error" });
    expect(entry.kwargs.userSetEnvs).to.deep.equal({ [dnp]: { TS_AUTHKEY: "********" } });
    expect(file + JSON.stringify(emitted) + lines.join("\n")).to.not.include(AUTHKEY);
  });

  it("updatePackageEnv: envs written for real, logged as names with ********", async () => {
    let received;
    const updatePackageEnv = proxyquire("calls/updatePackageEnv", {
      "modules/dockerList": { listContainers: async () => [{ name: dnp, isCore: false }] },
      "utils/envsHelper": {
        load: () => ({ TS_HOSTNAME: "avado" }),
        write: (name, isCore, envs) => written.push({ name, envs })
      },
      "modules/downloadManifest": async () => ({}),
      "modules/docker": {},
      eventBus: { eventBus: { emit: () => {} }, eventBusTag },
      params: paramsDefault
    });
    const handler = kwargs => ((received = kwargs), updatePackageEnv(kwargs));
    const { call, readFile } = wrap(handler, "updatePackageEnv.dappmanager.dnp.dappnode.eth");
    const reply = await call({ id: dnp, envs: { TS_AUTHKEY: AUTHKEY, EMPTY: "" }, restart: false });
    expect(reply.success).to.equal(true);
    expect(received.envs.TS_AUTHKEY).to.equal(AUTHKEY);
    expect(written).to.deep.equal([{ name: dnp, envs: { TS_HOSTNAME: "avado", TS_AUTHKEY: AUTHKEY, EMPTY: "" } }]);

    const file = await readFile();
    const entry = JSON.parse(file.trim().split("\n").pop());
    expect(entry.kwargs).to.deep.equal({ id: dnp, envs: { TS_AUTHKEY: "********", EMPTY: "********" }, restart: false });
    expect(file + JSON.stringify(emitted) + lines.join("\n")).to.not.include(AUTHKEY);
  });

  it("a userAction log from elsewhere (the VPN) is hidden before the file too", async () => {
    const userActionLogsFilename = path.join(dir, "userActionLogs.log");
    const logUserAction = proxyquire("logUserAction", {
      params: { ...paramsDefault, userActionLogsFilename },
      eventBus: { eventBus: { emit: (tag, info) => emitted.push(info) }, eventBusTag }
    });
    const kwargs = { id: dnp, envs: { TS_AUTHKEY: AUTHKEY }, adminPassword: "hunter2hunter2" };
    logUserAction.log({ level: "info", event: "vpn.x", message: "ok", userAction: true, kwargs });
    for (let i = 0; i < 100 && !fs.existsSync(userActionLogsFilename); i++) await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setTimeout(r, 100));
    const file = fs.readFileSync(userActionLogsFilename, "utf8");
    expect(JSON.parse(file.trim()).kwargs).to.deep.equal({ id: dnp, envs: { TS_AUTHKEY: "********" }, adminPassword: "********" });
    expect(file + JSON.stringify(emitted)).to.not.match(/tskey-auth|hunter2/);
    // The caller's object is not changed
    expect(kwargs.envs.TS_AUTHKEY).to.equal(AUTHKEY);
  });

  it("getUserActionLogs hides values in lines written before the fix", async () => {
    const userActionLogsFilename = path.join(dir, "userActionLogs.log");
    const old = [
      { level: "info", event: "installPackage.dappmanager.dnp.dappnode.eth", kwargs: { id: dnp, userSetEnvs: { [dnp]: { TS_AUTHKEY: AUTHKEY } } } },
      { level: "info", event: "updatePackageEnv.dappmanager.dnp.dappnode.eth", kwargs: { id: dnp, envs: { PASS: PLAIN }, restart: true } },
      // limitObjValuesSize cut long kwargs to a string
      { level: "info", event: "installPackage.dappmanager.dnp.dappnode.eth", kwargs: { id: dnp, userSetEnvs: `{"${dnp}":{"TS_AUTHKEY":"${AUTHKEY}` } }
    ];
    const plain = { level: "info", event: "restartPackage.dappmanager.dnp.dappnode.eth", kwargs: { id: dnp } };
    fs.writeFileSync(userActionLogsFilename, [...old, plain].map(l => JSON.stringify(l)).join("\n") + "\nnot json " + PLAIN);
    const getUserActionLogs = proxyquire("calls/getUserActionLogs", {
      params: { ...paramsDefault, userActionLogsFilename }
    });
    const { result } = await getUserActionLogs({});
    const out = result.split("\n");
    expect(out[0]).to.equal(`not json ${PLAIN}`); // not a log entry: as it is
    expect(out[1]).to.equal(JSON.stringify(plain)); // nothing to hide: byte for byte
    expect(JSON.parse(out[2]).kwargs.userSetEnvs).to.equal("********");
    expect(JSON.parse(out[3]).kwargs).to.deep.equal({ id: dnp, envs: { PASS: "********" }, restart: true });
    expect(JSON.parse(out[4]).kwargs.userSetEnvs).to.deep.equal({ [dnp]: { TS_AUTHKEY: "********" } });
    expect(out.slice(1).join("\n")).to.not.include(AUTHKEY);
  });
});
