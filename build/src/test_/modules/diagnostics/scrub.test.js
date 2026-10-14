const expect = require("chai").expect;
const { scrub, scrubSettings } = require("modules/diagnostics/scrub");

describe("Module: diagnostics/scrub", () => {
  it("shortens hex strings of 64+ characters, keeps addresses", () => {
    const key = "ab".repeat(32);
    const addr = "0x" + "1f".repeat(20);
    expect(scrub(`jwt ${key} fee recipient ${addr}`)).to.equal(`jwt ababab… fee recipient ${addr}`);
    expect(scrub(`pubkey 0x${"c".repeat(96)}`)).to.equal("pubkey 0xcccccc…");
  });

  it("redacts name=value secrets, case-insensitive, also in JSON", () => {
    expect(scrub("password=hunter2 next")).to.equal("password=<redacted> next");
    expect(scrub("API_KEY: abc123")).to.equal("API_KEY=<redacted>");
    expect(scrub('{"secret": "s3cr3t", "x": 1}')).to.equal('{"secret=<redacted> "x": 1}');
    expect(scrub("--private-key=0xdead")).to.equal("--private-key=<redacted>");
    expect(scrub("keymanagertoken=abc")).to.equal("keymanagertoken=<redacted>");
    expect(scrub("Mnemonic: word")).to.equal("Mnemonic=<redacted>");
  });

  it("redacts bearer tokens and URL credentials", () => {
    expect(scrub("Authorization: Bearer eyJhbGciOi.x.y")).to.equal("Authorization: Bearer <redacted>");
    expect(scrub("connecting to https://user:pa55@relay.example.org/eth")).to.equal(
      "connecting to https://<redacted>@relay.example.org/eth"
    );
    expect(scrub("ws://only-token@host:8546")).to.equal("ws://<redacted>@host:8546");
  });

  it("redacts 12+ lowercase words in a row (a mnemonic)", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(scrub(`seed phrase: ${words}`)).to.not.include("abandon");
    expect(scrub(`Imported ${words}. Done`)).to.equal("Imported <12+ words redacted>. Done");
    // shorter runs stay
    expect(scrub("the beacon node is not connected to the execution client")).to.equal(
      "the beacon node is not connected to the execution client"
    );
  });

  it("leaves non-strings and plain lines alone", () => {
    expect(scrub(null)).to.equal(null);
    expect(scrub("Slot 123 head 0xabc peers 50")).to.equal("Slot 123 head 0xabc peers 50");
  });

  it("removes secret keys from settings at any depth and scrubs the values", () => {
    const settings = {
      ee_endpoint: "http://avado-dnp-nethermind.my.ava.do:8551",
      keymanager_token: "x",
      validators_password: "y",
      nested: { mnemonic: "z", initial_state: "https://u:p@checkpoint.example/" },
      list: [{ privateKey: "k", fee: "0x" + "1".repeat(40) }],
      mev_boost: true
    };
    expect(scrubSettings(settings)).to.deep.equal({
      ee_endpoint: "http://avado-dnp-nethermind.my.ava.do:8551",
      nested: { initial_state: "https://<redacted>@checkpoint.example/" },
      list: [{ fee: "0x" + "1".repeat(40) }],
      mev_boost: true
    });
  });
});
