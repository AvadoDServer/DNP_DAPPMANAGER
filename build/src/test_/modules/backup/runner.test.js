const expect = require("chai").expect;
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const runner = require("modules/backup/runner");

function fakeChild(script) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const written = [];
  child.stdin.on("data", d => written.push(...d.toString().split("\n").filter(Boolean)));
  setImmediate(() => script(child, written));
  return { child, written };
}

describe("modules > backup > runner", () => {
  afterEach(() => runner._setSpawn(null));

  it("builds docker args: no network and /dev for a USB disk, secrets on a tmpfs, no log driver", () => {
    const args = runner.helperArgs({
      image: "dappmanager.dnp.dappnode.eth:10.0.58",
      name: "run",
      targetType: "usb",
      mounts: [{ host: "/var/lib/docker/volumes/a_data", dir: "/vol/0", ro: true }],
      stage: true
    });
    const s = args.join(" ");
    expect(s).to.include("--network none");
    expect(s).to.include("-v /dev:/dev");
    expect(s).to.include("--tmpfs /run/secrets");
    expect(s).to.include("--log-driver none");
    expect(s).to.include("-v /var/lib/docker/volumes/a_data:/vol/0:ro");
    expect(s).to.include("-v avado-backup-stage:/stage");
    expect(args.slice(-4)).to.deep.equal([
      "--entrypoint",
      "node",
      "dappmanager.dnp.dappnode.eth:10.0.58",
      "/usr/src/app/src/modules/backup/helper.js"
    ]);
    const nas = runner.helperArgs({ image: "i", name: "x", targetType: "smb" }).join(" ");
    expect(nas).to.include("--network bridge");
    expect(nas).to.not.include("/dev:/dev");
  });

  it("refuses odd mount paths", () => {
    expect(() => runner.helperArgs({ image: "i", name: "x", targetType: "usb", mounts: [{ host: "/a:/b", dir: "/vol/0" }] })).to.throw();
    expect(() => runner.helperArgs({ image: "i", name: "x", targetType: "usb", mounts: [{ host: "/a", dir: "/etc" }] })).to.throw();
  });

  it("sends the job (with its secret) only on stdin, pauses and resumes, returns the result", async () => {
    let spawnedArgs;
    let job;
    const order = [];
    runner._setSpawn((cmd, args) => {
      spawnedArgs = args;
      const { child } = fakeChild(async (c, w) => {
        c.stdout.write(JSON.stringify({ ev: "pause", name: "vaultwarden" }) + "\n");
        await new Promise(r => setTimeout(r, 30));
        order.push(`helper saw ${w[1]}`);
        c.stdout.write(JSON.stringify({ ev: "resume", name: "vaultwarden" }) + "\n");
        c.stdout.write(JSON.stringify({ ev: "progress", percent: 0.5 }) + "\n");
        c.stdout.write(JSON.stringify({ ev: "result", packages: [{ name: "vaultwarden", ok: true }] }) + "\n");
        job = JSON.parse(w[0]);
        c.emit("close", 0);
      });
      return child;
    });
    const events = [];
    const res = await runner.runHelper(
      { op: "backup", passphrase: "correct horse battery" },
      { image: "img", name: "run", targetType: "usb" },
      {
        onPause: async n => order.push(`pause ${n}`),
        onResume: async n => order.push(`resume ${n}`),
        onEvent: ev => events.push(ev.ev)
      }
    );
    expect(res.packages[0].ok).to.equal(true);
    expect(job.passphrase).to.equal("correct horse battery");
    expect(spawnedArgs.join(" ")).to.not.include("correct horse");
    expect(order).to.deep.equal(["pause vaultwarden", "helper saw go", "resume vaultwarden"]);
    expect(events).to.deep.equal(["progress"]);
  });

  it("turns a helper error into an Error with its code", async () => {
    runner._setSpawn(() =>
      fakeChild(c => {
        c.stdout.write(JSON.stringify({ ev: "error", code: "wrongPassphrase", message: "The passphrase is wrong." }) + "\n");
        c.emit("close", 1);
      }).child
    );
    try {
      await runner.runHelper({ op: "list" }, { image: "img", name: "list", targetType: "usb" });
      throw Error("no");
    } catch (e) {
      expect(e.code).to.equal("wrongPassphrase");
      expect(e.message).to.equal("The passphrase is wrong.");
    }
  });
});
