const expect = require("chai").expect;
const proxyquire = require("proxyquire");

describe("Module: diagnostics/clients", () => {
  const container = (o = {}) => {
    const c = {};
    Object.defineProperty(c, "ip", { value: o.ip === undefined ? "172.33.0.20" : o.ip });
    Object.defineProperty(c, "running", { value: o.running === undefined ? true : o.running });
    return c;
  };

  function load(routes) {
    const calls = [];
    const answer = (key, timeout) => {
      calls.push({ key, timeout });
      const r = routes[key];
      if (r === undefined) return Promise.reject(Error(`fetch failed: ECONNREFUSED`));
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r);
    };
    const http = {
      getJson: (url, timeout) => answer(`GET ${url}`, timeout),
      jsonRpc: (url, method, params, timeout) => answer(`RPC ${url} ${method}`, timeout)
    };
    const clients = proxyquire("modules/diagnostics/clients", { "./http": http });
    return { clients, calls };
  }

  it("has one entry per package with the ports read from the package repos", () => {
    const { CLIENTS, getClient } = require("modules/diagnostics/clients");
    const names = CLIENTS.map(c => c.name);
    expect(new Set(names).size).to.equal(names.length);
    expect(getClient("teku.avado.dnp.dappnode.eth")).to.include({ role: "beacon", port: 5051, keymanager: true });
    expect(getClient("nimbus.avado.dnp.dappnode.eth")).to.include({ port: 5052 });
    expect(getClient("lighthouse-holesky.avado.dnp.dappnode.eth")).to.include({ port: 5052, network: "holesky" });
    expect(getClient("prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth")).to.include({ port: 3500, keymanager: false });
    expect(getClient("eth2validator.avado.dnp.dappnode.eth")).to.include({ role: "validator", settingsPath: "/root/settings.json" });
    expect(getClient("avado-dnp-nethermind.public.dappnode.eth")).to.include({ role: "execution", port: 8545 });
    expect(getClient("ipfs.dnp.dappnode.eth")).to.equal(null);
  });

  it("a beacon node: syncing, version, peers and validators through the monitor", async () => {
    const base = "http://172.33.0.20:5051/eth/v1/node";
    const { clients, calls } = load({
      [`GET ${base}/syncing`]: { data: { head_slot: "12000000", sync_distance: "250", is_syncing: true, is_optimistic: false, el_offline: true } },
      [`GET ${base}/version`]: { data: { version: "teku/v26.9.1/linux-x86_64/-eclipseadoptium-openjdk64bitservervm-java-21" } },
      [`GET ${base}/peer_count`]: { data: { disconnected: "12", connecting: "0", connected: "7", disconnecting: "0" } },
      "GET http://172.33.0.20:9999/keymanager/eth/v1/keystores": { data: [{ validating_pubkey: "0xa" }, { validating_pubkey: "0xb" }] }
    });
    const r = await clients.probeClient(clients.getClient("teku.avado.dnp.dappnode.eth"), container());
    expect(r).to.deep.equal({
      id: "teku.avado.dnp.dappnode.eth",
      role: "beacon",
      client: "teku",
      network: "mainnet",
      api: {
        reachable: true,
        version: "teku/v26.9.1/linux-x86_64/-eclipseadoptium-openjdk64bitservervm-java-21",
        syncing: { isSyncing: true, headSlot: 12000000, syncDistance: 250, isOptimistic: false, elOffline: true },
        peers: 7
      },
      validators: { count: 2 }
    });
    expect(calls.every(c => c.timeout === 4000)).to.equal(true);
  });

  it("a beacon process that died: api unreachable, the keymanager error reported", async () => {
    const errors = [];
    const { clients } = load({});
    const r = await clients.probeClient(clients.getClient("teku.avado.dnp.dappnode.eth"), container(), {
      onError: e => errors.push(e)
    });
    expect(r.api).to.deep.equal({ reachable: false, error: "fetch failed: ECONNREFUSED" });
    expect(r.validators).to.equal(null);
    expect(errors).to.deep.equal(["validators teku.avado.dnp.dappnode.eth: fetch failed: ECONNREFUSED"]);
  });

  it("an execution client: eth_syncing, eth_blockNumber, net_peerCount", async () => {
    const url = "http://172.33.0.30:8545";
    const routes = {
      [`RPC ${url} eth_syncing`]: { currentBlock: "0x1000", highestBlock: "0x2000", startingBlock: "0x0" },
      [`RPC ${url} eth_blockNumber`]: "0x1000",
      [`RPC ${url} net_peerCount`]: "0x19",
      [`RPC ${url} web3_clientVersion`]: "Nethermind/v1.30.0"
    };
    let { clients } = load(routes);
    const client = clients.getClient("avado-dnp-nethermind.public.dappnode.eth");
    let r = await clients.probeClient(client, container({ ip: "172.33.0.30" }));
    expect(r.api).to.deep.equal({
      reachable: true,
      version: "Nethermind/v1.30.0",
      syncing: { currentBlock: 4096, highestBlock: 8192, startingBlock: 0, synced: false },
      peers: 25
    });
    expect(r.validators).to.equal(null);

    routes[`RPC ${url} eth_syncing`] = false;
    ({ clients } = load(routes));
    r = await clients.probeClient(client, container({ ip: "172.33.0.30" }));
    expect(r.api.syncing).to.deep.equal({ currentBlock: 4096, highestBlock: 4096, startingBlock: null, synced: true });
  });

  it("a validator app: reachable when its keymanager answers", async () => {
    const { clients } = load({ "GET http://172.33.0.40:9999/keymanager/eth/v1/keystores": { data: [] } });
    const r = await clients.probeClient(clients.getClient("eth2validator.avado.dnp.dappnode.eth"), container({ ip: "172.33.0.40" }));
    expect(r).to.include({ role: "validator", client: "prysm" });
    expect(r.api).to.deep.equal({ reachable: true });
    expect(r.validators).to.deep.equal({ count: 0 });
  });

  it("a stopped container is not probed", async () => {
    const { clients, calls } = load({});
    const r = await clients.probeClient(clients.getClient("nimbus.avado.dnp.dappnode.eth"), container({ running: false }));
    expect(r.api).to.deep.equal({ reachable: false, error: "the container is not running" });
    expect(calls).to.have.length(0);
  });
});
