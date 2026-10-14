const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();
const sinon = require("sinon");

describe("Call: rebootHost", () => {
  let clock;
  beforeEach(() => (clock = sinon.useFakeTimers()));
  afterEach(() => clock.restore());

  it("is logged as a user action and reboots after the reply", async () => {
    const reboot = sinon.stub().resolves();
    const rebootHost = proxyquire("calls/rebootHost", { "modules/docker": { rebootHost: reboot } });
    const res = await rebootHost();
    expect(res).to.include({ userAction: true, logMessage: true });
    expect(res.message).to.match(/rebooting host/);
    expect(reboot.callCount).to.equal(0);
    clock.tick(rebootHost.REBOOT_DELAY_MS);
    expect(reboot.callCount).to.equal(1);
  });

  it("reaches the activity log through registerHandler", async () => {
    const logged = [];
    const reboot = sinon.stub().rejects(Error("killed by the reboot"));
    const rebootHost = proxyquire("calls/rebootHost", { "modules/docker": { rebootHost: reboot } });
    const { wrapErrors } = proxyquire("registerHandler", {
      "./logUserAction": { log: info => logged.push(info) },
      "./logs": () => ({ debug() {}, info() {}, warn() {}, error() {} })
    });
    const reply = JSON.parse(await wrapErrors(rebootHost, "rebootHost.dappmanager.dnp.dappnode.eth")([], {}));
    expect(reply.success).to.equal(true);
    expect(logged).to.have.length(1);
    expect(logged[0]).to.include({ level: "info", event: "rebootHost.dappmanager.dnp.dappnode.eth", userAction: true });
    clock.tick(rebootHost.REBOOT_DELAY_MS);
  });
});
