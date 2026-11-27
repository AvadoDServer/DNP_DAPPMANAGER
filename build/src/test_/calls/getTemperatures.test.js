const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

const temperatures = require("modules/temperatures");

// A box like ticket-0932's: AMD Ryzen (k10temp), two NVMe drives (one with a
// nonsense "high"), an unwired acpitz and the wifi card.
function fakeHwmon() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hwmon-"));
  const devices = path.join(root, "devices");
  const chip = (n, name, device, temps) => {
    const h = path.join(root, `hwmon${n}`);
    fs.mkdirSync(h);
    fs.writeFileSync(path.join(h, "name"), `${name}\n`);
    if (device) {
      fs.mkdirSync(path.join(devices, device), { recursive: true });
      fs.symlinkSync(path.join(devices, device), path.join(h, "device"));
    }
    temps.forEach(([i, t]) => {
      Object.keys(t).forEach(k => fs.writeFileSync(path.join(h, `temp${i}_${k}`), `${t[k]}\n`));
    });
  };
  chip(0, "nvme", "0000:06:00.0", [[1, { label: "Composite", input: 45900, max: 89850, crit: 93850 }], [2, { label: "Sensor 1", input: 57850, max: 65261850 }]]);
  chip(1, "acpitz", null, [[1, { input: 0, crit: 110000 }]]);
  chip(2, "k10temp", "0000:00:18.3", [[1, { label: "Tctl", input: 69500 }]]);
  chip(3, "nvme", "0000:01:00.0", [[1, { label: "Composite", input: 51850, max: 117850, min: -100 }]]);
  chip(4, "iwlwifi_1", null, [[1, { input: 52000 }]]);
  return root;
}

describe("Modules > temperatures", () => {
  it("the script reads every hwmon sensor (real shell, fake /sys/class/hwmon)", async () => {
    const root = fakeHwmon();
    try {
      const { stdout } = await exec(temperatures.script(root));
      const sensors = temperatures.parseSensors(stdout);
      expect(sensors).to.deep.include({ chip: "k10temp", device: "0000:00:18.3", label: "Tctl", celsius: 69.5, high: null, crit: null });
      expect(sensors).to.deep.include({ chip: "nvme", device: "0000:06:00.0", label: "Composite", celsius: 45.9, high: 89.9, crit: 93.9 });
      // 117.85 °C is within the sane range, so it stays; 65261 °C does not
      expect(sensors).to.deep.include({ chip: "nvme", device: "0000:01:00.0", label: "Composite", celsius: 51.9, high: 117.9, crit: null });
      expect(sensors).to.deep.include({ chip: "nvme", device: "0000:06:00.0", label: "Sensor 1", celsius: 57.9, high: null, crit: null });
      expect(sensors).to.deep.include({ chip: "iwlwifi_1", device: null, label: null, celsius: 52, high: null, crit: null });
      // acpitz reads 0: no reading
      expect(sensors.map(s => s.chip)).to.not.include("acpitz");
      expect(sensors).to.have.length(5);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a box without sensors gives an empty list", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hwmon-"));
    try {
      const { stdout } = await exec(temperatures.script(root));
      expect(temperatures.parseSensors(stdout)).to.deep.equal([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parseSensors drops empty, unreadable and absurd readings", () => {
    const out = ["k10temp\t\tTctl\t\t\t", "nvme\t\tComposite\t200000\t\t", "x\t\t\tabc\t\t", "coretemp\t\tPackage id 0\t61000\t100000\t100000", ""].join("\n");
    expect(temperatures.parseSensors(out)).to.deep.equal([
      { chip: "coretemp", device: null, label: "Package id 0", celsius: 61, high: 100, crit: 100 }
    ]);
  });

  it("does not start a second read while one is stuck", async () => {
    let calls = 0;
    const stuck = proxyquire("modules/temperatures", {
      "utils/shell": () => {
        calls++;
        return new Promise(() => {}); // a cat stuck on a hung drive
      }
    });
    stuck._reset();
    // The first read never answers (its own 5 s timeout is not waited for)
    stuck.readSensors().catch(() => {});
    await new Promise(r => setTimeout(r, 10));
    let err;
    await stuck.readSensors().catch(e => (err = e));
    expect(err.message).to.include("has not finished");
    expect(calls).to.equal(1);
  });
});

describe("Calls > getTemperatures", () => {
  const sensors = [{ chip: "k10temp", device: "0000:00:18.3", label: "Tctl", celsius: 69.5, high: null, crit: null }];

  function load(readSensors) {
    const call = proxyquire("calls/getTemperatures", {
      "modules/temperatures": { readSensors }
    });
    return call;
  }

  it("returns the sensors and when they were read", async () => {
    const getTemperatures = load(async () => sensors);
    getTemperatures._reset();
    const res = await getTemperatures();
    expect(res.message).to.be.a("string");
    expect(res.result.sensors).to.deep.equal(sensors);
    expect(Date.parse(res.result.readAt)).to.be.closeTo(Date.now(), 5000);
  });

  it("concurrent callers share one read, and it is reused for a while", async () => {
    let reads = 0;
    const getTemperatures = load(async () => {
      reads++;
      return sensors;
    });
    getTemperatures._reset();
    await Promise.all([getTemperatures(), getTemperatures(), getTemperatures()]);
    await getTemperatures();
    expect(reads).to.equal(1);
  });

  it("a failed read returns the last good answer while it is recent", async () => {
    let fail = false;
    const getTemperatures = load(async () => {
      if (fail) throw Error("timed out");
      return sensors;
    });
    getTemperatures._reset({ cacheMs: 0 });
    const good = await getTemperatures();
    fail = true;
    const res = await getTemperatures();
    expect(res.result.sensors).to.deep.equal(sensors);
    expect(res.result.readAt).to.equal(good.result.readAt);
  });

  it("an old answer is not shown as current: no sensors once it is stale", async () => {
    let fail = false;
    const getTemperatures = load(async () => {
      if (fail) throw Error("timed out");
      return sensors;
    });
    getTemperatures._reset({ cacheMs: 0, staleMs: 0 });
    await getTemperatures();
    fail = true;
    const res = await getTemperatures();
    expect(res.result).to.deep.equal({ sensors: [], readAt: null });
  });

  it("never throws, even when the first read fails", async () => {
    const getTemperatures = load(async () => {
      throw Error("no sysfs");
    });
    getTemperatures._reset();
    const res = await getTemperatures();
    expect(res.result).to.deep.equal({ sensors: [], readAt: null });
  });
});
