const expect = require("chai").expect;
const {
  MASK,
  secretEnvNames,
  maskSecretEnvs,
  dropKeptSecretEnvs
} = require("utils/secretEnvs");

describe("Util: secretEnvs", () => {
  const manifest = {
    setupWizard: {
      version: "2",
      fields: [
        { id: "key", target: { type: "environment", name: "TS_AUTHKEY" }, secret: true },
        { id: "pass", target: { type: "environment", name: "DB_PASS" }, secret: true },
        { id: "name", target: { type: "environment", name: "TS_HOSTNAME" } },
        // Not secret: only secret: true counts
        { id: "maybe", target: { type: "environment", name: "MAYBE" }, secret: "true" },
        // Not an env target
        { id: "file", target: { type: "fileUpload", path: "/data/k" }, secret: true },
        { id: "noname", target: { type: "environment" }, secret: true },
        null,
        // Repeated
        { id: "key2", target: { type: "environment", name: "TS_AUTHKEY" }, secret: true }
      ]
    }
  };

  it("secretEnvNames: environment targets with secret: true only", () => {
    expect(secretEnvNames(manifest)).to.deep.equal(["TS_AUTHKEY", "DB_PASS"]);
    expect(secretEnvNames({})).to.deep.equal([]);
    expect(secretEnvNames(undefined)).to.deep.equal([]);
    expect(secretEnvNames({ setupWizard: { fields: "x" } })).to.deep.equal([]);
  });

  it("maskSecretEnvs: set -> ********, unset or missing -> '', others unchanged", () => {
    const envs = { TS_AUTHKEY: "tskey-auth-abc", TS_HOSTNAME: "avado", MAYBE: "v" };
    const out = maskSecretEnvs(envs, manifest);
    expect(out).to.deep.equal({ TS_AUTHKEY: MASK, DB_PASS: "", TS_HOSTNAME: "avado", MAYBE: "v" });
    expect(MASK).to.equal("********");
    // The input is not changed
    expect(envs.TS_AUTHKEY).to.equal("tskey-auth-abc");
    // Whitespace only counts as not set
    expect(maskSecretEnvs({ TS_AUTHKEY: "  ", DB_PASS: "x" }, manifest)).to.include({ TS_AUTHKEY: "", DB_PASS: MASK });
  });

  it("maskSecretEnvs: same object without secret fields", () => {
    const envs = { A: "1" };
    expect(maskSecretEnvs(envs, {})).to.equal(envs);
    expect(maskSecretEnvs(envs, undefined)).to.equal(envs);
  });

  it("dropKeptSecretEnvs: mask and empty mean keep, a new value passes", () => {
    const envs = { TS_AUTHKEY: MASK, DB_PASS: "", TS_HOSTNAME: "", MAYBE: MASK };
    expect(dropKeptSecretEnvs(envs, manifest)).to.deep.equal({ TS_HOSTNAME: "", MAYBE: MASK });
    expect(dropKeptSecretEnvs({ TS_AUTHKEY: ` ${MASK} `, DB_PASS: "   " }, manifest)).to.deep.equal({});
    expect(dropKeptSecretEnvs({ TS_AUTHKEY: null }, manifest)).to.deep.equal({});
    expect(dropKeptSecretEnvs({ TS_AUTHKEY: "new-key", DB_PASS: "*******x" }, manifest)).to.deep.equal({
      TS_AUTHKEY: "new-key",
      DB_PASS: "*******x"
    });
    // The input is not changed
    expect(envs.TS_AUTHKEY).to.equal(MASK);
  });

  it("dropKeptSecretEnvs: same object when nothing is left out", () => {
    const envs = { TS_AUTHKEY: "new-key" };
    expect(dropKeptSecretEnvs(envs, manifest)).to.equal(envs);
    const plain = { A: MASK };
    expect(dropKeptSecretEnvs(plain, {})).to.equal(plain);
  });
});
