const expect = require("chai").expect;
const proxyquire = require("proxyquire");
const sinon = require("sinon");
const f = require("./fixtures");

describe("Module: diagnostics/containers", () => {
  const now = Date.parse("2026-10-14T10:00:00.123Z");

  function load(run) {
    return proxyquire("modules/diagnostics/containers", {
      "./exec": { run, runOk: async (...a) => (await run(...a)).stdout }
    });
  }

  it("formats a docker inspect entry", () => {
    const { formatContainer } = require("modules/diagnostics/containers");
    const c = formatContainer(f.tekuInspect, "Up 2 hours", now);
    expect(c).to.deep.equal({
      name: "DAppNodePackage-teku.avado.dnp.dappnode.eth",
      id: "teku.avado.dnp.dappnode.eth",
      isCore: false,
      image: "teku.avado.dnp.dappnode.eth:0.0.77",
      version: "0.0.77",
      state: "running",
      status: "Up 2 hours",
      exitCode: 0,
      oomKilled: false,
      restartCount: 0,
      startedAt: "2026-10-14T08:00:00.123456789Z",
      finishedAt: "2026-10-14T07:59:50.000000000Z",
      uptimeSeconds: 7200,
      health: null,
      processes: [],
      log: null,
      settings: null
    });
    expect(c.ip).to.equal("172.33.0.20");
    expect(c.running).to.equal(true);
    expect(Object.keys(JSON.parse(JSON.stringify(c)))).to.not.include("ip");

    const n = formatContainer(f.nethermindInspect, "Exited (137) 5 minutes ago", now);
    expect(n).to.include({ state: "exited", exitCode: 137, oomKilled: true, uptimeSeconds: null, health: "unhealthy" });
    const ipfs = formatContainer(f.ipfsInspect, "Restarting (1) 20 seconds ago", now);
    expect(ipfs).to.include({ id: "ipfs.dnp.dappnode.eth", isCore: true, state: "restarting", restartCount: 41, uptimeSeconds: null });
    expect(ipfs.running).to.equal(false);
  });

  it("parses supervisorctl status", () => {
    const { parseSupervisorStatus } = require("modules/diagnostics/containers");
    expect(parseSupervisorStatus(f.tekuSupervisor)).to.deep.equal([
      { name: "monitor", state: "RUNNING", description: "pid 31, uptime 1:59:58" },
      { name: "nginx", state: "RUNNING", description: "pid 32, uptime 1:59:58" },
      { name: "reload-certs", state: "RUNNING", description: "pid 33, uptime 1:59:58" },
      { name: "teku", state: "FATAL", description: "Exited too quickly (process log may have details)" }
    ]);
    expect(
      parseSupervisorStatus("lighthouse:lighthouse-vc   BACKOFF   Exited too quickly\nweb   STOPPING\nfoo   EXITED    Oct 14 09:00 AM")
    ).to.deep.equal([
      { name: "lighthouse:lighthouse-vc", state: "BACKOFF", description: "Exited too quickly" },
      { name: "web", state: "UNKNOWN", description: "STOPPING" },
      { name: "foo", state: "EXITED", description: "Oct 14 09:00 AM" }
    ]);
  });

  it("reads all DAppNode containers with one ps and ONE inspect", async () => {
    const run = sinon.stub().callsFake(async (file, args) => {
      if (args[0] === "ps") return { code: 0, stdout: f.psOutput, stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([f.ipfsInspect, f.nethermindInspect, f.tekuInspect]), stderr: "" };
      throw Error(`unexpected ${args.join(" ")}`);
    });
    const list = await load(run).readContainers({ now });
    expect(run.callCount).to.equal(2);
    expect(run.secondCall.args[1]).to.deep.equal([
      "inspect",
      "DAppNodeCore-ipfs.dnp.dappnode.eth",
      "DAppNodePackage-avado-dnp-nethermind.public.dappnode.eth",
      "DAppNodePackage-teku.avado.dnp.dappnode.eth"
    ]);
    expect(list.map(c => [c.id, c.status])).to.deep.equal([
      ["ipfs.dnp.dappnode.eth", "Restarting (1) 20 seconds ago"],
      ["avado-dnp-nethermind.public.dappnode.eth", "Exited (137) 5 minutes ago"],
      ["teku.avado.dnp.dappnode.eth", "Up 2 hours"]
    ]);
  });

  it("keeps the containers inspect printed when one vanished in between", async () => {
    const run = async (file, args) =>
      args[0] === "ps"
        ? { code: 0, stdout: f.psOutput, stderr: "" }
        : { code: 1, stdout: JSON.stringify([f.tekuInspect]), stderr: "Error: No such object: DAppNodeCore-ipfs.dnp.dappnode.eth" };
    const list = await load(run).readContainers({ now });
    expect(list.map(c => c.id)).to.deep.equal(["teku.avado.dnp.dappnode.eth"]);
  });

  const FIRST_LOOK =
    "if [ -f /etc/supervisord.conf ]; then echo __conf__=/etc/supervisord.conf; supervisorctl -c /etc/supervisord.conf status; exit 0; fi; " +
    "if [ -f /etc/supervisord/supervisord.conf ]; then echo __conf__=/etc/supervisord/supervisord.conf; supervisorctl -c /etc/supervisord/supervisord.conf status; exit 0; fi; " +
    "echo __no_supervisord__; exit 0";
  const firstLook = (conf, status) => `__conf__=${conf}\n${status}`;

  it("reads processes with supervisorctl when a supervisord config exists, [] when not", async () => {
    const calls = [];
    let answer = { code: 3, stdout: firstLook("/etc/supervisord.conf", f.tekuSupervisor), stderr: "" };
    const run = async (file, args, opts) => {
      calls.push({ args, opts });
      return answer;
    };
    const m = load(run);
    m._resetSupervisordCache();
    const p = await m.readProcesses("DAppNodePackage-teku.avado.dnp.dappnode.eth");
    expect(p).to.have.length(4);
    expect(p[3]).to.deep.equal({ name: "teku", state: "FATAL", description: "Exited too quickly (process log may have details)" });
    expect(calls[0].args).to.deep.equal(["exec", "DAppNodePackage-teku.avado.dnp.dappnode.eth", "sh", "-c", FIRST_LOOK]);
    expect(calls[0].opts).to.deep.equal({ timeout: 5000 });

    answer = { code: 0, stdout: "__no_supervisord__\n", stderr: "" };
    expect(await m.readProcesses("x")).to.deep.equal([]);
    answer = { code: 126, stdout: "", stderr: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown' };
    expect(await m.readProcesses("x")).to.deep.equal([]);
    answer = { code: 0, stdout: firstLook("/etc/supervisord.conf", "error: <class 'xmlrpc.client.Fault'>, <Fault 6: 'SHUTDOWN_STATE'>"), stderr: "" };
    let err;
    await m.readProcesses("x").catch(e => (err = e));
    expect(err.message).to.equal("error: <class 'xmlrpc.client.Fault'>, <Fault 6: 'SHUTDOWN_STATE'>");
  });

  it("a config but no supervisord running (bind): [] and no error", async () => {
    for (const said of [
      { stdout: firstLook("/etc/supervisord.conf", "unix:///run/supervisord.sock no such file"), code: 4 },
      { stdout: firstLook("/etc/supervisord.conf", "unix:///var/run/supervisor.sock refused connection"), code: 7 },
      { stdout: "__conf__=/etc/supervisord.conf", stderr: "error: <class 'ConnectionRefusedError'>, [Errno 111] Connection refused: file: /usr/lib/python3/dist-packages/supervisor/xmlrpc.py line: 560", code: 2 }
    ]) {
      const m = load(async () => Object.assign({ stderr: "" }, said));
      m._resetSupervisordCache();
      expect(await m.readProcesses("DAppNodeCore-bind.dnp.dappnode.eth", { cacheKey: "b|img" }), said.stdout).to.deep.equal([]);
    }
  });

  it("finds Qtum's /etc/supervisord/supervisord.conf and remembers that path", async () => {
    const calls = [];
    const status = "qtumd                            RUNNING   pid 10, uptime 3 days, 1:00:00";
    const m = load(async (file, args) => {
      calls.push(args);
      return args[2] === "sh"
        ? { code: 0, stdout: firstLook("/etc/supervisord/supervisord.conf", status), stderr: "" }
        : { code: 0, stdout: status, stderr: "" };
    });
    m._resetSupervisordCache();
    expect(await m.readProcesses("qtum", { cacheKey: "q|img" })).to.deep.equal([
      { name: "qtumd", state: "RUNNING", description: "pid 10, uptime 3 days, 1:00:00" }
    ]);
    await m.readProcesses("qtum", { cacheKey: "q|img" });
    expect(calls[1]).to.deep.equal(["exec", "qtum", "supervisorctl", "-c", "/etc/supervisord/supervisord.conf", "status"]);
  });

  it("remembers per container id + image where supervisord is: one exec per poll, none without it", async () => {
    const calls = [];
    const run = async (file, args) => {
      calls.push(args);
      if (args[1] === "busy") return { code: 0, stdout: "__no_supervisord__", stderr: "" };
      // supervisorctl exits 3 when a process is not running
      return args[2] === "supervisorctl"
        ? { code: 3, stdout: f.tekuSupervisor, stderr: "" }
        : { code: 0, stdout: firstLook("/etc/supervisord.conf", f.tekuSupervisor), stderr: "" };
    };
    const m = load(run);
    m._resetSupervisordCache();
    for (let poll = 0; poll < 3; poll++) {
      expect(await m.readProcesses("teku", { cacheKey: "c1|sha256:img1" })).to.have.length(4);
      expect(await m.readProcesses("busy", { cacheKey: "c2|sha256:img2" })).to.deep.equal([]);
    }
    expect(calls).to.have.length(4);
    expect(calls[0].slice(2, 4)).to.deep.equal(["sh", "-c"]);
    expect(calls[1].slice(1, 3)).to.deep.equal(["busy", "sh"]);
    // known to have supervisord: straight to supervisorctl, no `test -f`
    expect(calls[2]).to.deep.equal(["exec", "teku", "supervisorctl", "-c", "/etc/supervisord.conf", "status"]);
    expect(calls[3]).to.deep.equal(["exec", "teku", "supervisorctl", "-c", "/etc/supervisord.conf", "status"]);

    // a new image for the same container is looked at again
    await m.readProcesses("busy", { cacheKey: "c2|sha256:img3" });
    expect(calls).to.have.length(5);
    expect(calls[4].slice(2, 4)).to.deep.equal(["sh", "-c"]);
  });

  it("an exec error is reported and does not poison the cache", async () => {
    const calls = [];
    let answer = {
      code: 126,
      stdout: "",
      stderr: "OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown"
    };
    const m = load(async (file, args) => {
      calls.push(args);
      return answer;
    });
    m._resetSupervisordCache();
    let err;
    await m.readProcesses("teku", { cacheKey: "c1|img" }).catch(e => (err = e));
    expect(err.message).to.equal("OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown");
    // looked at again on the next poll, and found
    answer = { code: 3, stdout: firstLook("/etc/supervisord.conf", f.tekuSupervisor), stderr: "" };
    expect(await m.readProcesses("teku", { cacheKey: "c1|img" })).to.have.length(4);
    expect(calls.map(a => a[2])).to.deep.equal(["sh", "sh"]);
  });

  it("the cache key is the container id + image id, not returned", () => {
    const { formatContainer } = require("modules/diagnostics/containers");
    const c = formatContainer(f.tekuInspect, "Up", now);
    expect(c.cacheKey).to.equal(`${f.tekuInspect.Id}|${f.tekuInspect.Image}`);
    expect(JSON.stringify(c)).to.not.include("cacheKey");
  });

  it("summarizes logs: time order, last 40 lines, last 5 errors, the error count, scrubbed", () => {
    const { summarizeLogs } = require("modules/diagnostics/containers");
    const many = Array.from({ length: 60 }, (_, i) => `2026-10-14T09:00:${String(i).padStart(2, "0")}.000000000Z line ${i}${i % 10 === 0 ? " error" : ""}`);
    // stderr lines arrive after stdout's even when they are older
    const out = [...many.slice(30), ...many.slice(0, 30)].join("\n") + "\n" + f.tekuLogs;
    const s = summarizeLogs(out);
    expect(s.lines).to.have.length(40);
    expect(s.lines[0]).to.include("line 24");
    expect(s.lines[35]).to.include("line 59");
    expect(s.lines[39]).to.equal("2026-10-14T09:58:02.000000001Z 09:58:02.000 FATAL - Exiting due to fatal error");
    expect(s.errorCount).to.equal(6 + 2);
    expect(s.errors).to.have.length(5);
    expect(s.errors[3]).to.include("Failed to load initial state");
    expect(JSON.stringify(s)).to.not.include(f.SECRET);
    expect(s.lines.join("\n")).to.include("password=<redacted>");
  });

  it("reads logs with docker logs --tail 500 --timestamps", async () => {
    let args;
    const m = load(async (file, a) => {
      args = a;
      return { code: 0, stdout: "", stderr: "", combined: f.tekuLogs };
    });
    const s = await m.readLog("DAppNodePackage-teku.avado.dnp.dappnode.eth");
    expect(args).to.deep.equal(["logs", "--tail", "500", "--timestamps", "DAppNodePackage-teku.avado.dnp.dappnode.eth"]);
    expect(s.errorCount).to.equal(2);
  });

  it("reads settings without secrets, null when the file is missing", async () => {
    let answer = {
      code: 0,
      stdout: JSON.stringify({ ee_endpoint: "http://x:8551", keymanager_token: "t", initial_state: "https://a:b@cp.example/" }),
      stderr: ""
    };
    let args;
    const m = load(async (file, a) => {
      args = a;
      return answer;
    });
    expect(await m.readSettings("c", "/data/settings.json")).to.deep.equal({
      ee_endpoint: "http://x:8551",
      initial_state: "https://<redacted>@cp.example/"
    });
    expect(args).to.deep.equal(["exec", "c", "cat", "/data/settings.json"]);
    answer = { code: 1, stdout: "", stderr: "cat: /data/settings.json: No such file or directory" };
    expect(await m.readSettings("c", "/data/settings.json")).to.equal(null);
    // double-encoded: parses to a string; arrays and numbers neither
    for (const stdout of [JSON.stringify(JSON.stringify({ a: 1 })), "[1,2]", "42", "null"]) {
      answer = { code: 0, stdout, stderr: "" };
      let err;
      await m.readSettings("c", "/data/settings.json").catch(e => (err = e));
      expect(err && err.message, stdout).to.equal("not an object");
    }
  });
});
