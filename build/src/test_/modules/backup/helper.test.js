const expect = require("chai").expect;
const fs = require("fs");
const os = require("os");
const path = require("path");
const helper = require("modules/backup/helper");

describe("modules > backup > helper (pure parts)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  before(() => {
    for (const p of ["data-mainnet/validator/key-manager/local", "data-mainnet/beacon", "data-gnosis/validator", "x"])
      fs.mkdirSync(path.join(root, p), { recursive: true });
    fs.writeFileSync(path.join(root, "settings.json"), "{}");
    fs.writeFileSync(
      path.join(root, "data-mainnet/validator/key-manager/local/keystore-1.json"),
      JSON.stringify({ pubkey: "a".repeat(96), crypto: {} })
    );
  });

  it("expands one * per path part, inside the root only", () => {
    expect(helper.expand(root, "data-*/validator")).to.deep.equal(["data-gnosis/validator", "data-mainnet/validator"]);
    expect(helper.expand(root, "settings.json")).to.deep.equal(["settings.json"]);
    expect(helper.expand(root, "../etc")).to.deep.equal([]);
    expect(helper.entriesOf(root, ["settings.json", "data-*/validator"])).to.deep.equal([
      "settings.json",
      "data-gnosis/validator",
      "data-mainnet/validator"
    ]);
    expect(helper.entriesOf(root)).to.deep.equal(["data-gnosis", "data-mainnet", "settings.json", "x"]);
  });

  it("finds validator public keys in names and keystores", () => {
    const k = "0x" + "b".repeat(96);
    expect([...helper.pubkeysInText(`/data/validators/${k}/keystore.json`)]).to.deep.equal([k]);
    expect([...helper.pubkeysInText(JSON.stringify({ pubkey: "C".repeat(96) }))]).to.deep.equal(["0x" + "c".repeat(96)]);
  });

  it("matches key patterns under an item root in restic listings", () => {
    const re = helper.globRe("/avado/teku.avado.dnp.dappnode.eth/validator", "data-*/validator/key-manager/local/*.json");
    expect(re.test("/avado/teku.avado.dnp.dappnode.eth/validator/data-mainnet/validator/key-manager/local/k.json")).to.equal(true);
    expect(re.test("/avado/teku.avado.dnp.dappnode.eth/validator/data-mainnet/beacon/x.json")).to.equal(false);
  });

  it("writes the plain list of backups per run, newest first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-"));
    const snaps = [
      { id: "1", run: "20261101t100000", pkg: "a.avado.dnp.dappnode.eth", time: "2026-11-01T10:00:01Z", paths: ["/avado/a.avado.dnp.dappnode.eth/settings", "/avado/a.avado.dnp.dappnode.eth/data"], bytes: 10 },
      { id: "2", run: "20261105t100000", pkg: "a.avado.dnp.dappnode.eth", time: "2026-11-05T10:00:01Z", paths: ["/avado/a.avado.dnp.dappnode.eth/data"], bytes: 12 }
    ];
    const idx = helper.writeIndex(dir, { id: "avado-1234", name: "Home" }, snaps, null);
    expect(idx.runs.map(r => r.id)).to.deep.equal(["20261105t100000", "20261101t100000"]);
    expect(idx.runs[1].packages[0].items).to.deep.equal(["settings", "data"]);
    expect(helper.readIndex(dir).boxName).to.equal("Home");
    // no secrets, no keys: only names, dates and sizes
    expect(JSON.stringify(idx)).to.not.match(/passphrase|password/);
  });
});
