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

  it("redacts 12 to 24 lowercase words in a row (a mnemonic)", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(scrub(`seed phrase: ${words}`)).to.equal("seed phrase: <12+ words redacted>");
    expect(scrub(`mnemonic=${words}`)).to.equal("mnemonic=<12+ words redacted>");
    expect(scrub(`Imported ${words}`)).to.equal("Imported <12+ words redacted>");
    expect(scrub(`Seed words ["${words.split(" ").join('","')}"]`)).to.not.include("abandon");
    expect(scrub(`first line 1\n${words}\nlast: 2`)).to.equal("first line 1\n<12+ words redacted>\nlast: 2");
    // shorter runs stay
    expect(scrub("the beacon node is not connected to the execution client")).to.equal(
      "the beacon node is not connected to the execution client"
    );
  });

  it("keeps an ordinary log sentence of 14 lowercase words with a digit or a colon", () => {
    const withDigit = "teku is starting the beacon chain node and will load the state from slot 9";
    const withColon = "warn: teku is starting the beacon chain node and will load the latest state";
    const withStop = "teku is starting the beacon chain node and will load the latest state now.";
    expect(scrub(withDigit)).to.equal(withDigit);
    expect(scrub(withColon)).to.equal(withColon);
    expect(scrub(withStop)).to.equal(withStop);
  });

  it("looks past docker's timestamp and the log level of a log line", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    for (const prefix of [
      "2026-10-14T11:45:13.123456789Z ",
      "2026-10-14T11:45:13Z INFO ",
      "2026-10-14T11:45:13.123456789Z 11:45:13.123 INFO  - ",
      "2026-10-14T11:45:13.123456789Z [WARN] ",
      "2026-10-14T11:45:13.123456789Z ERROR - ",
      "DEBUG "
    ]) {
      expect(scrub(`${prefix}${words}`), prefix).to.equal(`${prefix}<12+ words redacted>`);
    }
    expect(scrub(`2026-10-14T11:45:13.123456789Z Your recovery words: ${words}`)).to.not.include("abandon");
    // through the log summary as getDiagnostics returns it
    const { summarizeLogs } = require("modules/diagnostics/containers");
    const s = summarizeLogs(`2026-10-14T11:45:13.123456789Z INFO ${words}\n`);
    expect(s.lines).to.deep.equal(["2026-10-14T11:45:13.123456789Z INFO <12+ words redacted>"]);
    // an ordinary 14-word sentence with a digit survives behind the same prefix
    const sentence = "teku is starting the beacon chain node and will load the state from slot 9";
    expect(scrub(`2026-10-14T11:45:13.123456789Z INFO ${sentence}`)).to.equal(`2026-10-14T11:45:13.123456789Z INFO ${sentence}`);
  });

  it("redacts secrets in URL queries and paths", () => {
    expect(scrub("GET https://relay.example.org/eth?key=s3cr3t&slot=5")).to.equal(
      "GET https://relay.example.org/eth?key=<redacted>&slot=5"
    );
    expect(scrub("https://api.example.org/v1/apikey/abc123/data")).to.equal("https://api.example.org/v1/apikey=<redacted>/data");
    expect(scrub("ee https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161 down")).to.equal(
      "ee https://mainnet.infura.io/v3/<redacted> down"
    );
    expect(scrub("https://x.quiknode.pro/a1b2c3d4e5f6a7b8c9d0e1f2a3b4/")).to.equal("https://x.quiknode.pro/<redacted>/");
    // ordinary paths stay
    expect(scrub("https://beaconstate.info/eth/v2/debug/beacon/states/finalized")).to.equal(
      "https://beaconstate.info/eth/v2/debug/beacon/states/finalized"
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
