const fs = require("fs");
const os = require("os");
const path = require("path");
const expect = require("chai").expect;
const proxyquire = require("proxyquire");
const { eventBusTag } = require("eventBus");
const paramsDefault = require("params");
const getPath = require("utils/getPath");

// Secret setup fields (manifest setupWizard, secret: true): the package list
// sends the Admin "********" or "", never the value; updatePackageEnv and
// installPackage take the mask or an empty value as "keep the current value"
describe("Secret setup fields stay in the DAPPMANAGER", function() {
  const dnp = "tailscale.avado.dnp.dappnode.eth";
  const plainDnp = "plain.avado.dnp.dappnode.eth";
  const AUTHKEY = "tskey-auth-kQ3xExampleSecret-1234567890abcdef";
  const manifest = {
    name: dnp,
    version: "0.1.0",
    image: { environment: ["TS_AUTHKEY=", "DB_PASS=", "TS_HOSTNAME=avado", "API_TOKEN="] },
    setupWizard: {
      version: "2",
      fields: [
        { id: "TS_AUTHKEY", target: { type: "environment", name: "TS_AUTHKEY" }, title: "Auth key", secret: true },
        { id: "DB_PASS", target: { type: "environment", name: "DB_PASS" }, title: "Password", secret: true },
        { id: "API_TOKEN", target: { type: "environment", name: "API_TOKEN" }, title: "Token", secret: true },
        { id: "TS_HOSTNAME", target: { type: "environment", name: "TS_HOSTNAME" }, title: "Name" }
      ]
    }
  };

  const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {} });

  let dir;
  let params;
  let envsHelper;

  const envFile = name => getPath.envFile(name, params, false);
  const readEnvFile = name => fs.readFileSync(envFile(name), "utf8");
  const writePackage = (name, man, envText) => {
    const repoDir = getPath.packageRepoDir(name, params, false);
    fs.mkdirSync(repoDir, { recursive: true });
    if (man) fs.writeFileSync(getPath.manifest(name, params, false), JSON.stringify(man));
    if (envText !== undefined) fs.writeFileSync(envFile(name), envText);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretEnvs-test-"));
    params = { ...paramsDefault, REPO_DIR: dir + "/", DNCORE_DIR: path.join(dir, "DNCORE") };
    envsHelper = proxyquire("utils/envsHelper", { params });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function listPackagesWith(names) {
    return proxyquire("calls/listPackages", {
      "modules/dockerList": { listContainers: async () => names.map(name => ({ name, isCore: false })) },
      "modules/docker": { systemDf: async () => { throw Error("no docker in unit tests"); } },
      "utils/envsHelper": envsHelper,
      "../db": { get: async () => undefined },
      "logs.js": quiet,
      params
    });
  }

  function updatePackageEnvWith(name) {
    return proxyquire("calls/updatePackageEnv", {
      "modules/dockerList": { listContainers: async () => [{ name, isCore: false }] },
      "modules/downloadManifest": async () => ({}),
      "modules/docker": {},
      "utils/envsHelper": envsHelper,
      eventBus: { eventBus: { emit: () => {} }, eventBusTag },
      params
    });
  }

  describe("listPackages", () => {
    it("secret set -> ********, secret empty or missing -> '', other envs as they are", async () => {
      const envText = `TS_AUTHKEY=${AUTHKEY}\nDB_PASS=\nTS_HOSTNAME=box1`;
      writePackage(dnp, manifest, envText);
      const { result } = await listPackagesWith([dnp])();
      expect(result[0].envs).to.deep.equal({ TS_AUTHKEY: "********", DB_PASS: "", TS_HOSTNAME: "box1", API_TOKEN: "" });
      // The value is nowhere in what goes to the Admin (also the published list)
      expect(JSON.stringify(result)).to.not.include(AUTHKEY);
      // The .env file keeps the real value
      expect(readEnvFile(dnp)).to.equal(envText);
    });

    it("a package without secret fields keeps all its values", async () => {
      writePackage(plainDnp, { name: plainDnp, version: "1.0.0" }, "PASSWORD=hunter22\nA=1");
      const { result } = await listPackagesWith([plainDnp])();
      expect(result[0].envs).to.deep.equal({ PASSWORD: "hunter22", A: "1" });
    });

    it("a package with no envs and no secret fields gets no envs key", async () => {
      writePackage(plainDnp, { name: plainDnp, version: "1.0.0" });
      const { result } = await listPackagesWith([plainDnp])();
      expect(result[0]).to.not.have.property("envs");
    });
  });

  describe("updatePackageEnv", () => {
    beforeEach(() => writePackage(dnp, manifest, `TS_AUTHKEY=${AUTHKEY}\nDB_PASS=\nTS_HOSTNAME=box1\nAPI_TOKEN=tok-1`));

    it("Admin 10.0.68: the whole table comes back with the masks; only the edited env changes", async () => {
      const { result } = await listPackagesWith([dnp])();
      const table = { ...result[0].envs, TS_HOSTNAME: "box2" };
      expect(table).to.include({ TS_AUTHKEY: "********", API_TOKEN: "********", DB_PASS: "" });
      await updatePackageEnvWith(dnp)({ id: dnp, envs: table, restart: false });
      expect(envsHelper.load(dnp, false)).to.deep.equal({
        TS_AUTHKEY: AUTHKEY,
        DB_PASS: "",
        TS_HOSTNAME: "box2",
        API_TOKEN: "tok-1"
      });
      expect(readEnvFile(dnp)).to.not.include("********");
    });

    it("Admin 10.0.70 Settings: only the changed secret is sent and written", async () => {
      await updatePackageEnvWith(dnp)({ id: dnp, envs: { TS_AUTHKEY: "tskey-auth-new" }, restart: false });
      expect(envsHelper.load(dnp, false)).to.include({ TS_AUTHKEY: "tskey-auth-new", API_TOKEN: "tok-1", TS_HOSTNAME: "box1" });
      const { result } = await listPackagesWith([dnp])();
      expect(result[0].envs.TS_AUTHKEY).to.equal("********");
    });

    it("an empty secret keeps its value; an empty plain env is still cleared", async () => {
      await updatePackageEnvWith(dnp)({ id: dnp, envs: { TS_AUTHKEY: "", API_TOKEN: "  ", TS_HOSTNAME: "" }, restart: false });
      expect(envsHelper.load(dnp, false)).to.deep.equal({
        TS_AUTHKEY: AUTHKEY,
        DB_PASS: "",
        TS_HOSTNAME: "",
        API_TOKEN: "tok-1"
      });
    });

    it("a secret that was not set gets its first value", async () => {
      await updatePackageEnvWith(dnp)({ id: dnp, envs: { DB_PASS: "first-pass" }, restart: false });
      expect(envsHelper.load(dnp, false).DB_PASS).to.equal("first-pass");
    });

    it("the caller's envs object is not changed", async () => {
      const envs = { TS_AUTHKEY: "********", TS_HOSTNAME: "box3" };
      await updatePackageEnvWith(dnp)({ id: dnp, envs, restart: false });
      expect(envs).to.deep.equal({ TS_AUTHKEY: "********", TS_HOSTNAME: "box3" });
    });

    it("a package without secret fields writes ******** as a value (nothing is masked there)", async () => {
      writePackage(plainDnp, { name: plainDnp }, "A=1");
      await updatePackageEnvWith(plainDnp)({ id: plainDnp, envs: { A: "********" }, restart: false });
      expect(envsHelper.load(plainDnp, false)).to.deep.equal({ A: "********" });
    });
  });

  describe("installPackage", () => {
    function installPackageWith({ previousEnvs, written }) {
      return proxyquire("calls/installPackage", {
        "modules/packages": { download: async () => {}, run: async () => {} },
        "modules/dappGet": async () => ({ state: { [dnp]: "0.1.1" } }),
        "modules/getManifest": async () => ({ ...manifest, version: "0.1.1", type: "service" }),
        "modules/dockerList": { listContainers: async () => [] },
        "modules/lockPorts": async () => [],
        "utils/isSyncing": async () => false,
        "utils/envsHelper": {
          getManifestEnvs: envsHelper.getManifestEnvs,
          load: () => previousEnvs,
          write: (name, isCore, envs) => written.push(envs)
        },
        "utils/logUi": () => {},
        "./updateDNS": async () => ({}),
        eventBus: { eventBus: { emit: () => {} }, eventBusTag },
        db: { get: async () => false },
        "logs.js": quiet,
        params
      });
    }

    it("an update with masked or empty secrets in userSetEnvs keeps the current values", async () => {
      const written = [];
      const previousEnvs = { TS_AUTHKEY: AUTHKEY, DB_PASS: "pw", TS_HOSTNAME: "box1", API_TOKEN: "tok-1" };
      await installPackageWith({ previousEnvs, written })({
        id: dnp,
        userSetEnvs: { [dnp]: { TS_AUTHKEY: "********", DB_PASS: "", TS_HOSTNAME: "box2", API_TOKEN: "tok-2" } }
      });
      expect(written).to.deep.equal([{ TS_AUTHKEY: AUTHKEY, DB_PASS: "pw", TS_HOSTNAME: "box2", API_TOKEN: "tok-2" }]);
    });

    it("a new install with a typed secret writes it", async () => {
      const written = [];
      await installPackageWith({ previousEnvs: {}, written })({ id: dnp, userSetEnvs: { [dnp]: { TS_AUTHKEY: AUTHKEY } } });
      expect(written).to.deep.equal([{ TS_AUTHKEY: AUTHKEY, DB_PASS: "", TS_HOSTNAME: "avado", API_TOKEN: "" }]);
    });
  });
});
