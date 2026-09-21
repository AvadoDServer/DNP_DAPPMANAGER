const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const recoverSignature = require("utils/recoverSignature");

// Same vector as avado-priority-support-backend/test/boxSignature.test.js.
// Signing is deterministic (RFC 6979): if this changes, the backend stops
// accepting requests from boxes.
const privateKey =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const address = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const nodeid = address.toLowerCase();
const timestamp = 1790000000;

describe("Call function: signPrioritySupportRequest", function() {
  const db = { get: async key => ({ address, privateKey }[key]) };
  const signPrioritySupportRequest = proxyquire(
    "calls/signPrioritySupportRequest",
    { "../db": db }
  );

  it("should sign a checkout request", async () => {
    const res = await signPrioritySupportRequest({
      action: "checkout",
      plan: "monthly",
      timestamp
    });
    expect(res.result).to.deep.equal({
      nodeid,
      timestamp,
      message: `avado-priority-support:v1\naction:checkout\nnodeid:${nodeid}\nplan:monthly\nts:1790000000`,
      signature:
        "0xd61c4537480aea39d2bad9aae8548657501bcdfdbe4c23507df8396ffb3280494fc7df7c1326515a1bb8628296482db13c11066b01815755766cbfbcccfe1a441c"
    });
  });

  it("should sign a portal request with an empty plan", async () => {
    const res = await signPrioritySupportRequest({
      action: "portal",
      plan: "yearly",
      timestamp
    });
    expect(res.result.message).to.equal(
      `avado-priority-support:v1\naction:portal\nnodeid:${nodeid}\nplan:\nts:1790000000`
    );
    expect(res.result.signature).to.equal(
      "0x1aa2d0b3470baf82a793ad0c5083176d56496fe3ed027ee6642cbaf07adbf2bc2d40d146862c689857c629adaac6eba7b3e172c572456bfc14fa2ba1bda29e181b"
    );
  });

  it("should be recoverable to the box address", async () => {
    const { result } = await signPrioritySupportRequest({
      action: "checkout",
      plan: "yearly",
      timestamp
    });
    expect("0x" + recoverSignature(result.message, result.signature)).to.equal(
      nodeid
    );
  });

  it("should default the timestamp to now", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { result } = await signPrioritySupportRequest({ action: "portal" });
    expect(result.timestamp).to.be.within(before, before + 5);
  });

  it("should never return or log the private key", async () => {
    const res = await signPrioritySupportRequest({
      action: "checkout",
      plan: "monthly",
      timestamp
    });
    expect(JSON.stringify(res)).to.not.include(privateKey.slice(2));
    expect(res).to.not.have.property("logMessage");
    expect(res).to.not.have.property("userAction");
  });

  const invalid = {
    "unknown action": { action: "refund", plan: "monthly", timestamp },
    "missing action": { plan: "monthly", timestamp },
    "checkout without plan": { action: "checkout", timestamp },
    "unknown plan": { action: "checkout", plan: "lifetime", timestamp },
    "non integer timestamp": { action: "portal", timestamp: "1790000000" },
    "newline injected in plan": {
      action: "checkout",
      plan: "monthly\nnodeid:0x0",
      timestamp
    }
  };
  for (const [name, kwargs] of Object.entries(invalid)) {
    it(`should reject ${name}`, async () => {
      let error = "--- did not throw ---";
      await signPrioritySupportRequest(kwargs).catch(e => (error = e.message));
      expect(error).to.include("kwarg");
    });
  }

  it("should throw if the box has no identity", async () => {
    const call = proxyquire("calls/signPrioritySupportRequest", {
      "../db": { get: async () => undefined }
    });
    let error = "--- did not throw ---";
    await call({ action: "portal", timestamp }).catch(e => (error = e.message));
    expect(error).to.include("no identity");
  });
});
