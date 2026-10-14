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
      runHostScript: record("host", over.runHostScript || (async () => "HOST OUTPUT")),
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
      readProcesses: record("processes", async () => realContainers.parseSupervisorStatus(f.tekuSupervisor)),
      readLog: record("logs", async () => realContainers.summarizeLogs(f.tekuLogs)),
      readSettings: record("settings", async () => ({ ee_endpoint: "http://avado-dnp-nethermind.my.ava.do:8551" }))
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
