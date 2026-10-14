const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();
const realContainers = require("modules/diagnostics/containers");
const realClients = require("modules/diagnostics/clients");
const f = require("../modules/diagnostics/fixtures");

describe("Call: getDiagnostics", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");
  const never = () => new Promise(() => {});

  function setup(over = {}) {
    const calls = [];
    const record = (name, fn) => (...args) => {
      calls.push(name);
      return fn(...args);
    };
    const host = {
      HOST_TIMEOUT: 10000,
      runHostScript: record("host", over.runHostScript || (async () => ({ output: "HOST OUTPUT", error: null }))),
      parseHostOutput: () => ({
        host: { uptimeSeconds: 600, bootedAt: "2026-10-14T09:50:00.000Z" },
        network: {
          interfaces: [{ name: "wlp3s0", type: "wifi", up: true, carrier: true, ipv4: ["192.168.1.23"] }],
          defaultRoute: { interface: "wlp3s0", gateway: "192.168.1.1" }
        }
      })
    };
    const network = {
      checkDns: record("dns", over.checkDns || (async () => ({ resolves: { "bo.ava.do": { ok: true, ms: 3 } } }))),
      checkInternet: record("internet", async () => ({ "https://bo.ava.do/": { ok: true, status: 200, ms: 40 } })),
      readIpfsStore: record("ipfs", async () => ({ running: true, peers: 0, storePeersConnected: 0, storePeersTotal: 1 })),
      checkCatalogue: record("catalogue", async () => ({ ok: false, ms: 8000, error: "IPFS: Ipfs hash not available: QmStore" }))
    };
    const containers = {
      readContainers: record(
        "containers",
        over.readContainers ||
          (async () => [
            realContainers.formatContainer(f.tekuInspect, "Up 2 hours", now),
            realContainers.formatContainer(f.nethermindInspect, "Exited (137) 5 minutes ago", now)
          ])
      ),
      readProcesses: record("processes", over.readProcesses || (async () => realContainers.parseSupervisorStatus(f.tekuSupervisor))),
      readLog: record("logs", async () => realContainers.summarizeLogs(f.tekuLogs)),
      readSettings: record("settings", over.readSettings || (async () => ({ ee_endpoint: "http://avado-dnp-nethermind.my.ava.do:8551" })))
    };
    const clients = {
      getClient: realClients.getClient,
      probeClient: record("client", async (client, c) => ({
        id: client.name,
        role: client.role,
        client: client.client,
        network: client.network,
        api: c.running ? { reachable: false, error: "fetch failed: ECONNREFUSED" } : { reachable: false, error: "the container is not running" },
        validators: null
      }))
    };
    const getDiagnostics = proxyquire("calls/getDiagnostics", {
      "modules/diagnostics/host": host,
      "modules/diagnostics/network": network,
      "modules/diagnostics/containers": containers,
      "modules/diagnostics/clients": clients
    });
    return { getDiagnostics, calls };
  }

  it("collects everything when asked for everything", async () => {
    const { getDiagnostics, calls } = setup();
    const { message, result } = await getDiagnostics({});
    expect(message).to.equal("Collected diagnostics");
    expect(result.errors).to.deep.equal([]);
    expect(result.collectedAt).to.be.a("string");
    expect(result.durationMs).to.be.a("number");
    expect(result.host).to.deep.equal({ uptimeSeconds: 600, bootedAt: "2026-10-14T09:50:00.000Z" });
    expect(result.network.defaultRoute).to.deep.equal({ interface: "wlp3s0", gateway: "192.168.1.1" });
    expect(result.network.interfaces).to.have.length(1);
    expect(result.network.dns.resolves["bo.ava.do"].ok).to.equal(true);
    expect(result.network.internet["https://bo.ava.do/"].ok).to.equal(true);
    expect(result.network.store.ipfs.storePeersConnected).to.equal(0);
    expect(result.network.store.catalogue).to.include({ ok: false });

    const [teku, nethermind] = result.containers;
    expect(teku.processes.find(p => p.name === "teku").state).to.equal("FATAL");
    expect(teku.log.errorCount).to.equal(2);
    expect(teku.settings).to.deep.equal({ ee_endpoint: "http://avado-dnp-nethermind.my.ava.do:8551" });
    // not running: no docker exec, but its logs are read
    expect(nethermind.processes).to.deep.equal([]);
    expect(nethermind.settings).to.equal(null);
    expect(nethermind.log).to.not.equal(null);
    expect(result.clients.map(c => c.id)).to.deep.equal([
      "avado-dnp-nethermind.public.dappnode.eth",
      "teku.avado.dnp.dappnode.eth"
    ]);
    // ONE host run; processes and settings only for the running container
    expect(calls.filter(c => c === "host")).to.have.length(1);
    expect(calls.filter(c => c === "processes")).to.have.length(1);
    expect(calls.filter(c => c === "settings")).to.have.length(1);
    expect(calls.filter(c => c === "logs")).to.have.length(2);

    const json = JSON.stringify(result);
    expect(json).to.not.include(f.SECRET);
    expect(json).to.not.include("172.33.0.20");
  });

  it("the Admin's 60 s poll: containers and processes only, no host run and no docker logs", async () => {
    const { getDiagnostics, calls } = setup();
    const { result } = await getDiagnostics({ host: false, network: false, logs: false, clients: false });
    expect(result.host).to.equal(null);
    expect(result.network).to.equal(null);
    expect(result.clients).to.equal(null);
    expect(result.containers[0].log).to.equal(null);
    expect(result.containers[0].settings).to.equal(null);
    expect(result.containers[0].processes).to.have.length(4);
    expect([...new Set(calls)].sort()).to.deep.equal(["containers", "processes"]);
  });

  it("the light poll, against the real modules: no docker run, no docker logs, exec only into running containers with supervisord", async () => {
    const pq = require("proxyquire");
    const dockerCalls = [];
    const busyboxInspect = Object.assign({}, f.tekuInspect, {
      Id: "busy1",
      Image: "sha256:busy",
      Name: "/DAppNodeCore-vpn.dnp.dappnode.eth",
      Config: { Image: "vpn.dnp.dappnode.eth:0.2.8" }
    });
    const ps = [
      "DAppNodePackage-teku.avado.dnp.dappnode.eth\tUp 2 hours",
      "DAppNodePackage-avado-dnp-nethermind.public.dappnode.eth\tExited (137) 5 minutes ago",
      "DAppNodeCore-vpn.dnp.dappnode.eth\tUp 3 days"
    ].join("\n");
    const run = async (file, args) => {
      dockerCalls.push([file, ...args]);
      if (args[0] === "ps") return { code: 0, stdout: ps, stderr: "" };
      if (args[0] === "inspect")
        return { code: 0, stdout: JSON.stringify([f.tekuInspect, f.nethermindInspect, busyboxInspect]), stderr: "" };
      if (args[0] === "exec" && args[1] === "DAppNodeCore-vpn.dnp.dappnode.eth")
        return { code: 0, stdout: "__no_supervisord__", stderr: "" };
      if (args[0] === "exec")
        return args[2] === "supervisorctl"
          ? { code: 3, stdout: f.tekuSupervisor, stderr: "" }
          : { code: 0, stdout: `__conf__=/etc/supervisord.conf\n${f.tekuSupervisor}`, stderr: "" };
      throw Error(`unexpected docker ${args.join(" ")}`);
    };
    const exec = { run, runOk: async (...a) => (await run(...a)).stdout };
    const realC = pq("modules/diagnostics/containers", { "./exec": exec });
    realC._resetSupervisordCache();
    const realH = pq("modules/diagnostics/host", { "./exec": exec });
    const forbidden = () => {
      throw Error("not in the light poll");
    };
    const getDiagnostics = proxyquire("calls/getDiagnostics", {
      "modules/diagnostics/host": realH,
      "modules/diagnostics/containers": realC,
      "modules/diagnostics/network": { checkDns: forbidden, checkInternet: forbidden, readIpfsStore: forbidden, checkCatalogue: forbidden },
      "modules/diagnostics/clients": { getClient: forbidden, probeClient: forbidden }
    });
    const light = { host: false, network: false, logs: false, clients: false };
    for (let poll = 0; poll < 3; poll++) {
      // three polls more than 10 s apart: no shared result
      getDiagnostics._resetCache();
      const { result } = await getDiagnostics(light);
      expect(result.errors).to.deep.equal([]);
      expect(result.containers.find(c => c.id === "teku.avado.dnp.dappnode.eth").processes).to.have.length(4);
    }
    const docker = dockerCalls.map(c => c.slice(1));
    expect(docker.filter(a => a[0] === "run")).to.deep.equal([]);
    expect(docker.filter(a => a[0] === "logs")).to.deep.equal([]);
    const execs = docker.filter(a => a[0] === "exec");
    // never into the exited Nethermind
    expect(execs.filter(a => a[1].includes("nethermind"))).to.deep.equal([]);
    // first poll: one look each; then only teku, straight to supervisorctl; vpn never again
    expect(execs.map(a => `${a[1]} ${a[2]}`)).to.deep.equal([
      "DAppNodePackage-teku.avado.dnp.dappnode.eth sh",
      "DAppNodeCore-vpn.dnp.dappnode.eth sh",
      "DAppNodePackage-teku.avado.dnp.dappnode.eth supervisorctl",
      "DAppNodePackage-teku.avado.dnp.dappnode.eth supervisorctl"
    ]);
    expect(docker.filter(a => a[0] !== "exec").map(a => a[0])).to.deep.equal(["ps", "inspect", "ps", "inspect", "ps", "inspect"]);
  });

  it("network only still runs the host script once, for the interfaces", async () => {
    const { getDiagnostics, calls } = setup();
    const { result } = await getDiagnostics({ host: false, network: true, logs: false, clients: false });
    expect(result.host).to.equal(null);
    expect(result.network.interfaces).to.have.length(1);
    expect(calls.filter(c => c === "host")).to.have.length(1);
  });

  it("a failing probe lands in errors and the rest is returned", async () => {
    const { getDiagnostics } = setup({
      runHostScript: async () => {
        throw Error("Unable to find image 'busybox:latest' locally");
      },
      checkDns: async () => {
        throw Error("boom");
      }
    });
    const { message, result } = await getDiagnostics();
    expect(result.errors).to.deep.equal(["host: Unable to find image 'busybox:latest' locally", "dns: boom"]);
    expect(message).to.equal("Collected diagnostics with 2 problems");
    expect(result.host).to.equal(null);
    expect(result.network.interfaces).to.equal(null);
    expect(result.network.dns).to.equal(null);
    expect(result.network.internet["https://bo.ava.do/"].ok).to.equal(true);
    expect(result.containers).to.have.length(2);
  });

  it("a host run cut short keeps what it read and says so", async () => {
    const { getDiagnostics } = setup({
      runHostScript: async () => ({ output: "PARTIAL", error: "timed out after 10 s, kept the sections read until then" })
    });
    const { result } = await getDiagnostics({});
    expect(result.errors).to.deep.equal(["host: timed out after 10 s, kept the sections read until then"]);
    expect(result.host).to.not.equal(null);
    expect(result.network.interfaces).to.have.length(1);
  });

  it("a host run that never ends returns its partial sections within the cap", async () => {
    const pq = require("proxyquire");
    const partial = "### uptime\n7260.51 1.00\n### loadavg\n0.5 0.4 0.3 1/2 3\n### hwmon\n";
    const exec = {
      run: (file, args, opts) =>
        args[0] === "run"
          ? new Promise((resolve, reject) =>
              setTimeout(() => reject(Object.assign(Error("timed out after 0 s"), { timedOut: true, stdout: partial })), opts.timeout)
            )
          : new Promise(() => {}) // docker rm -f stuck behind the hung read
    };
    const realH = pq("modules/diagnostics/host", { "./exec": exec });
    realH._setHostTimeout(30);
    const getDiagnostics = proxyquire("calls/getDiagnostics", {
      "modules/diagnostics/host": realH,
      "modules/diagnostics/containers": { readContainers: async () => [] },
      "modules/diagnostics/network": {},
      "modules/diagnostics/clients": {}
    });
    getDiagnostics._setCapMs(500);
    try {
      const t0 = Date.now();
      const { result } = await getDiagnostics({ host: true, network: false, logs: false, clients: false });
      expect(Date.now() - t0).to.be.below(400);
      expect(result.errors).to.deep.equal(["host: timed out after 0 s, kept the sections read until then"]);
      expect(result.host.uptimeSeconds).to.equal(7260);
      expect(result.host.loadavg).to.deep.equal([0.5, 0.4, 0.3]);
    } finally {
      getDiagnostics._setCapMs(24000);
    }
  });

  it("a settings file that is not an object: settings null and an error", async () => {
    const { getDiagnostics } = setup({
      readSettings: async () => {
        throw Error("not an object");
      }
    });
    const { result } = await getDiagnostics({});
    expect(result.errors).to.deep.equal(["settings teku.avado.dnp.dappnode.eth: not an object"]);
    expect(result.containers[0].settings).to.equal(null);
  });

  it("a failing containers probe leaves containers and clients empty", async () => {
    const { getDiagnostics } = setup({
      readContainers: async () => {
        throw Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
      }
    });
    const { result } = await getDiagnostics({});
    expect(result.containers).to.deep.equal([]);
    expect(result.clients).to.deep.equal([]);
    expect(result.errors).to.deep.equal(["containers: Cannot connect to the Docker daemon at unix:///var/run/docker.sock"]);
  });

  it("returns at the cap and names what has not finished", async () => {
    const { getDiagnostics } = setup({ runHostScript: never, readContainers: never });
    getDiagnostics._setCapMs(60);
    try {
      const t0 = Date.now();
      const { result } = await getDiagnostics({ host: true, network: false, logs: false, clients: false });
      expect(Date.now() - t0).to.be.below(1000);
      expect(result.errors.sort()).to.deep.equal(["containers: timed out", "host: timed out"]);
      expect(result.host).to.equal(null);
      expect(result.containers).to.deep.equal([]);
    } finally {
      getDiagnostics._setCapMs(24000);
    }
  });

  it("at the cap, docker jobs still waiting for their turn are named too", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      realContainers.formatContainer(
        Object.assign({}, f.tekuInspect, { Name: `/DAppNodePackage-app${i}.avado.dnp.dappnode.eth` }),
        "Up",
        now
      )
    );
    // every docker exec hangs: 6 run, 2 wait for a turn
    const { getDiagnostics, calls } = setup({ readContainers: async () => many, readProcesses: never });
    getDiagnostics._setCapMs(60);
    try {
      const { result } = await getDiagnostics({ host: false, network: false, logs: false, clients: false });
      expect(calls.filter(c => c === "processes")).to.have.length(6);
      expect(result.errors.sort()).to.deep.equal(
        many.map(c => `processes ${c.id}: timed out`).sort()
      );
    } finally {
      getDiagnostics._setCapMs(24000);
    }
  });

  it("after the cap, docker jobs still waiting for a turn are dropped, not started", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      realContainers.formatContainer(
        Object.assign({}, f.tekuInspect, { Name: `/DAppNodePackage-app${i}.avado.dnp.dappnode.eth` }),
        "Up",
        now
      )
    );
    const slow = () => new Promise(r => setTimeout(() => r([]), 100));
    const { getDiagnostics, calls } = setup({ readContainers: async () => many, readProcesses: slow });
    getDiagnostics._setCapMs(50);
    try {
      const { result } = await getDiagnostics({ host: false, network: false, logs: false, clients: false });
      expect(result.errors).to.have.length(8);
      await new Promise(r => setTimeout(r, 250));
      // the first 6 finished after the cap; the 2 queued ones never ran
      expect(calls.filter(c => c === "processes")).to.have.length(6);
    } finally {
      getDiagnostics._setCapMs(24000);
    }
  });

  it("concurrent callers of the same variant share one collection; the result is reused for 20 s (10 s light)", async () => {
    const { getDiagnostics, calls } = setup();
    let t = 1000000;
    getDiagnostics._setClock(() => t);
    const count = name => calls.filter(c => c === name).length;

    const [a, b] = await Promise.all([getDiagnostics({}), getDiagnostics({ host: true })]);
    expect(a).to.equal(b);
    expect(count("host")).to.equal(1);
    t += 19 * 1000;
    expect(await getDiagnostics({})).to.equal(a);
    expect(count("host")).to.equal(1);
    t += 2 * 1000;
    const c = await getDiagnostics({});
    expect(c).to.not.equal(a);
    expect(count("host")).to.equal(2);

    // the light variant is its own entry, kept 10 s
    const light = { host: false, network: false, logs: false, clients: false };
    const containersBefore = count("containers");
    const l1 = await getDiagnostics(light);
    t += 9 * 1000;
    expect(await getDiagnostics(light)).to.equal(l1);
    t += 2 * 1000;
    expect(await getDiagnostics(light)).to.not.equal(l1);
    expect(count("containers") - containersBefore).to.equal(2);
    expect(count("host")).to.equal(2);
  });

  it("fresh: true skips the cached result but joins a collection in flight", async () => {
    const { getDiagnostics, calls } = setup();
    let t = 1000000;
    getDiagnostics._setClock(() => t);
    const count = () => calls.filter(c => c === "host").length;
    const a = await getDiagnostics({});
    t += 1000;
    expect(await getDiagnostics({})).to.equal(a);
    expect(count()).to.equal(1);
    const b = await getDiagnostics({ fresh: true });
    expect(b).to.not.equal(a);
    expect(count()).to.equal(2);
    // the fresh result is the cached one now
    expect(await getDiagnostics({})).to.equal(b);
    // concurrent: a fresh caller joins the run in flight
    t += 60 * 1000;
    const [c, d] = await Promise.all([getDiagnostics({}), getDiagnostics({ fresh: true })]);
    expect(c).to.equal(d);
    expect(count()).to.equal(3);
  });

  it("the cap is under 25 s", () => {
    const src = require("fs").readFileSync(require.resolve("calls/getDiagnostics"), "utf8");
    const m = src.match(/let CAP_MS = (\d+) \* 1000/);
    expect(Number(m[1]) * 1000).to.be.below(25000);
  });

  it("is registered as a call", () => {
    const calls = require("fs").readFileSync(require.resolve("calls/index"), "utf8");
    expect(calls).to.include('getDiagnostics: require("./getDiagnostics")');
  });
});
