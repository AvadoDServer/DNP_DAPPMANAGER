const expect = require("chai").expect;
const { backupItemsOf, validateBackupArray } = require("modules/backup/items");

describe("modules > backup > items", () => {
  it("uses the manifest's backup field (DAppNode format)", () => {
    const r = backupItemsOf("raiden.dnp.dappnode.eth", {
      backup: [{ name: "keystore", path: "/root/.raiden/secret/keystore" }, { name: "config", path: "/root/.raiden/config/", service: "x" }]
    });
    expect(r.source).to.equal("manifest");
    expect(r.items.map(i => [i.name, i.path, i.service])).to.deep.equal([
      ["keystore", "/root/.raiden/secret/keystore", undefined],
      ["config", "/root/.raiden/config", "x"]
    ]);
  });

  it("refuses DAppNode's invalid lists: duplicate names, relative paths, names with a path", () => {
    expect(() => validateBackupArray([{ name: "a", path: "/a" }, { name: "a", path: "/b" }])).to.throw(/duplicated/);
    expect(() => validateBackupArray([{ name: "a", path: "a" }])).to.throw(/absolute/);
    expect(() => validateBackupArray([{ name: "a/b", path: "/a" }])).to.throw();
    expect(() => validateBackupArray([{ name: "a", path: "/a/../etc" }])).to.throw(/absolute/);
    expect(() => validateBackupArray([{ name: "settings", path: "/a" }])).to.throw(/not allowed/);
  });

  it("an invalid manifest list means nothing is backed up, with the reason", () => {
    const r = backupItemsOf("x.avado.dnp.dappnode.eth", { backup: [{ name: "a", path: "rel" }] });
    expect(r.items).to.deep.equal([]);
    expect(r.error).to.match(/absolute/);
  });

  it("has built-in lists for the validator clients and the self-host apps", () => {
    for (const n of [
      "teku.avado.dnp.dappnode.eth",
      "teku-gnosis.avado.dnp.dappnode.eth",
      "nimbus.avado.dnp.dappnode.eth",
      "lighthouse.avado.dnp.dappnode.eth",
      "eth2validator.avado.dnp.dappnode.eth"
    ]) {
      const { items, source } = backupItemsOf(n, {});
      expect(source).to.equal("builtin");
      expect(items[0].validator, n).to.equal(true);
      expect(items[0].keys.length, n).to.be.above(0);
      // never the beacon database
      expect(items[0].only.join(" "), n).to.not.match(/beacon|\bdb\b/);
    }
    const immich = backupItemsOf("immich.avado.dnp.dappnode.eth", {}).items;
    expect(immich.find(i => i.name === "library").large).to.equal(true);
    expect(immich.find(i => i.name === "database").large).to.equal(false);
    expect(backupItemsOf("vaultwarden.avado.dnp.dappnode.eth", {}).items[0].path).to.equal("/data");
    expect(backupItemsOf("homeassistant.avado.dnp.dappnode.eth", {}).items[0].path).to.equal("/config");
    expect(backupItemsOf("paperless.avado.dnp.dappnode.eth", {}).items.map(i => i.name)).to.deep.equal(["data", "media"]);
    expect(backupItemsOf("grafana.avado.dappnode.eth", {}).items).to.deep.equal([]);
  });

  it("drops unsafe only/keys patterns", () => {
    const [i] = validateBackupArray([{ name: "a", path: "/a", only: ["ok/*", "../etc", "/abs", "x y"], keys: ["k/0x*"] }]);
    expect(i.only).to.deep.equal(["ok/*"]);
    expect(i.keys).to.deep.equal(["k/0x*"]);
  });
});
