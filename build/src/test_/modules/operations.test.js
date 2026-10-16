const expect = require("chai").expect;
const operations = require("modules/operations");

const tick = () => new Promise(resolve => setImmediate(resolve));

describe("modules/operations: serialize", function() {
  beforeEach(() => operations._reset());

  it("runs calls of one kind one after the other, in order", async () => {
    const log = [];
    let release;
    const first = operations.serialize("installPackage", async () => {
      log.push("first start");
      await new Promise(resolve => (release = resolve));
      log.push("first end");
      return "a";
    });
    const second = operations.serialize("installPackage", async () => {
      log.push("second start");
      return "b";
    });
    await tick();
    expect(log).to.deep.equal(["first start"]);
    release();
    expect(await first).to.equal("a");
    expect(await second).to.equal("b");
    expect(log).to.deep.equal(["first start", "first end", "second start"]);
  });

  it("a failing call does not block the next one", async () => {
    const failing = operations.serialize("installPackage", async () => {
      throw Error("boom");
    });
    const next = operations.serialize("installPackage", async () => "ok");
    await failing.then(
      () => expect.fail("should reject"),
      e => expect(e.message).to.equal("boom")
    );
    expect(await next).to.equal("ok");
  });

  it("different kinds do not wait for each other", async () => {
    const log = [];
    let release;
    const slow = operations.serialize("installPackage", async () => {
      await new Promise(resolve => (release = resolve));
      log.push("install");
    });
    const other = operations.serialize("resetBeaconData", async () => {
      log.push("reset");
    });
    await other;
    expect(log).to.deep.equal(["reset"]);
    release();
    await slow;
  });
});
