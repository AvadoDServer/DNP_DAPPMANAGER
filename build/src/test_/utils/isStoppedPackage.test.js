const expect = require("chai").expect;
const isStoppedPackage = require("utils/isStoppedPackage");

describe("Util: isStoppedPackage", () => {
  const name = "teku.avado.dnp.dappnode.eth";
  // The package's own container, as dockerList.listContainers lists it
  const own = (state, extra = {}) => ({
    name,
    packageName: `DAppNodePackage-${name}`,
    state,
    isCore: false,
    ...extra
  });
  // The old container docker-compose 1.x renames while it recreates one, and
  // leaves behind when the new container fails. Listed under the same name.
  const tmp = state => ({
    ...own(state),
    packageName: `2cdce2f4ef32_DAppNodePackage-${name}`
  });
  const other = state => ({
    name: "nimbus.avado.dnp.dappnode.eth",
    packageName: "DAppNodePackage-nimbus.avado.dnp.dappnode.eth",
    state,
    isCore: false
  });

  const stopped = (...containers) => isStoppedPackage(name, containers);

  it("a running package is not stopped", () => {
    expect(stopped(own("running"))).to.equal(false);
  });

  it("a crash-looping (restarting) package is not stopped", () => {
    expect(stopped(own("restarting"))).to.equal(false);
  });

  it("a package the user paused (docker-compose stop) is stopped", () => {
    expect(stopped(own("exited"))).to.equal(true);
  });

  it("a created package (an update whose container failed to start) is not stopped", () => {
    expect(stopped(own("created"))).to.equal(false);
  });

  it("a failed recreate (exited leftover + created) is not stopped", () => {
    expect(stopped(tmp("exited"), own("created"))).to.equal(false);
  });

  it("an exited leftover next to a running container is not stopped", () => {
    expect(stopped(tmp("exited"), own("running"))).to.equal(false);
    expect(stopped(own("running"), tmp("exited"))).to.equal(false);
  });

  it("only an exited leftover (the new container was never created) is not stopped", () => {
    expect(stopped(tmp("exited"))).to.equal(false);
  });

  it("a paused package next to an exited leftover is stopped", () => {
    expect(stopped(tmp("exited"), own("exited"))).to.equal(true);
  });

  it("paused, dead, removing and unknown states count as stopped", () => {
    for (const state of ["paused", "dead", "removing", undefined, ""])
      expect(stopped(own(state)), `state ${state}`).to.equal(true);
  });

  it("other packages do not count", () => {
    expect(stopped(own("exited"), other("running"))).to.equal(true);
    expect(stopped(own("running"), other("exited"))).to.equal(false);
  });

  it("a core package is never stopped", () => {
    for (const state of ["exited", "created", "running"])
      expect(
        stopped({
          ...own(state),
          packageName: `DAppNodeCore-${name}`,
          isCore: true
        }),
        `state ${state}`
      ).to.equal(false);
  });

  it("a package that is not installed is not stopped", () => {
    expect(stopped()).to.equal(false);
    expect(stopped(other("exited"))).to.equal(false);
    expect(isStoppedPackage(name, undefined)).to.equal(false);
  });
});
