const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();

describe("Module: diagnostics/network", () => {
  const STORE_PEER = "12D3KooWBRvd3UZ8rBBHRhAw7uYJSwmpB2b14dx95xtopz7PFhgY";

  function load({ lookup, head, readHealth, peers, getUpdates, cat } = {}) {
    const requests = [];
    const stubs = {
      dns: { promises: { lookup: lookup || (async () => ({ address: "1.2.3.4" })) } },
      jayson: {
        client: {
          https: () => ({
            request: (method, req, cb) => {
              requests.push({ method, req });
              const r = getUpdates ? getUpdates() : { result: JSON.stringify({ hash: "QmStore" }) };
              if (r instanceof Error) cb(r);
              else cb(null, r);
            }
          })
        }
      },
      params: {
        IPFS_STORE_PEERS: [`/ip4/80.208.229.228/tcp/4001/p2p/${STORE_PEER}`]
      },
      db: { get: async () => "0xnode" },
      "modules/ipfs": { cat: cat || (async () => JSON.stringify({ packages: [] })) },
      "modules/ipfsNode": {
        readHealth:
          readHealth ||
          (async () => ({ running: true, restarting: false, restartCount: 0, restartsLastHour: 0, startedAt: "s", lastLogLines: [] })),
        api: async () => {
          if (peers instanceof Error) throw peers;
          return { Peers: peers || [] };
        }
      },
      "modules/dockerList": { listContainers: async () => [{ name: "teku.avado.dnp.dappnode.eth", version: "0.0.77" }] },
      "./http": { head: head || (async () => 200) }
    };
    return { network: proxyquire("modules/diagnostics/network", stubs), requests };
  }

  it("DNS and internet", async () => {
    const { network } = load({
      lookup: async name => {
        if (name === "iso.ava.do") throw Object.assign(Error("getaddrinfo EAI_AGAIN iso.ava.do"), { code: "EAI_AGAIN" });
        return { address: "1.2.3.4" };
      }
    });
    const dns = await network.checkDns();
    expect(dns.resolves["bo.ava.do"]).to.include({ ok: true });
    expect(dns.resolves["iso.ava.do"]).to.include({ ok: false, error: "getaddrinfo EAI_AGAIN iso.ava.do" });
    const internet = await network.checkInternet();
    expect(internet["https://bo.ava.do/"]).to.include({ ok: true, status: 200 });

    const down = load({ head: async () => Promise.reject(Object.assign(Error("fetch failed"), { cause: { code: "ENETUNREACH" } })) });
    const i2 = await down.network.checkInternet();
    expect(i2["https://bo.ava.do/"]).to.include({ ok: false, status: null, error: "fetch failed: ENETUNREACH" });
  });

  it("IPFS: health, peers and the AVADO store nodes among them", async () => {
    const { network } = load({
      peers: [{ Peer: "QmA" }, { Peer: STORE_PEER }, { Peer: "QmB" }],
      readHealth: async () => ({
        running: false,
        restarting: true,
        restartCount: 12,
        restartsLastHour: 5,
        startedAt: "2026-10-14T09:59:30Z",
        lastLogLines: [`Error: api token=abcdef`]
      })
    });
    expect(await network.readIpfsStore()).to.deep.equal({
      running: false,
      restarting: true,
      restartCount: 12,
      restartsLastHour: 5,
      startedAt: "2026-10-14T09:59:30Z",
      peers: 3,
      storePeersConnected: 1,
      storePeersTotal: 1,
      lastLogLines: ["Error: api token=<redacted>"]
    });
  });

  it("IPFS: an API that does not answer leaves the peers null and reports why", async () => {
    const errors = [];
    const { network } = load({ peers: Error("connect ECONNREFUSED 172.33.1.5:5001") });
    const r = await network.readIpfsStore(e => errors.push(e));
    expect(r).to.include({ running: true, peers: null, storePeersConnected: null, storePeersTotal: 1 });
    expect(errors).to.deep.equal(["ipfs peers: connect ECONNREFUSED 172.33.1.5:5001"]);
  });

  it("catalogue: the store hash from rpc.ava.do, the catalogue through IPFS", async () => {
    const { network, requests } = load();
    const r = await network.checkCatalogue();
    expect(r.ok).to.equal(true);
    expect(r.ms).to.be.a("number");
    expect(requests).to.deep.equal([
      {
        method: "store.getUpdates",
        req: { packages: [{ name: "teku.avado.dnp.dappnode.eth", version: "0.0.77" }], nodeid: "0xnode" }
      }
    ]);
  });

  it("catalogue: names the step that failed", async () => {
    let r = await load({ getUpdates: () => Error("getaddrinfo ENOTFOUND rpc.ava.do") }).network.checkCatalogue();
    expect(r).to.include({ ok: false, error: "rpc.ava.do: getaddrinfo ENOTFOUND rpc.ava.do" });
    r = await load({ cat: async () => Promise.reject(Error("Ipfs hash not available: QmStore")) }).network.checkCatalogue();
    expect(r).to.include({ ok: false, error: "IPFS: Ipfs hash not available: QmStore" });
  });

  it("catalogue: a timeout names its step too", async () => {
    const hang = () => new Promise(() => {});
    // rpc.ava.do never answers
    const rpcHang = proxyquire("modules/diagnostics/network", {
      dns: { promises: { lookup: async () => ({}) } },
      jayson: { client: { https: () => ({ request: () => {} }) } },
      params: { IPFS_STORE_PEERS: [] },
      db: { get: async () => "0xnode" },
      "modules/ipfs": { cat: hang },
      "modules/ipfsNode": { readHealth: hang, api: hang },
      "modules/dockerList": { listContainers: async () => [] },
      "./http": { head: hang }
    });
    rpcHang._setCatalogueTimeout(30);
    expect(await rpcHang.checkCatalogue()).to.include({ ok: false, error: "rpc.ava.do: timed out after 0 s" });

    const ipfsHang = load({ cat: hang }).network;
    ipfsHang._setCatalogueTimeout(30);
    expect(await ipfsHang.checkCatalogue()).to.include({ ok: false, error: "IPFS: timed out after 0 s" });
  });

  it("catalogue: with the real 8 s budget the message reads 8 s", () => {
    const src = require("fs").readFileSync(require.resolve("modules/diagnostics/network"), "utf8");
    expect(src).to.include("let CATALOGUE_TIMEOUT = 8000;");
    expect(src).to.include("timed out after ${Math.round(CATALOGUE_TIMEOUT / 1000)} s");
  });
});
