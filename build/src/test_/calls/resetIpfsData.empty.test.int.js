const expect = require("chai").expect;
const shell = require("utils/shell");
const { emptyCommand, leftCommand, sizeCommand } = require("calls/resetIpfsData");

/**
 * Runs the real resetIpfsData busybox commands against a throwaway volume
 * named like the IPFS data volume. Needs a local Docker; skipped without one.
 * Run with:
 *   yarn test:file test_/calls/resetIpfsData.empty.test.int.js
 */
describe("resetIpfsData empty step with REAL docker", function() {
  this.timeout(5 * 60 * 1000);
  const id = `${Date.now()}`;
  // Matches DATA_VOLUME_REGEX like dncore_ipfsdnpdappnodeeth_data does
  const VOL = `ipfsresetint${id}_ipfsdnpdappnodeeth_data`;
  const OTHER = `ipfsresetint${id}_ipfsdnpdappnodeeth_export`;
  const containers = [];
  const name = kind => {
    const n = `ipfs-reset-int-${kind}-${id}-${containers.length}`;
    containers.push(n);
    return n;
  };
  const inVol = (v, script) =>
    shell(`docker run --rm -v ${v}:/v busybox sh -c '${script}'`, {
      timeout: 2 * 60 * 1000
    });

  before(async function() {
    try {
      await shell("docker version --format '{{.Server.Version}}'");
    } catch (e) {
      this.skip();
    }
    // An IPFS-like repo: folders, hidden files, a name starting with two
    // dots, a symlink pointing out of the volume, read-only files
    await inVol(
      VOL,
      [
        "mkdir -p /v/blocks/CIQA /v/datastore /v/keystore",
        "head -c 2000000 /dev/urandom > /v/blocks/CIQA/big.data",
        "echo cfg > /v/config && echo 1 > /v/migrate3 && echo x > /v/repo.lock",
        "echo h > /v/.hidden && echo d > /v/..dots && mkdir /v/.cache && echo c > /v/.cache/c",
        'echo q > "/v/with space" && ln -s /etc /v/outside',
        "chmod 000 /v/keystore && chmod 444 /v/config"
      ].join(" && ")
    );
    await inVol(OTHER, "echo keep > /v/keep");
  });

  after(async () => {
    for (const c of containers) await shell(`docker rm -f ${c}`).catch(() => {});
    for (const v of [VOL, OTHER]) await shell(`docker volume rm ${v}`).catch(() => {});
  });

  it("measures the volume", async () => {
    const out = await shell(sizeCommand(name("du"), VOL));
    expect(parseInt(out, 10)).to.be.at.least(1900);
  });

  it("empties the volume, keeps the volume itself and leaves other volumes alone", async () => {
    await shell(emptyCommand(name("rm"), VOL));

    expect(await shell(leftCommand(name("ls"), VOL))).to.equal("");
    // the volume still exists under the same name
    const inspected = await shell(`docker volume inspect --format '{{.Name}}' ${VOL}`);
    expect(inspected).to.equal(VOL);
    expect(await inVol(OTHER, "cat /v/keep")).to.equal("keep");
  });

  it("emptying an empty volume succeeds again (safe to retry)", async () => {
    await shell(emptyCommand(name("rm"), VOL));
    expect(await shell(leftCommand(name("ls"), VOL))).to.equal("");
  });
});
