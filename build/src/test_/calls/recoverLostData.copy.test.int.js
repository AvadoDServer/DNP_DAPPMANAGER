const expect = require("chai").expect;
const shell = require("utils/shell");
const { copyCommand, copyScript } = require("calls/recoverLostData");

/**
 * Runs the real recoverLostData copy script with busybox against throwaway
 * volumes. Needs a local Docker; skipped without one. Run with:
 *   yarn test:file test_/calls/recoverLostData.copy.test.int.js
 */
describe("recoverLostData copy script with REAL docker", function() {
  this.timeout(10 * 60 * 1000);
  const id = `${Date.now()}`;
  const volumes = [];
  const containers = [];
  const vol = name => {
    const v = `lostdata-int-${name}-${id}`;
    volumes.push(v);
    return v;
  };
  const SUFFIX = ".avado-recover-tmp-0000aaaa";
  const SUFFIX2 = ".avado-recover-tmp-1111bbbb";
  const inVol = (v, script) =>
    shell(`docker run --rm -v ${v}:/v busybox sh -c '${script}'`, {
      timeout: 5 * 60 * 1000
    });
  const result = promise =>
    promise.then(
      out => ({ code: 0, out }),
      e => ({ code: e.code, out: e.stdout || "", err: e.stderr || "" })
    );
  const copy = (from, to, suffix = SUFFIX) => {
    const name = `recover-data-int-${id}-${containers.length}`;
    containers.push(name);
    return result(
      shell(copyCommand(name, from, to, suffix), { timeout: 5 * 60 * 1000 })
    );
  };

  before(async function() {
    try {
      await shell("docker version --format '{{.Server.Version}}'");
    } catch (e) {
      this.skip();
    }
  });

  after(async () => {
    for (const c of containers) await shell(`docker rm -f ${c}`).catch(() => {});
    for (const v of volumes) await shell(`docker volume rm ${v}`).catch(() => {});
  });

  describe("merge", () => {
    let FROM, TO;
    before(async () => {
      FROM = vol("from");
      TO = vol("to");
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

    it("copies what is missing, keeps what exists, counts failures and goes on", async () => {
      const res = await copy(FROM, TO);
      expect(res.code).to.equal(1);
      expect(res.out).to.include("FILES 9");
      // a, data/Password.txt (a different key file), linked/child (parent is a symlink)
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

    it("finishes on a retry once the clash is gone; identical kept key files give no warning", async () => {
      await inVol(TO, "mv /v/clash /v/clash.kept");
      const res = await copy(FROM, TO, SUFFIX2);
      expect(res.code).to.equal(0);
      // data/wallet/w is now identical (copied by the first run): not a key
      // file any more; data/Password.txt still differs
      expect(res.out).to.match(/^FILES 9\nSKIPPED 8 1\n\d+\t\/to$/);
      const tmp = await inVol(TO, `find /v -name "*${SUFFIX2}" | wc -l`);
      expect(tmp).to.equal("0");
    });
  });

  describe("temporary names", () => {
    it("copies old entries that look like temporary names, and never touches live ones", async () => {
      const FROM = vol("tmpfrom");
      const TO = vol("tmpto");
      // the old volume has both x and a leftover-looking x.avado-recover-tmp-...
      await inVol(FROM, `echo X > /v/x && echo LEFT > /v/x${SUFFIX2} && echo Y > /v/y && echo W > /v/w`);
      // the live volume has a file and a folder named like temporary names of this run
      await inVol(TO, `echo LIVE > /v/y${SUFFIX} && mkdir /v/w${SUFFIX} && echo KEEP > /v/w${SUFFIX}/k`);
      const res = await copy(FROM, TO);
      // y and w cannot use their temporary name: they fail, the live
      // entries stay as they are, everything else is copied
      expect(res.code).to.equal(1);
      expect(res.out).to.include("FILES 4");
      expect(res.out).to.match(/FAILED 2 \.\/[yw]\n/);
      const listing = await inVol(TO, `cd /v && cat x x${SUFFIX2} y${SUFFIX} w${SUFFIX}/k && ls -A /v | sort`);
      expect(listing.split("\n")).to.deep.equal(
        ["X", "LEFT", "LIVE", "KEEP"].concat([`w${SUFFIX}`, "x", `x${SUFFIX2}`, `y${SUFFIX}`].sort())
      );
    });

    it("counts an entry as failed when mv -n did not move it (mv returns 0)", async () => {
      const FROM = vol("mvfrom");
      const TO = vol("mvto");
      await inVol(FROM, "echo A > /v/a && echo B > /v/b");
      const fakeMv = "mkdir -p /fakebin && echo \"exit 0\" > /fakebin/mv && chmod +x /fakebin/mv && PATH=/fakebin:$PATH && export PATH && ";
      const res = await result(
        shell(
          `docker run --rm -v ${FROM}:/from:ro -v ${TO}:/to busybox sh -c '${fakeMv}${copyScript(SUFFIX)}'`
        )
      );
      expect(res.code).to.equal(1);
      expect(res.out).to.include("FAILED 2 ./");
      const listing = await inVol(TO, "ls -A /v");
      expect(listing.split("\n").sort()).to.deep.equal([`a${SUFFIX}`, `b${SUFFIX}`]);
    });

    it("an interrupted copy leaves only the temporary file, and a retry finishes it", async () => {
      const FROM = vol("bigfrom");
      const TO = vol("bigto");
      await inVol(FROM, "dd if=/dev/zero of=/v/big bs=1M count=2000 2>/dev/null && echo small > /v/small");
      const name = `recover-data-int-${id}-kill`;
      containers.push(name);
      const running = result(shell(copyCommand(name, FROM, TO, SUFFIX), { timeout: 5 * 60 * 1000 }));
      // kill it as soon as the temporary file of big exists
      let seen = false;
      for (let i = 0; i < 200 && !seen; i++) {
        const ls = await shell(`docker exec ${name} ls /to`).catch(() => "");
        seen = ls.split("\n").includes(`big${SUFFIX}`);
        if (!seen) await new Promise(r => setTimeout(r, 50));
      }
      await shell(`docker rm -f ${name}`).catch(() => {});
      await running;
      expect(seen, "the copy finished before it could be interrupted").to.equal(true);
      const after = await inVol(TO, "ls -A /v");
      expect(after.split("\n")).to.include(`big${SUFFIX}`);
      expect(after.split("\n")).to.not.include("big");

      const res = await copy(FROM, TO, SUFFIX2);
      expect(res.code).to.equal(0);
      expect(res.out).to.match(/^FILES 2\n/);
      const sums = await shell(
        `docker run --rm -v ${FROM}:/a:ro -v ${TO}:/b:ro busybox sh -c 'cmp /a/big /b/big && echo SAME; ls -A /b'`,
        { timeout: 5 * 60 * 1000 }
      );
      expect(sums).to.include("SAME");
      // the leftover of the interrupted run is kept (nothing is deleted)
      expect(sums).to.include(`big${SUFFIX}`);
      expect(sums).to.not.include(`big${SUFFIX2}`);
    });
  });

  describe("walk check", () => {
    it("fails with FAILED walk when busybox cannot walk NUL-separated names (<= 1.31)", async function() {
      try {
        await shell("docker pull busybox:1.31", { timeout: 5 * 60 * 1000 });
      } catch (e) {
        this.skip();
      }
      const FROM = vol("oldbbfrom");
      const TO = vol("oldbbto");
      await inVol(FROM, "mkdir -p /v/data/wallet && echo w > /v/data/wallet/w && echo a > /v/a");
      const res = await result(
        shell(
          `docker run --rm -v ${FROM}:/from:ro -v ${TO}:/to busybox:1.31 sh -c '${copyScript(SUFFIX)}'`
        )
      );
      expect(res.code).to.equal(1);
      expect(res.out).to.include("FAILED walk 0/2");
    });
  });
});
