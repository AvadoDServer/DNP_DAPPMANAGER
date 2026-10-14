const expect = require("chai").expect;
const proxyquire = require("proxyquire");
const { parseHostOutput, HOST_SCRIPT, hostCommandArgs } = require("modules/diagnostics/host");

// HAND-WRITTEN sample of the host script's output, from the formats of
// /proc/uptime, /proc/loadavg, /proc/meminfo, /etc/os-release, df -kP,
// `ip -o link`, `ip -o -4 addr`, `ip route`, /sys/class/net and hwmon on a
// Debian 12 box using Wi-Fi with an unplugged Ethernet port. Not captured
// from a real box.
const SAMPLE = [
  "### uptime",
  "7260.51 54321.00",
  "### loadavg",
  "2.15 1.80 1.42 3/812 12345",
  "### cores",
  "16",
  "### meminfo",
  "MemTotal:       32768000 kB",
  "MemFree:          512000 kB",
  "MemAvailable:    1024000 kB",
  "SwapTotal:       2097148 kB",
  "SwapFree:          97148 kB",
  "### os",
  'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
  'NAME="Debian GNU/Linux"',
  "### kernel",
  "6.1.0-26-amd64",
  "### df",
  "Filesystem     1024-blocks       Used Available Capacity Mounted on",
  "/dev/nvme0n1p2 1919727620 1612571200 209478660      89% /",
  "### links",
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00",
  "2: enp2s0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc mq state DOWN mode DEFAULT group default qlen 1000\\    link/ether 00:11:22:33:44:55 brd ff:ff:ff:ff:ff:ff",
  "3: wlp3s0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DORMANT group default qlen 1000\\    link/ether 66:77:88:99:aa:bb brd ff:ff:ff:ff:ff:ff",
  "4: docker0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default \\    link/ether 02:42:ac:11:00:01 brd ff:ff:ff:ff:ff:ff",
  "5: br-4f2a1c: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default \\    link/ether 02:42:ac:21:00:01 brd ff:ff:ff:ff:ff:ff",
  "7: veth1a2b3c@if6: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master br-4f2a1c state UP mode DEFAULT group default \\    link/ether 3a:44:55:66:77:88 brd ff:ff:ff:ff:ff:ff link-netnsid 0",
  "8: tun0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UNKNOWN mode DEFAULT group default qlen 500\\    link/none ",
  "### addrs",
  "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever",
  "3: wlp3s0    inet 192.168.1.23/24 brd 192.168.1.255 scope global dynamic wlp3s0\\       valid_lft 85000sec preferred_lft 85000sec",
  "4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever",
  "8: tun0    inet 10.20.0.1/24 scope global tun0\\       valid_lft forever preferred_lft forever",
  "### routes",
  "default via 192.168.1.1 dev wlp3s0 proto dhcp metric 600 ",
  "default via 192.168.0.1 dev enp2s0 proto dhcp metric 20100 linkdown ",
  "172.33.0.0/16 dev br-4f2a1c proto kernel scope link src 172.33.1.7 ",
  "192.168.1.0/24 dev wlp3s0 proto kernel scope link src 192.168.1.23 metric 600 ",
  "### netstate",
  "br-4f2a1c up 1 -",
  "docker0 up 1 -",
  "enp2s0 down 0 -",
  "lo unknown 1 -",
  "tun0 unknown 1 -",
  "veth1a2b3c up 1 -",
  "wlp3s0 up 1 wireless",
  "### hwmon",
  "acpitz\t\t27800",
  "nvme\tComposite\t81850",
  "nvme\tSensor 1\t79850",
  "k10temp\tTctl\t65125",
  "amdgpu\tedge\t",
  "### tz",
  "+0200",
  "### dmesg",
  // boot (the box booted 07:59:00Z = 09:59:00 local): no fault, all ignored
  "[Wed Oct 14 09:59:01 2026] mce: CPU0: Thermal monitoring enabled (TM1)",
  "[Wed Oct 14 09:59:01 2026] mce: CPU supports 10 MCE banks",
  "[Wed Oct 14 09:59:01 2026] MCE: In-kernel MCE decoding enabled.",
  "[Wed Oct 14 09:59:02 2026] nvme nvme0: Shutdown timeout set to 8 seconds",
  "[Wed Oct 14 09:59:01 2026] thermal_sys: Registered thermal governor 'step_wise'",
  "[Wed Oct 14 09:59:02 2026] ACPI: thermal: Thermal Zone [TZ00] (28 C)",
  "[Wed Oct 14 09:59:03 2026] ata1: SATA link down (SStatus 0 SControl 300)",
  "[Wed Oct 14 09:59:10 2026] r8169 0000:02:00.0 enp2s0: Link is Down",
  "[Wed Oct 14 09:59:14 2026] e1000e: enp2s0 NIC Link is Up 1000 Mbps Full Duplex, Flow Control: None",
  // after boot
  "[Wed Oct 14 10:03:02 2026] r8169 0000:02:00.0 enp2s0: Link is Down",
  "[Wed Oct 14 10:03:09 2026] r8169 0000:02:00.0 enp2s0: Link is Up - 1Gbps/Full - flow control rx/tx",
  "[Wed Oct 14 10:05:00 2026] br-4f2a1c: port 3(veth1a2b3c) entered disabled state",
  "[Wed Oct 14 10:05:00 2026] veth1a2b3c: link is down",
  "[Wed Oct 14 10:10:44 2026] nvme nvme0: I/O 12 QID 3 timeout, reset controller",
  "[Wed Oct 14 10:20:00 2026] ata2.00: failed command: READ FPDMA QUEUED",
  "[Wed Oct 14 10:30:00 2026] mce: [Hardware Error]: Machine check events logged",
  "[Wed Oct 14 10:40:00 2026] java invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0",
  "[Wed Oct 14 10:40:00 2026] Out of memory: Killed process 4242 (java) total-vm:30000000kB, anon-rss:20000000kB",
  "[Wed Oct 14 10:41:00 2026] wlp3s0: deauthenticating from 11:22:33:44:55:66 by local choice (Reason: 3=DEAUTH_LEAVING)",
  "### end",
  ""
].join("\n");

describe("Module: diagnostics/host", () => {
  const now = Date.parse("2026-10-14T10:00:00Z");

  it("parses the box: uptime, load, memory, disk, OS, temperatures, kernel log", () => {
    const { host } = parseHostOutput(SAMPLE, now);
    expect(host.uptimeSeconds).to.equal(7260);
    expect(host.bootedAt).to.equal(new Date(now - 7260 * 1000).toISOString());
    expect(host.loadavg).to.deep.equal([2.15, 1.8, 1.42]);
    expect(host.cores).to.equal(16);
    expect(host.memTotalMB).to.equal(32000);
    expect(host.memAvailableMB).to.equal(1000);
    expect(host.swapTotalMB).to.equal(2048);
    expect(host.swapUsedMB).to.equal(2048 - 95);
    expect(host.kernel).to.equal("6.1.0-26-amd64");
    expect(host.os).to.equal("Debian GNU/Linux 12 (bookworm)");
    expect(host.rootDisk).to.deep.equal({ totalGB: 1830.8, usedGB: 1537.9, availableGB: 199.8 });
    expect(host.temperatures).to.deep.equal([
      { name: "acpitz", celsius: 27.8 },
      { name: "nvme Composite", celsius: 81.9 },
      { name: "nvme Sensor 1", celsius: 79.9 },
      { name: "k10temp Tctl", celsius: 65.1 }
    ]);
    expect(host.dmesg.oom).to.have.length(2);
    // boot lines that name thermal/MCE/SATA are not faults
    expect(host.dmesg.hardware).to.deep.equal([
      "[Wed Oct 14 10:10:44 2026] nvme nvme0: I/O 12 QID 3 timeout, reset controller",
      "[Wed Oct 14 10:20:00 2026] ata2.00: failed command: READ FPDMA QUEUED",
      "[Wed Oct 14 10:30:00 2026] mce: [Hardware Error]: Machine check events logged"
    ]);
    // no boot link lines, no SATA port, no Docker veth noise
    expect(host.dmesg.network).to.deep.equal([
      "[Wed Oct 14 10:03:02 2026] r8169 0000:02:00.0 enp2s0: Link is Down",
      "[Wed Oct 14 10:03:09 2026] r8169 0000:02:00.0 enp2s0: Link is Up - 1Gbps/Full - flow control rx/tx",
      "[Wed Oct 14 10:41:00 2026] wlp3s0: deauthenticating from 11:22:33:44:55:66 by local choice (Reason: 3=DEAUTH_LEAVING)"
    ]);
  });

  it("the reviewer's boot sample: nothing to report", () => {
    const boot = [
      "### uptime",
      "100.00 50.00",
      "### tz",
      "+0000",
      "### dmesg",
      "[Wed Oct 14 09:58:21 2026] mce: CPU0: Thermal monitoring enabled (TM1)",
      "[Wed Oct 14 09:58:21 2026] thermal_sys: Registered thermal governor 'step_wise'",
      "[Wed Oct 14 09:58:22 2026] ACPI: thermal: Thermal Zone [TZ00] (28 C)",
      "[Wed Oct 14 09:58:22 2026] MCE: In-kernel MCE decoding enabled.",
      "[Wed Oct 14 09:58:22 2026] nvme nvme0: Shutdown timeout set to 10 seconds",
      "[Wed Oct 14 09:58:23 2026] ata1: SATA link down (SStatus 0 SControl 300)",
      "[Wed Oct 14 09:58:30 2026] r8169 0000:02:00.0 enp2s0: Link is Down",
      "[Wed Oct 14 09:58:34 2026] r8169 0000:02:00.0 enp2s0: Link is Up - 1Gbps/Full",
      "[Wed Oct 14 09:58:35 2026] e1000e: eno1 NIC Link is Up 1000 Mbps Full Duplex"
    ].join("\n");
    const { host } = parseHostOutput(boot, now);
    expect(host.dmesg).to.deep.equal({ oom: [], hardware: [], network: [] });
  });

  it("critical temperature and thermal shutdown are hardware faults", () => {
    const out = [
      "### uptime",
      "99999.00 1.00",
      "### dmesg",
      "[Wed Oct 14 09:00:00 2026] thermal thermal_zone0: critical temperature reached (105 C), shutting down",
      "[Wed Oct 14 09:00:01 2026] CPU0: Core temperature above threshold, cpu clock throttled"
    ].join("\n");
    const { host } = parseHostOutput(out, now);
    expect(host.dmesg.hardware).to.have.length(1);
    expect(host.dmesg.hardware[0]).to.include("critical temperature");
  });

  it("parses the interfaces without docker's, and the default route with the lowest metric", () => {
    const { network } = parseHostOutput(SAMPLE, now);
    expect(network.interfaces).to.deep.equal([
      { name: "enp2s0", type: "ethernet", up: false, carrier: false, ipv4: [] },
      { name: "wlp3s0", type: "wifi", up: true, carrier: true, ipv4: ["192.168.1.23"] },
      { name: "tun0", type: "other", up: false, carrier: true, ipv4: ["10.20.0.1"] }
    ]);
    expect(network.defaultRoute).to.deep.equal({ interface: "wlp3s0", gateway: "192.168.1.1" });
  });

  it("keeps only the last 10 matching kernel lines per kind", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `[x] Out of memory: Killed process ${i} (geth)`);
    const out = SAMPLE.replace("### end", [...lines, "### end"].join("\n"));
    const { host } = parseHostOutput(out, now);
    expect(host.dmesg.oom).to.have.length(10);
    expect(host.dmesg.oom[9]).to.include("Killed process 14");
  });

  it("an empty hwmon, no swap, no default route", () => {
    const out = SAMPLE.replace(/### hwmon[\s\S]*?### dmesg/, "### hwmon\n### dmesg")
      .replace("SwapTotal:       2097148 kB", "SwapTotal:             0 kB")
      .replace("SwapFree:          97148 kB", "SwapFree:              0 kB")
      .replace(/### routes[\s\S]*?### netstate/, "### routes\n### netstate");
    const { host, network } = parseHostOutput(out, now);
    expect(host.temperatures).to.deep.equal([]);
    expect(host.swapUsedMB).to.equal(0);
    expect(network.defaultRoute).to.equal(null);
  });

  it("rejects output without sections", () => {
    expect(() => parseHostOutput("chroot: can't execute 'sh'", now)).to.throw(/unexpected output/);
  });

  it("is ONE named, privileged busybox run that chroots into the host and only reads", () => {
    const args = hostCommandArgs();
    expect(args.slice(0, 13)).to.deep.equal([
      "run", "--rm", "--name", "dappmanager-diag-host", "--privileged", "--net=host", "--pid=host", "-v", "/:/host", "busybox", "chroot", "/host", "sh"
    ]);
    expect(args[14]).to.equal(HOST_SCRIPT);
    for (const s of ["uptime", "tz", "loadavg", "meminfo", "os", "kernel", "df", "links", "addrs", "routes", "netstate", "hwmon", "dmesg"]) {
      // on its own line even after a file without a final newline
      expect(HOST_SCRIPT).to.include(`echo; echo '### ${s}'`);
    }
    const noRedirects = HOST_SCRIPT.replace(/2>\/dev\/null|>\/dev\/null|2>&1/g, "");
    expect(noRedirects).to.not.match(/\b(rm|mv|kill|reboot|tee|dd)\b|>/);
  });

  it("every read is under timeout when the host has it; sensors come last", () => {
    expect(HOST_SCRIPT).to.include('command -v timeout >/dev/null 2>&1 && T="timeout -k 1 3"');
    const body = HOST_SCRIPT.split("\n").filter(l => l.startsWith("echo; echo '### ") && !l.includes("### end"));
    for (const l of body) {
      const cmd = l.replace(/^echo; echo '### \w+'; /, "");
      // r = $T cat; loops read through r
      expect(cmd, l).to.match(/^(r |\$T |\{ \$T |for )/);
      if (cmd.startsWith("for ")) expect(cmd).to.not.match(/\$\(cat /);
    }
    expect(body[body.length - 1]).to.include("### hwmon");
    expect(HOST_SCRIPT.indexOf("### dmesg")).to.be.below(HOST_SCRIPT.indexOf("### df"));
  });

  function loadRunner(run) {
    const host = proxyquire("modules/diagnostics/host", { "./exec": { run } });
    return host;
  }

  it("runs the script and returns its output", async () => {
    const calls = [];
    const host = loadRunner(async (file, args, opts) => {
      calls.push({ file, args, opts });
      return { code: 0, stdout: SAMPLE, stderr: "" };
    });
    expect(await host.runHostScript()).to.deep.equal({ output: SAMPLE, error: null });
    expect(calls).to.have.length(1);
    expect(calls[0].opts).to.deep.equal({ timeout: 10000 });
  });

  it("at 10 s: returns the sections printed so far at once, the container is removed in the background", async () => {
    const calls = [];
    // cut while reading the sensors
    const partial = SAMPLE.slice(0, SAMPLE.indexOf("### hwmon") + "### hwmon\nacpitz\t\t27800\n".length);
    // Like exec.run: the docker CLI is killed at the timeout; the stuck
    // container makes `docker rm -f` hang too
    const host = loadRunner((file, args, opts) => {
      calls.push(args.slice(0, 3));
      if (args[0] === "run") {
        return new Promise((resolve, reject) =>
          setTimeout(() => reject(Object.assign(Error("timed out after 0 s"), { timedOut: true, stdout: partial })), opts.timeout)
        );
      }
      return new Promise(() => {});
    });
    host._setHostTimeout(30);
    const t0 = Date.now();
    const { output, error } = await host.runHostScript();
    expect(Date.now() - t0).to.be.below(200);
    expect(error).to.equal("timed out after 0 s, kept the sections read until then");
    expect(calls[1]).to.deep.equal(["rm", "-f", "dappmanager-diag-host"]);
    const parsed = parseHostOutput(output, now);
    expect(parsed.host.uptimeSeconds).to.equal(7260);
    expect(parsed.host.rootDisk.totalGB).to.equal(1830.8);
    expect(parsed.network.defaultRoute).to.deep.equal({ interface: "wlp3s0", gateway: "192.168.1.1" });
    expect(parsed.host.temperatures).to.deep.equal([{ name: "acpitz", celsius: 27.8 }]);
  });

  it("a timeout before any section is an error, the container is still removed", async () => {
    const calls = [];
    const host = loadRunner(async (file, args) => {
      calls.push(args[0]);
      if (args[0] === "run") throw Object.assign(Error("timed out after 10 s"), { timedOut: true, stdout: "" });
      return { code: 0, stdout: "", stderr: "" };
    });
    let err;
    await host.runHostScript().catch(e => (err = e));
    expect(err.message).to.equal("timed out after 10 s");
    expect(calls).to.deep.equal(["run", "rm"]);
  });

  it("a container left from an earlier run is removed and the run retried once", async () => {
    const calls = [];
    let first = true;
    const host = loadRunner(async (file, args) => {
      calls.push(args[0]);
      if (args[0] === "run" && first) {
        first = false;
        return { code: 125, stdout: "", stderr: 'docker: Error response from daemon: Conflict. The container name "/dappmanager-diag-host" is already in use by container "abc".' };
      }
      return { code: 0, stdout: args[0] === "run" ? SAMPLE : "", stderr: "" };
    });
    expect((await host.runHostScript()).output).to.equal(SAMPLE);
    expect(calls).to.deep.equal(["run", "rm", "run"]);
  });

  it("concurrent callers share one run", async () => {
    let runs = 0;
    const host = loadRunner(async () => {
      runs++;
      await new Promise(r => setTimeout(r, 10));
      return { code: 0, stdout: SAMPLE, stderr: "" };
    });
    const [a, b] = await Promise.all([host.runHostScript(), host.runHostScript()]);
    expect(a).to.equal(b);
    expect(runs).to.equal(1);
    await host.runHostScript();
    expect(runs).to.equal(2);
  });

  it("masks public IPv4 addresses on interfaces", () => {
    const out = SAMPLE.replace("inet 10.20.0.1/24", "inet 84.255.200.7/24");
    const { network } = parseHostOutput(out, now);
    expect(network.interfaces.find(i => i.name === "tun0").ipv4).to.deep.equal(["<public>"]);
    expect(network.interfaces.find(i => i.name === "wlp3s0").ipv4).to.deep.equal(["192.168.1.23"]);
    expect(JSON.stringify(network)).to.not.include("84.255.200.7");
    const { isPrivateIpv4 } = require("modules/diagnostics/host");
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.255.254", "169.254.1.1", "127.0.0.1"]) {
      expect(isPrivateIpv4(ip), ip).to.equal(true);
    }
    for (const ip of ["172.32.0.1", "172.15.0.1", "100.128.0.1", "8.8.8.8", "192.169.0.1", "1.1.1.1"]) {
      expect(isPrivateIpv4(ip), ip).to.equal(false);
    }
  });

  it("scrubs every host line", () => {
    const secret = "f".repeat(64);
    const out = SAMPLE.replace("### end", `[Wed Oct 14 11:00:00 2026] nvme nvme0: I/O error key ${secret} password=hunter2\n### end`);
    const { host } = parseHostOutput(out, now);
    const json = JSON.stringify(host);
    expect(json).to.not.include(secret);
    expect(json).to.not.include("hunter2");
  });
});
