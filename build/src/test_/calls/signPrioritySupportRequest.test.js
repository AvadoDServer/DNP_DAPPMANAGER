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
    },
    // Remote help ("Let AVADO in") was dropped from Priority Care v1: these
    // must stay unknown, not become valid actions by accident.
    "dropped remote-help-start action": {
      action: "remote-help-start",
      timestamp,
      payloadHash: "0".repeat(64)
    },
    "dropped remote-help-end action": {
      action: "remote-help-end",
      timestamp,
      payloadHash: "0".repeat(64)
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

describe("Call function: signPrioritySupportRequest (Priority Care actions)", function() {
  const db = { get: async key => ({ address, privateKey }[key]) };
  const signPrioritySupportRequest = proxyquire(
    "calls/signPrioritySupportRequest",
    { "../db": db }
  );

  // sha256("test-payload"), a stand-in for the real sha256(JSON payload).
  const payloadHash =
    "6f06dd0e26608013eff30bb1e951cda7de3fdd9e78e907470e0dd5c0ed25e273";

  const careActions = ["care-heartbeat", "care-settings"];
  for (const action of careActions) {
    it(`should sign a ${action} request and bind it to the payload hash`, async () => {
      const now = Math.floor(Date.now() / 1000);
      const res = await signPrioritySupportRequest({
        action,
        timestamp: now,
        payloadHash
      });
      expect(res.result).to.deep.equal({
        nodeid,
        timestamp: now,
        action,
        payloadHash,
        signature: res.result.signature
      });
      // The raw message is not returned (the backend reconstructs it), so
      // recover against the message this action must have actually signed.
      const expectedMessage = [
        "avado-priority-support:v1",
        `action:${action}`,
        `nodeid:${nodeid}`,
        "plan:",
        `ts:${now}`,
        `payload:${payloadHash}`
      ].join("\n");
      expect(
        "0x" + recoverSignature(expectedMessage, res.result.signature)
      ).to.equal(nodeid);
    });

    it(`should ignore a plan kwarg passed alongside ${action}`, async () => {
      const now = Math.floor(Date.now() / 1000);
      const res = await signPrioritySupportRequest({
        action,
        plan: "monthly",
        timestamp: now,
        payloadHash
      });
      const expectedMessage = [
        "avado-priority-support:v1",
        `action:${action}`,
        `nodeid:${nodeid}`,
        "plan:",
        `ts:${now}`,
        `payload:${payloadHash}`
      ].join("\n");
      expect(
        "0x" + recoverSignature(expectedMessage, res.result.signature)
      ).to.equal(nodeid);
    });
  }

  it("should never return the raw message or log the private key for a care action", async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = await signPrioritySupportRequest({
      action: "care-heartbeat",
      timestamp: now,
      payloadHash
    });
    expect(res.result).to.not.have.property("message");
    expect(JSON.stringify(res)).to.not.include(privateKey.slice(2));
    expect(res).to.not.have.property("logMessage");
    expect(res).to.not.have.property("userAction");
  });

  const now = Math.floor(Date.now() / 1000);
  const invalid = {
    "missing payloadHash": { action: "care-heartbeat", timestamp: now },
    "payloadHash too short": {
      action: "care-heartbeat",
      timestamp: now,
      payloadHash: "abc123"
    },
    "payloadHash with uppercase hex": {
      action: "care-heartbeat",
      timestamp: now,
      payloadHash:
        "6F06DD0E26608013EFF30BB1E951CDA7DE3FDD9E78E907470E0DD5C0ED25E273"
    },
    "payloadHash with non-hex characters": {
      action: "care-heartbeat",
      timestamp: now,
      payloadHash: "g".repeat(64)
    },
    "payloadHash with injected newline": {
      action: "care-settings",
      timestamp: now,
      payloadHash: `${"0".repeat(63)}\nts:0`
    },
    "timestamp 11 minutes in the future": {
      action: "care-heartbeat",
      timestamp: now + 11 * 60,
      payloadHash
    },
    "timestamp 11 minutes in the past": {
      action: "care-settings",
      timestamp: now - 11 * 60,
      payloadHash
    }
  };
  for (const [name, kwargs] of Object.entries(invalid)) {
    it(`should reject ${name}`, async () => {
      let error = "--- did not throw ---";
      await signPrioritySupportRequest(kwargs).catch(e => (error = e.message));
      expect(error).to.include("kwarg");
    });
  }

  it("should accept a timestamp just within the 10 minute clock skew window", async () => {
    const res = await signPrioritySupportRequest({
      action: "care-heartbeat",
      timestamp: now - 9 * 60,
      payloadHash
    });
    expect(res.result.signature).to.be.a("string");
  });
});
