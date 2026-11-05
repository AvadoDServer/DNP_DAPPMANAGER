const expect = require("chai").expect;
const logSafeObjects = require("utils/logSafeObjects");
const { envNames } = require("utils/logSafeObjects");

describe("Util: logSafeObjects", () => {
  it("installPackage userSetEnvs: names kept, every value ********", () => {
    const kwargs = {
      id: "tailscale.avado.dnp.dappnode.eth",
      userSetEnvs: {
        "tailscale.avado.dnp.dappnode.eth": { TS_AUTHKEY: "tskey-auth-x", TS_HOSTNAME: "avado", PORT: 41641, ON: true },
        "dep.dnp.dappnode.eth": {}
      },
      userSetVols: { "a.dnp.dappnode.eth": { "data:/data": "other" } },
      options: { BYPASS_RESOLVER: true }
    };
    const copy = JSON.parse(JSON.stringify(kwargs));
    expect(logSafeObjects(kwargs)).to.deep.equal({
      id: "tailscale.avado.dnp.dappnode.eth",
      userSetEnvs: {
        "tailscale.avado.dnp.dappnode.eth": { TS_AUTHKEY: "********", TS_HOSTNAME: "********", PORT: "********", ON: "********" },
        "dep.dnp.dappnode.eth": {}
      },
      userSetVols: { "a.dnp.dappnode.eth": { "data:/data": "other" } },
      options: { BYPASS_RESOLVER: true }
    });
    // The input is never changed
    expect(kwargs).to.deep.equal(copy);
  });

  it("updatePackageEnv envs: names kept, every value ********, empty ones too", () => {
    expect(logSafeObjects({ id: "x", envs: { A: "1", B: "", C: null }, restart: true })).to.deep.equal({
      id: "x",
      envs: { A: "********", B: "********", C: null },
      restart: true
    });
  });

  it("env lists and envs given as a string", () => {
    expect(logSafeObjects({ envs: ["A=1", "B=x=y", "C"] })).to.deep.equal({ envs: ["A=********", "B=********", "********"] });
    expect(logSafeObjects({ userSetEnvs: '{"a":{"KEY":"secret' })).to.deep.equal({ userSetEnvs: "********" });
  });

  it("secret-named keys at any depth (as DAppNode's logSafeObjects)", () => {
    expect(
      logSafeObjects({
        currentPassword: "a",
        newPassword: "b",
        keystorePassword: "c",
        passphrase: "d",
        secret: "e",
        mnemonic: "f",
        privateKey: "g",
        PRIVATE_KEY: "h",
        apiKey: "i",
        authKey: "j",
        token: "k",
        AUTHORIZATION: "Bearer l",
        nested: { deeper: [{ RTL_PASSWORD: "m", color: "blue" }] },
        name: "kept",
        id: "kept.dnp.dappnode.eth"
      })
    ).to.deep.equal({
      currentPassword: "********",
      newPassword: "********",
      keystorePassword: "********",
      passphrase: "********",
      secret: "********",
      mnemonic: "********",
      privateKey: "********",
      PRIVATE_KEY: "********",
      apiKey: "********",
      authKey: "********",
      token: "********",
      AUTHORIZATION: "********",
      nested: { deeper: [{ RTL_PASSWORD: "********", color: "blue" }] },
      name: "kept",
      id: "kept.dnp.dappnode.eth"
    });
  });

  it("returns the same object when there is nothing to hide", () => {
    const kwargs = { id: "teku.avado.dnp.dappnode.eth", options: { a: 1 }, list: [{ b: 2 }] };
    expect(logSafeObjects(kwargs)).to.equal(kwargs);
    for (const value of [undefined, null, "text", 3, true]) expect(logSafeObjects(value)).to.equal(value);
    // An unset secret stays unset
    expect(logSafeObjects({ password: undefined, secret: null })).to.deep.equal({ password: undefined, secret: null });
  });

  it("envNames: the names only", () => {
    expect(envNames({ TS_AUTHKEY: "tskey", B: "" })).to.equal("TS_AUTHKEY, B");
    expect(envNames({})).to.equal("(none)");
    expect(envNames(undefined)).to.equal("(none)");
  });
});
