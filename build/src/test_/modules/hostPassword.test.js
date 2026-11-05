const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();
const { EventEmitter } = require("events");

/**
 * A fake `docker` CLI: records each spawn (args + what was written to its
 * stdin) and answers with the word `reply(args, stdin)` returns.
 */
function fakeDocker(reply) {
  const runs = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const run = { file, args, stdin: "" };
    runs.push(run);
    child.stdin = {
      on() {},
      end(input) {
        run.stdin = input || "";
        setImmediate(() => {
          const r = reply(args, run.stdin) || {};
          if (r.stderr) child.stderr.emit("data", Buffer.from(r.stderr));
          if (r.word) child.stdout.emit("data", Buffer.from(r.word + "\n"));
          child.emit("close", r.code === undefined ? 0 : r.code);
        });
      }
    };
    // docker rm -f: no stdin written
    if (args[0] === "rm") setImmediate(() => child.emit("close", 0));
    return child;
  };
  return { spawn, runs };
}

function load(reply) {
  const docker = fakeDocker(reply);
  const logged = [];
  const hostPassword = proxyquire("modules/hostPassword", {
    child_process: { spawn: docker.spawn },
    "utils/getDappmanagerImage": async () => "dappmanager.dnp.dappnode.eth:10.0.57",
    "logs.js": () => ({
      info: m => logged.push(m),
      warn: m => logged.push(m),
      error: m => logged.push(m),
      debug: m => logged.push(m)
    })
  });
  hostPassword._reset();
  hostPassword._setTimings({ wrongDelayMs: 0 });
  return { hostPassword, runs: docker.runs, logged };
}

// A host whose avado password is `current`; a change stores the new one
function fakeHost(initial = "avado") {
  const host = { password: initial };
  host.reply = (args, stdin) => {
    if (args[0] === "rm") return {};
    const mode = args[args.length - 1];
    const [a, b] = stdin.split("\n");
    if (a !== host.password) return { word: "WRONG" };
    if (mode === "check") return { word: "MATCH" };
    host.password = b;
    return { word: "CHANGED" };
  };
  return host;
}

describe("Module: hostPassword", () => {
  describe("changePassword", () => {
    it("checks the current password and changes it on the host, passwords on stdin only", async () => {
      const host = fakeHost("avado");
      const { hostPassword, runs, logged } = load(host.reply);
      await hostPassword.changePassword({ currentPassword: "avado", newPassword: "correct horse 42" });
      expect(host.password).to.equal("correct horse 42");
      expect(runs).to.have.length(1);
      const { file, args, stdin } = runs[0];
      expect(file).to.equal("docker");
      expect(stdin).to.equal("avado\ncorrect horse 42\n");
      // Neither password in an argument
      expect(args.join(" ")).to.not.include("correct horse 42");
      expect(args.some(a => a === "avado")).to.equal(false);
      expect(args).to.include.members(["run", "--rm", "-i", "--privileged", "--entrypoint", "chroot", "/host", "/usr/bin/perl"]);
      expect(args[args.length - 1]).to.equal("change");
      expect(args).to.not.include("-e PASS");
      expect(logged.join(" ")).to.not.include("correct horse 42");
    });

    it("refuses a wrong current password with a plain message and changes nothing", async () => {
      const host = fakeHost("my old secret");
      const { hostPassword, logged } = load(host.reply);
      let err;
      try {
        await hostPassword.changePassword({ currentPassword: "guess1234", newPassword: "brand new 1234" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("The current password is wrong.");
      expect(host.password).to.equal("my old secret");
      expect(logged.join(" ")).to.not.match(/guess1234|brand new 1234/);
    });

    it("stops accepting tries after 5 wrong ones", async () => {
      const host = fakeHost("my old secret");
      const { hostPassword, runs } = load(host.reply);
      for (let i = 0; i < 5; i++) {
        await hostPassword.changePassword({ currentPassword: `guess${i}xyz`, newPassword: "brand new 1234" }).catch(() => {});
      }
      expect(runs).to.have.length(5);
      let err;
      try {
        await hostPassword.changePassword({ currentPassword: "my old secret", newPassword: "brand new 1234" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("Too many wrong tries. Wait 10 minutes and try again.");
      expect(runs).to.have.length(5);
      expect(host.password).to.equal("my old secret");
    });

    const weak = [
      [{ currentPassword: "", newPassword: "long enough 1" }, "Type your current password."],
      [{ currentPassword: "avado", newPassword: "" }, "Type a new password."],
      [{ currentPassword: "avado", newPassword: "short" }, "The new password must have at least 8 characters."],
      [{ currentPassword: "avado", newPassword: "avado" }, "Choose a password other than avado."],
      [{ currentPassword: "avado", newPassword: "AVADO   " }, "Choose a password other than avado."],
      [{ currentPassword: "my old secret", newPassword: "my old secret" }, "The new password must be different from the current one."],
      [{ currentPassword: "avado", newPassword: "line\nbreak 123" }, "The new password cannot contain line breaks or other control characters."],
      [{ currentPassword: "avado", newPassword: "x".repeat(129) }, "The new password can have at most 128 characters."],
      [{ currentPassword: "avado", newPassword: 12345678 }, "Type a new password."]
    ];
    for (const [kwargs, message] of weak) {
      it(`refuses before touching the host: ${message} (${JSON.stringify(kwargs.newPassword).slice(0, 20)})`, async () => {
        const host = fakeHost("avado");
        const { hostPassword, runs } = load(host.reply);
        let err;
        try {
          await hostPassword.changePassword(kwargs);
        } catch (e) {
          err = e;
        }
        expect(err && err.message).to.equal(message);
        expect(runs).to.have.length(0);
      });
    }

    it("counts characters, not bytes: 8 accented letters are enough", async () => {
      const host = fakeHost("avado");
      const { hostPassword } = load(host.reply);
      await hostPassword.changePassword({ currentPassword: "avado", newPassword: "čšžčšžčš" });
      expect(host.password).to.equal("čšžčšžčš");
    });

    it("a current password with a line break is wrong without a host run", async () => {
      const { hostPassword, runs } = load(fakeHost("avado").reply);
      let err;
      try {
        await hostPassword.changePassword({ currentPassword: "avado\nx", newPassword: "brand new 1234" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal("The current password is wrong.");
      expect(runs).to.have.length(0);
    });

    it("a failing host run is a plain message; neither password nor stderr is logged", async () => {
      const { hostPassword, logged } = load((args, stdin) =>
        args[0] === "rm" ? {} : { code: 1, stderr: `chpasswd: (user avado) pam_chauthtok() failed ${stdin}` }
      );
      let err;
      try {
        await hostPassword.changePassword({ currentPassword: "avado", newPassword: "brand new 1234" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal(hostPassword.MESSAGES.failed);
      expect(logged.join(" ")).to.not.match(/brand new 1234|pam_chauthtok/);
    });

    it("FAIL from the host (the new hash did not check out) is the plain failure", async () => {
      const { hostPassword } = load(args => (args[0] === "rm" ? {} : { word: "FAIL" }));
      let err;
      try {
        await hostPassword.changePassword({ currentPassword: "avado", newPassword: "brand new 1234" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal(hostPassword.MESSAGES.failed);
    });

    it("no avado user", async () => {
      const { hostPassword } = load(args => (args[0] === "rm" ? {} : { word: "NOUSER" }));
      let err;
      try {
        await hostPassword.changePassword({ currentPassword: "avado", newPassword: "brand new 1234" });
      } catch (e) {
        err = e;
      }
      expect(err.message).to.equal(hostPassword.MESSAGES.noUser);
    });

    it("removes a container left over by an earlier run and tries again", async () => {
      const host = fakeHost("avado");
      let first = true;
      const { hostPassword, runs } = load((args, stdin) => {
        if (args[0] === "rm") return {};
        if (first) {
          first = false;
          return { code: 125, stderr: 'Conflict. The container name "/dappmanager-passwd-host" is already in use' };
        }
        return host.reply(args, stdin);
      });
      await hostPassword.changePassword({ currentPassword: "avado", newPassword: "brand new 1234" });
      expect(runs.map(r => r.args[0])).to.deep.equal(["run", "rm", "run"]);
      expect(host.password).to.equal("brand new 1234");
    });
  });

  describe("isDefaultPassword", () => {
    it("true while the password is avado, false after a change, without a second host run within a minute", async () => {
      const host = fakeHost("avado");
      const { hostPassword, runs } = load(host.reply);
      expect(await hostPassword.isDefaultPassword()).to.equal(true);
      expect(runs[0].stdin).to.equal("avado\n");
      expect(runs[0].args[runs[0].args.length - 1]).to.equal("check");
      expect(await hostPassword.isDefaultPassword()).to.equal(true);
      expect(runs).to.have.length(1);
      await hostPassword.changePassword({ currentPassword: "avado", newPassword: "brand new 1234" });
      expect(await hostPassword.isDefaultPassword()).to.equal(false);
      expect(runs).to.have.length(2);
    });

    it("concurrent callers share one host run", async () => {
      const { hostPassword, runs } = load(fakeHost("something else").reply);
      const answers = await Promise.all([hostPassword.isDefaultPassword(), hostPassword.isDefaultPassword()]);
      expect(answers).to.deep.equal([false, false]);
      expect(runs).to.have.length(1);
    });

    it("null when the check cannot run, logged once", async () => {
      const { hostPassword, logged } = load(args => (args[0] === "rm" ? {} : { code: 125, stderr: "no such image" }));
      expect(await hostPassword.isDefaultPassword()).to.equal(null);
      expect(logged).to.have.length(1);
    });

    it("a wrong check does not count as a wrong try", async () => {
      const host = fakeHost("my old secret");
      const { hostPassword } = load(host.reply);
      expect(await hostPassword.isDefaultPassword()).to.equal(false);
      await hostPassword.changePassword({ currentPassword: "my old secret", newPassword: "brand new 1234" });
      expect(host.password).to.equal("brand new 1234");
    });
  });

  describe("PERL_SCRIPT", () => {
    it("names no password and reads them from stdin", () => {
      const { hostPassword } = load(() => ({}));
      expect(hostPassword.PERL_SCRIPT).to.include("<STDIN>");
      expect(hostPassword.PERL_SCRIPT).to.include('open(my $p, "|-", "chpasswd")');
      expect(hostPassword.PERL_SCRIPT).to.include("crypt($pw, $h)");
      // The JS template must have produced a valid perl regex for "$..."
      expect(hostPassword.PERL_SCRIPT).to.include("$h =~ /^\\$/");
    });
  });
});
