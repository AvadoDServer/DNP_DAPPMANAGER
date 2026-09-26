const expect = require("chai").expect;
const isStoppedPackage = require("utils/isStoppedPackage");

describe("Util: isStoppedPackage", () => {
  const dnp = state => ({ name: "teku.avado.dnp.dappnode.eth", state });

  it("a running package is not stopped", () => {
    expect(isStoppedPackage(dnp("running"))).to.equal(false);
  });

  it("a crash-looping (restarting) package is not stopped", () => {
    expect(isStoppedPackage(dnp("restarting"))).to.equal(false);
  });

  it("a package the user paused (docker-compose stop) is stopped", () => {
    expect(isStoppedPackage(dnp("exited"))).to.equal(true);
  });

  it("a created but never started package is stopped", () => {
    expect(isStoppedPackage(dnp("created"))).to.equal(true);
  });

  it("paused, dead, removing and unknown states count as stopped", () => {
    for (const state of ["paused", "dead", "removing", undefined, ""])
      expect(isStoppedPackage(dnp(state)), `state ${state}`).to.equal(true);
  });

  it("a core package is never stopped", () => {
    for (const state of ["exited", "created", "running"])
      expect(
        isStoppedPackage({ ...dnp(state), isCore: true }),
        `state ${state}`
      ).to.equal(false);
  });

  it("no package is not stopped", () => {
    expect(isStoppedPackage(undefined)).to.equal(false);
  });
});
