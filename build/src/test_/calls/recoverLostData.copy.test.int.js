const expect = require("chai").expect;
const shell = require("utils/shell");
const { copyCommand } = require("calls/recoverLostData");

/**
 * Runs the real recoverLostData copy script with busybox against throwaway
 * volumes. Needs a local Docker; skipped without one. Run with:
 *   yarn test:file test_/calls/recoverLostData.copy.test.int.js
 */
describe("recoverLostData copy script with REAL docker", function() {
  this.timeout(5 * 60 * 1000);
  const id = `${Date.now()}`;
  const FROM = `lostdata-int-from-${id}`;
  const TO = `lostdata-int-to-${id}`;
  const inVol = (vol, script) =>
    shell(`docker run --rm -v ${vol}:/v busybox sh -c '${script}'`);
  const copy = () =>
    shell(copyCommand(`recover-data-int-${id}`, FROM, TO)).then(
      out => ({ code: 0, out }),
      e => ({ code: e.code, out: e.stdout || "", err: e.stderr || "" })
    );

  before(async function() {
    try {
      await shell("docker version --format '{{.Server.Version}}'");
    } catch (e) {
      this.skip();
    }
    await shell(`docker volume create ${FROM} && docker volume create ${TO}`);
    await inVol(
      FROM,
      [
        "mkdir -p /v/data/wallet /v/linked /v/clash /v/newdir/sub",
        "echo old > /v/data/wallet/w && chmod 600 /v/data/wallet/w",
        "chown -R 1000:1000 /v/data /v/newdir && chmod 750 /v/newdir",
        "echo old > /v/data/Password.txt && echo old > /v/a",
        'printf x > "/v/nl\nname" && echo q > "/v/ lead" && echo h > /v/.hidden',
        "echo c > /v/linked/child && echo i > /v/clash/inner && echo n > /v/newdir/sub/f",
        "ln -s a /v/rel"
      ].join(" && ")
    );
    await inVol(
      TO,
      "mkdir -p /v/data && echo NEW > /v/data/Password.txt && echo NEW > /v/a && ln -s /tmp /v/linked && echo file > /v/clash"
    );
  });

  after(async () => {
    await shell(`docker rm -f recover-data-int-${id}`).catch(() => {});
    await shell(`docker volume rm ${FROM} ${TO}`).catch(() => {});
  });

  it("copies what is missing, keeps what exists, counts failures and goes on", async () => {
    const res = await copy();
    expect(res.code).to.equal(1);
    expect(res.out).to.include("FILES 9");
    // a, data/Password.txt (key file), linked/child (parent is a symlink)
    expect(res.out).to.include("SKIPPED 3 1");
    expect(res.out).to.include("FAILED 1 ./clash/inner");

    const listing = await inVol(TO, "cd /v && cat a data/Password.txt data/wallet/w && stat -c \"%u:%g %a %n\" data/wallet/w newdir && cat \"./nl\nname\" \" lead\" .hidden newdir/sub/f && readlink rel");
    const lines = listing.split("\n");
    expect(lines.slice(0, 3)).to.deep.equal(["NEW", "NEW", "old"]);
    expect(lines).to.include("1000:1000 600 data/wallet/w");
    expect(lines).to.include("1000:1000 750 newdir");
    expect(listing).to.include("xq");
    expect(listing).to.include("h\nn\na");
  });

  it("finishes on a retry once the clash is gone, and never leaves temporary names", async () => {
    await inVol(TO, "mv /v/clash /v/clash.kept");
    const res = await copy();
    expect(res.code).to.equal(0);
    expect(res.out).to.match(/^FILES 9\nSKIPPED 8 2\n\d+\t\/to$/);
    const tmp = await inVol(TO, "find /v -name \"*.avado-recover-tmp\" | wc -l");
    expect(tmp).to.equal("0");
  });
});
