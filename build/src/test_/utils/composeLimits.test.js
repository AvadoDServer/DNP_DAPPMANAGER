const expect = require("chai").expect;
const params = require("params");
const yaml = require("js-yaml");
const generate = require("utils/generate");
const limits = require("utils/composeLimits");

describe("utils > composeLimits", () => {
  it("reads durations", () => {
    expect(limits.parseDurationSeconds("10m")).to.equal(600);
    expect(limits.parseDurationSeconds("1m30s")).to.equal(90);
    expect(limits.parseDurationSeconds("90")).to.equal(90);
    expect(limits.parseDurationSeconds(45)).to.equal(45);
    expect(limits.parseDurationSeconds("1h")).to.equal(3600);
    expect(limits.parseDurationSeconds("ten minutes")).to.equal(null);
    expect(limits.parseDurationSeconds("-5s")).to.equal(null);
  });

  it("reads memory sizes", () => {
    expect(limits.parseMemoryBytes("4g")).to.equal(4 * 1024 ** 3);
    expect(limits.parseMemoryBytes("512m")).to.equal(512 * 1024 ** 2);
    expect(limits.parseMemoryBytes("2GB")).to.equal(2 * 1024 ** 3);
    expect(limits.parseMemoryBytes("1.5GiB")).to.equal(1.5 * 1024 ** 3);
    expect(limits.parseMemoryBytes(1073741824)).to.equal(1073741824);
    expect(limits.parseMemoryBytes("lots")).to.equal(null);
  });

  it("clamps stop_grace_period to 10 s .. 15 min", () => {
    expect(limits.stopGracePeriod({ stop_grace_period: "2h" })).to.include({ value: "900s", seconds: 900 });
    expect(limits.stopGracePeriod({ stop_grace_period: "1s" })).to.include({ value: "10s" });
    expect(limits.stopGracePeriod({ stop_grace_period: "5m" })).to.deep.equal({ value: "300s", seconds: 300, note: undefined });
    expect(limits.stopGracePeriod({ stop_grace_period: "soon" }).value).to.equal(undefined);
    expect(limits.stopGracePeriod({})).to.deep.equal({});
  });

  it("clamps memory limits to 64 MiB .. 256 GiB; mem_limit wins over deploy", () => {
    expect(limits.memoryLimit({ mem_limit: "4m" }).bytes).to.equal(64 * 1024 ** 2);
    expect(limits.memoryLimit({ mem_limit: "1t" }).bytes).to.equal(256 * 1024 ** 3);
    expect(limits.memoryLimit({ mem_limit: "2g", deploy: { resources: { limits: { memory: "8g" } } } }).bytes).to.equal(
      2 * 1024 ** 3
    );
    expect(limits.memoryLimit({ deploy: { resources: { limits: { memory: "8g" } } } }).bytes).to.equal(8 * 1024 ** 3);
    expect(limits.memoryLimit({ mem_limit: "x" }).bytes).to.equal(undefined);
  });

  it("only hands out allowed devices", () => {
    const { devices, notes } = limits.devices({
      devices: [
        "/dev/ttyUSB0",
        "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0-if00-port0:/dev/zigbee",
        "/dev/dri/renderD128",
        "/dev/net/tun",
        "/dev/sda",
        "/dev/nvme0n1",
        "/dev/mem",
        "/dev/kmsg",
        "/dev/loop0",
        "/dev/mapper/rootvg-root",
        "/dev/dri/../sda",
        "/dev/ttyUSB0:/etc/passwd",
        "/dev/ttyUSB1:/dev/x:rwx",
        "/dev/ttyUSB0"
      ]
    });
    expect(devices).to.deep.equal([
      "/dev/ttyUSB0:/dev/ttyUSB0:rwm",
      "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0-if00-port0:/dev/zigbee:rwm",
      "/dev/dri/renderD128:/dev/dri/renderD128:rwm",
      "/dev/net/tun:/dev/net/tun:rwm"
    ]);
    expect(notes).to.have.length(9);
  });

  it("leaves out devices that are not on the host", () => {
    const { devices, notes } = limits.devices({ devices: ["/dev/ttyUSB0", "/dev/dri"] }, ["/dev/dri"]);
    expect(devices).to.deep.equal(["/dev/dri:/dev/dri:rwm"]);
    expect(notes).to.deep.equal(["device /dev/ttyUSB0 is not on this AVADO, left out"]);
  });

  it("gives a package the larger of the call's timeout and its stop_grace_period", () => {
    const dc = yaml.safeLoad(
      generate.dockerCompose({ name: "a", version: "1.0.0", image: { stop_grace_period: "10m" } }, params)
    );
    expect(limits.stopTimeoutOf(dc, 180)).to.equal(600);
    expect(limits.stopTimeoutOf({ services: { a: {} } }, 180)).to.equal(180);
    expect(limits.stopTimeoutOf({ services: { a: { stop_grace_period: "20s" } } }, 180)).to.equal(180);
    expect(limits.stopTimeoutOf({ services: { a: { stop_grace_period: "3h" } } }, 0)).to.equal(900);
  });

  it("reports what it changed and never throws", () => {
    const notes = [];
    const dc = generate.dockerCompose(
      { name: "a", version: "1.0.0", image: { stop_grace_period: "2h", mem_limit: "1k", devices: "/dev/dri" } },
      params,
      { onNote: n => notes.push(n) }
    );
    expect(dc).to.include("stop_grace_period: 900s");
    expect(dc).to.include(`mem_limit: ${64 * 1024 * 1024}`);
    expect(dc).to.not.include("devices");
    expect(notes).to.have.length(3);
  });
});
