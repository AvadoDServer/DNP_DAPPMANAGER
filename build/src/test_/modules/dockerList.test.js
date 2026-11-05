const proxyquire = require("proxyquire");
const expect = require("chai").expect;

describe("Module: dockerList", () => {
  const container = (name, State, Status, extra = {}) => ({
    Id: `id-${name}`,
    Names: [`/DAppNodePackage-${name}`],
    Image: `${name}:0.1.0`,
    Created: 1,
    Ports: [],
    Mounts: [],
    Labels: {},
    State,
    Status,
    ...extra
  });

  let containers;
  let inspect; // { id: State } or throws
  const inspected = [];
  const request = {
    get: (url, options, cb) => {
      if (url.startsWith("/containers/json")) return cb(null, containers);
      const id = url.split("/")[2];
      inspected.push(id);
      if (!inspect[id]) return cb(Error(`no such container ${id}`));
      return cb(null, { State: inspect[id] });
    }
  };
  const dockerList = proxyquire("modules/dockerList", {
    "docker-remote-api": () => request
  });

  beforeEach(() => {
    inspected.length = 0;
  });

  it("tells a created container whose start failed from one never started", async () => {
    containers = [
      container("a", "created", "Created"),
      container("b", "created", "Created"),
      container("c", "created", "Created"),
      container("d", "exited", "Exited (0) 2 hours ago"),
      container("e", "running", "Up 2 hours")
    ];
    inspect = {
      // docker-compose up --no-start
      "id-a": { Status: "created", Error: "", ExitCode: 0 },
      // port clash on start
      "id-b": {
        Status: "created",
        Error: "Bind for 0.0.0.0:50001 failed: port is already allocated",
        ExitCode: 128
      }
      // id-c: inspect fails
    };
    const list = await dockerList.listContainers();
    const by = Object.fromEntries(list.map(d => [d.name, d]));
    expect(by.a.startFailed).to.equal(false);
    expect(by.b.startFailed).to.equal(true);
    expect(by.c.startFailed).to.equal(false);
    expect(by.d).to.not.have.property("startFailed");
    expect(by.e).to.not.have.property("startFailed");
    // Only created containers are inspected
    expect(inspected.sort()).to.deep.equal(["id-a", "id-b", "id-c"]);
  });

  it("a created container is not running", async () => {
    containers = [
      container("a", "created", "Created"),
      container("d", "exited", "Exited (0) 2 hours ago"),
      container("e", "running", "Up 2 hours"),
      container("f", "restarting", "Restarting (1) 5 seconds ago")
    ];
    inspect = { "id-a": { Error: "", ExitCode: 0 } };
    const list = await dockerList.listContainers();
    const running = Object.fromEntries(list.map(d => [d.name, d.running]));
    expect(running).to.deep.equal({ a: false, d: false, e: true, f: true });
  });
});
