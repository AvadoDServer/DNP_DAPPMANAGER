const expect = require("chai").expect;
const fs = require("fs");
const os = require("os");
const path = require("path");
const proxyquire = require("proxyquire").noCallThru();

const push = require("modules/push");

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: {
    p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg"
  }
};

describe("Push alerts: modules/push", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
    push._setDir(dir);
  });
  afterEach(() => {
    push._setSendImpl(() => Promise.resolve({ statusCode: 201 }));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("makes the VAPID key pair once, keeps it root-only and reuses it", () => {
    const a = push.getVapidKeys();
    expect(a.publicKey).to.match(/^[A-Za-z0-9_-]{80,}$/);
    const mode = fs.statSync(path.join(dir, "vapid.json")).mode & 0o777;
    expect(mode).to.equal(0o600);
    push._setDir(dir); // drops the in-memory copy
    expect(push.getVapidKeys().privateKey).to.equal(a.privateKey);
  });

  it("adds, replaces and removes subscriptions; refuses non-https and bad keys", () => {
    expect(push.addSubscription(SUB, "Pixel")).to.equal(1);
    expect(push.addSubscription(SUB, "Pixel again")).to.equal(1);
    expect(push.listSubscriptions()[0].name).to.equal("Pixel again");
    expect(push.hasSubscription(SUB.endpoint)).to.equal(true);
    expect(() => push.addSubscription({ ...SUB, endpoint: "http://evil.example/x" })).to.throw(/no valid push address/);
    expect(() => push.addSubscription({ ...SUB, keys: { p256dh: "a b", auth: "x" } })).to.throw(/no valid push keys/);
    expect(() => push.addSubscription(null)).to.throw(/no valid push address/);
    expect(push.removeSubscription(SUB.endpoint)).to.equal(1);
    expect(push.listSubscriptions()).to.deep.equal([]);
  });

  it("keeps at most 20 devices", () => {
    for (let i = 0; i < push.MAX_SUBSCRIPTIONS; i++) push.addSubscription({ ...SUB, endpoint: `${SUB.endpoint}${i}` });
    expect(() => push.addSubscription({ ...SUB, endpoint: `${SUB.endpoint}new` })).to.throw(/already on for 20 devices/);
  });

  it("sends signed and encrypted with a short topic; a 410 removes the device", async () => {
    push.addSubscription(SUB, "Pixel");
    const calls = [];
    push._setSendImpl(async (sub, body, options) => {
      calls.push({ sub, body, options });
      return { statusCode: 201 };
    });
    const ok = await push.sendTo(push.listSubscriptions()[0], { title: "T", body: "B", url: "/dashboard", tag: "disk-high" });
    expect(ok).to.deep.equal({ ok: true, status: 201, gone: false });
    expect(calls[0].sub).to.deep.equal(SUB);
    expect(JSON.parse(calls[0].body)).to.include({ title: "T", url: "/dashboard" });
    expect(calls[0].options.vapidDetails.subject).to.equal("https://ava.do");
    expect(calls[0].options.topic).to.match(/^[A-Za-z0-9_-]{1,32}$/);
    expect(calls[0].options.urgency).to.equal("high");
    expect(push.listSubscriptions()[0].lastOkAt).to.be.a("string");

    push._setSendImpl(async () => {
      throw Object.assign(Error("Received unexpected response code"), { statusCode: 410 });
    });
    const gone = await push.sendTo(push.listSubscriptions()[0], { title: "T" });
    expect(gone).to.deep.equal({ ok: false, status: 410, gone: true });
    expect(push.listSubscriptions()).to.deep.equal([]);
  });

  it("an unreachable push service keeps the device and notes the error", async () => {
    push.addSubscription(SUB, "Pixel");
    push._setSendImpl(async () => {
      throw Error("getaddrinfo EAI_AGAIN fcm.googleapis.com");
    });
    const r = await push.sendToAll({ title: "T" });
    expect(r).to.deep.equal({ sent: 0, failed: 1 });
    expect(push.listSubscriptions()[0].lastError).to.equal("not reachable");
  });
});

describe("Push alerts: findings", () => {
  const f = require("modules/push/findings");
  const teku = (over = {}) =>
    Object.assign({ id: "teku.avado.dnp.dappnode.eth", state: "running", restartCount: 0, uptimeSeconds: 99999, processes: [{ name: "teku", state: "RUNNING" }] }, over);

  it("a chain client whose program failed, restarting or crash looping is down; others are not", () => {
    expect(f.clientsDown([teku()])).to.deep.equal([]);
    expect(f.clientsDown([teku({ processes: [{ name: "teku", state: "FATAL" }] })])[0]).to.include({
      id: "process-down:teku.avado.dnp.dappnode.eth",
      title: "Teku has stopped working",
      url: "/packages/teku.avado.dnp.dappnode.eth",
      confirmRuns: 2
    });
    expect(f.clientsDown([teku({ state: "restarting" })])).to.have.length(1);
    expect(f.clientsDown([teku({ restartCount: 4, uptimeSeconds: 30 })])).to.have.length(1);
    // Stopped on purpose: never an alert
    expect(f.clientsDown([teku({ processes: [{ name: "teku", state: "STOPPED" }] })])).to.deep.equal([]);
    expect(f.clientsDown([teku({ state: "exited" })])).to.deep.equal([]);
    // Stopped by the owner after it had crashed a few times: still no alert
    expect(f.clientsDown([teku({ state: "exited", exitCode: 137, restartCount: 5, uptimeSeconds: null, processes: [] })])).to.deep.equal([]);
    // Not a chain client
    expect(f.clientsDown([teku({ id: "vaultwarden.avado.dnp.dappnode.eth", state: "restarting" })])).to.deep.equal([]);
    expect(f.clientsDown([teku({ id: "ethchain-geth.public.dappnode.eth", state: "restarting" })])[0].body).to.match(/cannot do their work/);
  });

  it("labels clients in plain words", () => {
    expect(f.clientLabel("teku-holesky.avado.dnp.dappnode.eth")).to.equal("Teku (Holesky)");
    expect(f.clientLabel("eth2validator.avado.dnp.dappnode.eth")).to.equal("Prysm validator");
    expect(f.clientLabel("foo.avado.dnp.dappnode.eth")).to.equal("foo");
  });

  it("disk: from 90 %", () => {
    expect(f.diskHigh("89%")).to.deep.equal([]);
    expect(f.diskHigh("93%")[0]).to.include({ id: "disk-high", title: "Your AVADO's disk is 93% full", url: "/system/storage" });
    expect(f.diskHigh(null)).to.deep.equal([]);
  });

  it("fee recipient missing", () => {
    expect(f.feeRecipientMissing({ "nimbus.avado.dnp.dappnode.eth": { validators: 2, checked: 2, missing: 0 } })).to.deep.equal([]);
    const [a] = f.feeRecipientMissing({ "nimbus.avado.dnp.dappnode.eth": { validators: 2, checked: 2, missing: 1 } });
    expect(a).to.include({ id: "fee-recipient-missing:nimbus.avado.dnp.dappnode.eth", title: "Validators in Nimbus have no fee recipient" });
    expect(a.body).to.match(/^1 validator would lose/);
  });

  it("missed attestations: only when two different epochs in a row show misses", () => {
    const name = "teku.avado.dnp.dappnode.eth";
    expect(f.missedAttestations({ [name]: { epoch: 10, active: 4, missed: 1 } }, {})).to.deep.equal([]);
    expect(f.missedAttestations({ [name]: { epoch: 10, active: 4, missed: 1 } }, { [name]: { epoch: 10, active: 4, missed: 1 } })).to.deep.equal([]);
    expect(f.missedAttestations({ [name]: { epoch: 11, active: 4, missed: 0 } }, { [name]: { epoch: 10, active: 4, missed: 3 } })).to.deep.equal([]);
    const [a] = f.missedAttestations({ [name]: { epoch: 11, active: 4, missed: 2 } }, { [name]: { epoch: 10, active: 4, missed: 3 } });
    expect(a.id).to.equal(`missed-attestations:${name}`);
    expect(a.body).to.equal("3 of 4 validators missed their last attestations. Open AVADO to find the cause.");
  });
});

describe("Push alerts: watcher decide", () => {
  const { decide, REMIND_AFTER_MS } = require("watchers/pushAlerts");
  const down = { id: "process-down:x", confirmRuns: 2 };
  const disk = { id: "disk-high", confirmRuns: 1 };
  const t0 = Date.parse("2026-11-05T10:00:00Z");

  it("waits for confirmRuns, sends once, reminds after a day, forgets when gone", () => {
    let r = decide([down, disk], {}, t0);
    expect(r.toSend.map(x => x.id)).to.deep.equal(["disk-high"]);
    r = decide([down, disk], r.state, t0 + 5 * 60e3);
    expect(r.toSend.map(x => x.id)).to.deep.equal(["process-down:x"]);
    r = decide([down, disk], r.state, t0 + 10 * 60e3);
    expect(r.toSend).to.deep.equal([]);
    r = decide([down, disk], r.state, t0 + REMIND_AFTER_MS + 5 * 60e3);
    expect(r.toSend.map(x => x.id).sort()).to.deep.equal(["disk-high", "process-down:x"]);
    r = decide([], r.state, t0 + REMIND_AFTER_MS + 6 * 60e3);
    expect(r.state.findings).to.deep.equal({});
    r = decide([disk], r.state, t0 + REMIND_AFTER_MS + 7 * 60e3);
    expect(r.toSend.map(x => x.id)).to.deep.equal(["disk-high"]);
  });
});

describe("Push alerts: watcher run", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
    push._setDir(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function watcher(over = {}) {
    const sent = [];
    const w = proxyquire("watchers/pushAlerts", {
      "logs.js": () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      "modules/push": Object.assign({}, push, { sendToAll: async payload => (sent.push(payload), { sent: 1, failed: 0 }) }),
      "modules/push/collect": Object.assign(
        {
          readContainers: async () => [],
          readDiskPct: async () => 40,
          readFeeRecipients: async () => ({}),
          readLiveness: async () => ({})
        },
        over
      )
    });
    return { w, sent };
  }

  it("does nothing without a subscribed device", async () => {
    let read = false;
    const { w } = watcher({ readContainers: async () => ((read = true), []) });
    expect(await w.runOnce()).to.equal(null);
    expect(read).to.equal(false);
  });

  it("sends a full disk to the devices and keeps state on disk", async () => {
    push.addSubscription(SUB, "Pixel");
    const { w, sent } = watcher({ readDiskPct: async () => 95 });
    const r = await w.runOnce(Date.parse("2026-11-05T10:00:00Z"));
    expect(r.sent).to.deep.equal(["disk-high"]);
    expect(sent[0]).to.deep.equal({ title: "Your AVADO's disk is 95% full", body: sent[0].body, url: "/system/storage", tag: "disk-high" });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"))).findings["disk-high"].lastSentAt).to.be.a("string");
    const again = await w.runOnce(Date.parse("2026-11-05T10:05:00Z"));
    expect(again.sent).to.deep.equal([]);
  });

  it("an unreadable docker keeps a client finding instead of forgetting it", async () => {
    push.addSubscription(SUB, "Pixel");
    const fatal = [{ id: "teku.avado.dnp.dappnode.eth", state: "running", restartCount: 0, uptimeSeconds: 9e4, processes: [{ name: "teku", state: "FATAL" }] }];
    let containers = fatal;
    const { w, sent } = watcher({ readContainers: async () => containers });
    await w.runOnce(1e12);
    await w.runOnce(1e12 + 3e5);
    expect(sent.map(s => s.tag)).to.deep.equal(["process-down:teku.avado.dnp.dappnode.eth"]);
    containers = null;
    await w.runOnce(1e12 + 6e5);
    containers = fatal;
    await w.runOnce(1e12 + 9e5);
    expect(sent).to.have.length(1);
  });
});

describe("Push alerts: collect", () => {
  const PK = "0x" + "a".repeat(96);
  const PK2 = "0x" + "b".repeat(96);
  function collectWith(routes) {
    const seen = [];
    const c = proxyquire("modules/push/collect", {
      "modules/diagnostics/http": {
        request: async (url, init) => {
          seen.push({ url, init });
          const key = `${(init && init.method) || "GET"} ${url}`;
          const hit = Object.keys(routes).find(k => key.startsWith(k));
          if (!hit) return { status: 404, json: async () => ({}) };
          const [status, body] = routes[hit];
          return { status, json: async () => body };
        }
      },
      "utils/shell": async () => "42%"
    });
    return { c, seen };
  }
  const containers = [{ id: "teku.avado.dnp.dappnode.eth", state: "running" }];
  Object.defineProperty(containers[0], "ip", { value: "172.33.0.5" });

  it("liveness: counts active validators not seen in the last finished epoch", async () => {
    const { c, seen } = collectWith({
      "GET http://172.33.0.5:5051/eth/v1/node/syncing": [200, { data: { is_syncing: false, head_slot: "3200" } }],
      "GET http://172.33.0.5:9999/keymanager/eth/v1/keystores": [200, { data: [{ validating_pubkey: PK }, { validating_pubkey: PK2 }] }],
      "GET http://172.33.0.5:5051/eth/v1/beacon/states/head/validators": [
        200,
        { data: [{ index: "7", status: "active_ongoing", validator: { pubkey: PK } }, { index: "8", status: "active_ongoing", validator: { pubkey: PK2 } }] }
      ],
      "POST http://172.33.0.5:5051/eth/v1/validator/liveness/99": [200, { data: [{ index: "7", is_live: true }, { index: "8", is_live: false }] }]
    });
    expect(await c.readLiveness(containers)).to.deep.equal({ "teku.avado.dnp.dappnode.eth": { epoch: 99, active: 2, missed: 1 } });
    expect(seen.find(s => s.url.includes("liveness")).init.body).to.deep.equal(["7", "8"]);
  });

  it("liveness: nothing while syncing or when the endpoint is missing", async () => {
    const syncing = collectWith({ "GET http://172.33.0.5:5051/eth/v1/node/syncing": [200, { data: { is_syncing: true, head_slot: "3200" } }] });
    expect(await syncing.c.readLiveness(containers)).to.deep.equal({});
    const noEl = collectWith({ "GET http://172.33.0.5:5051/eth/v1/node/syncing": [200, { data: { is_syncing: false, el_offline: true, head_slot: "3200" } }] });
    expect(await noEl.c.readLiveness(containers)).to.deep.equal({});
    const stopped = [{ id: "teku.avado.dnp.dappnode.eth", state: "exited" }];
    Object.defineProperty(stopped[0], "ip", { value: "172.33.0.5" });
    expect(collectWith({}).c.validatorClients(stopped)).to.deep.equal([]);
    const old = collectWith({
      "GET http://172.33.0.5:5051/eth/v1/node/syncing": [200, { data: { is_syncing: false, head_slot: "3200" } }],
      "GET http://172.33.0.5:9999/keymanager/eth/v1/keystores": [200, { data: [{ validating_pubkey: PK }] }],
      "GET http://172.33.0.5:5051/eth/v1/beacon/states/head/validators": [200, { data: [{ index: "7", status: "active_ongoing", validator: { pubkey: PK } }] }]
    });
    expect(await old.c.readLiveness(containers)).to.deep.equal({});
  });

  it("fee recipients: a key the client says has none counts as missing", async () => {
    const { c } = collectWith({
      "GET http://172.33.0.5:9999/keymanager/eth/v1/keystores": [200, { data: [{ validating_pubkey: PK }, { validating_pubkey: PK2 }] }],
      [`GET http://172.33.0.5:9999/keymanager/eth/v1/validator/${PK}/feerecipient`]: [200, { data: { ethaddress: "0x" + "1".repeat(40) } }],
      [`GET http://172.33.0.5:9999/keymanager/eth/v1/validator/${PK2}/feerecipient`]: [404, { message: "Fee recipient not found" }]
    });
    expect(await c.readFeeRecipients(containers)).to.deep.equal({ "teku.avado.dnp.dappnode.eth": { validators: 2, checked: 2, missing: 1 } });
  });

  it("Prysm: keys from eth2validator, beacon node from prysm-beacon-chain", () => {
    const { c } = collectWith({});
    const list = [
      { id: "eth2validator.avado.dnp.dappnode.eth", state: "running" },
      { id: "prysm-beacon-chain-mainnet.avado.dnp.dappnode.eth", state: "running" }
    ];
    Object.defineProperty(list[0], "ip", { value: "172.33.0.6" });
    Object.defineProperty(list[1], "ip", { value: "172.33.0.7" });
    expect(c.validatorClients(list)).to.deep.equal([
      { name: "eth2validator.avado.dnp.dappnode.eth", keymanager: "http://172.33.0.6:9999/keymanager", beacon: "http://172.33.0.7:3500" }
    ]);
  });
});

describe("Push alerts: calls", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
    push._setDir(dir);
  });
  afterEach(() => {
    push._setSendImpl(() => Promise.resolve({ statusCode: 201 }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function wrap(handler, event) {
    const logged = [];
    const lines = [];
    const { wrapErrors } = proxyquire("registerHandler", {
      "./logUserAction": { log: info => logged.push(info) },
      "./logs": () => ({ debug: m => lines.push(m), info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) })
    });
    return { call: kwargs => wrapErrors(handler, event)([], kwargs).then(JSON.parse), logged, lines };
  }

  it("subscribe, status, test, unsubscribe; the phone's address and keys reach no log", async () => {
    const sent = [];
    push._setSendImpl(async (sub, body) => (sent.push(JSON.parse(body)), { statusCode: 201 }));
    const sub = wrap(require("calls/pushSubscribe"), "pushSubscribe.dappmanager.dnp.dappnode.eth");
    const r1 = await sub.call({ subscription: SUB, name: "Pixel" });
    expect(r1).to.deep.include({ success: true, result: { devices: 1 } });
    const st = wrap(require("calls/pushStatus"), "pushStatus.dappmanager.dnp.dappnode.eth");
    expect((await st.call({ endpoint: SUB.endpoint })).result).to.deep.equal({ subscribed: true, devices: 1 });
    expect((await st.call({ endpoint: "https://other" })).result.subscribed).to.equal(false);
    const test = wrap(require("calls/pushTest"), "pushTest.dappmanager.dnp.dappnode.eth");
    expect(await test.call({ endpoint: SUB.endpoint })).to.deep.include({ success: true, message: "Test alert sent" });
    expect(sent[0].title).to.equal("Test alert from your AVADO");
    const un = wrap(require("calls/pushUnsubscribe"), "pushUnsubscribe.dappmanager.dnp.dappnode.eth");
    expect((await un.call({ endpoint: SUB.endpoint })).result).to.deep.equal({ removed: 1 });
    const everything = [sub, st, test, un].map(w => JSON.stringify(w.logged) + w.lines.join(" ")).join(" ");
    expect(everything).to.not.include("abc123");
    expect(everything).to.not.include(SUB.keys.auth);
    expect(everything).to.not.include(SUB.keys.p256dh);
  });

  it("test alert errors are plain sentences", async () => {
    const test = wrap(require("calls/pushTest"), "pushTest.dappmanager.dnp.dappnode.eth");
    expect((await test.call({ endpoint: SUB.endpoint })).message).to.equal("Alerts are not on for this device. Turn them on first.");
    push.addSubscription(SUB, "Pixel");
    push._setSendImpl(async () => {
      throw Error("timeout");
    });
    expect((await test.call({ endpoint: SUB.endpoint })).message).to.match(/could not reach the phone's alert service/);
    push._setSendImpl(async () => {
      throw Object.assign(Error("x"), { statusCode: 410 });
    });
    expect((await test.call({ endpoint: SUB.endpoint })).message).to.equal("This device's alerts have expired. Turn alerts off and on again.");
    expect(push.listSubscriptions()).to.deep.equal([]);
  });

  it("the public key is stable", async () => {
    const k = wrap(require("calls/pushGetKey"), "pushGetKey.dappmanager.dnp.dappnode.eth");
    const a = await k.call({});
    const b = await k.call({});
    expect(a.result.publicKey).to.equal(b.result.publicKey);
  });
});
