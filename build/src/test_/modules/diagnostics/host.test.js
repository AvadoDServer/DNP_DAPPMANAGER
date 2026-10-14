const expect = require("chai").expect;
const proxyquire = require("proxyquire");
const sinon = require("sinon");
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
  "### dmesg",
  "[Mon Oct 13 22:01:02 2026] r8169 0000:02:00.0 enp2s0: Link is Down",
  "[Mon Oct 13 22:01:09 2026] r8169 0000:02:00.0 enp2s0: Link is Up - 1Gbps/Full - flow control rx/tx",
  "[Mon Oct 13 22:05:00 2026] br-4f2a1c: port 3(veth1a2b3c) entered disabled state",
  "[Mon Oct 13 22:05:00 2026] veth1a2b3c: link is down",
  "[Mon Oct 13 23:10:44 2026] nvme nvme0: I/O 12 QID 3 timeout, reset controller",
  "[Mon Oct 13 23:40:00 2026] java invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0",
  "[Mon Oct 13 23:40:00 2026] Out of memory: Killed process 4242 (java) total-vm:30000000kB, anon-rss:20000000kB",
  "[Mon Oct 13 23:41:00 2026] wlp3s0: deauthenticating from 11:22:33:44:55:66 by local choice (Reason: 3=DEAUTH_LEAVING)",
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
    expect(host.dmesg.hardware).to.deep.equal([
      "[Mon Oct 13 23:10:44 2026] nvme nvme0: I/O 12 QID 3 timeout, reset controller"
    ]);
    // Docker's veth noise is left out
    expect(host.dmesg.network).to.deep.equal([
      "[Mon Oct 13 22:01:02 2026] r8169 0000:02:00.0 enp2s0: Link is Down",
      "[Mon Oct 13 22:01:09 2026] r8169 0000:02:00.0 enp2s0: Link is Up - 1Gbps/Full - flow control rx/tx",
      "[Mon Oct 13 23:41:00 2026] wlp3s0: deauthenticating from 11:22:33:44:55:66 by local choice (Reason: 3=DEAUTH_LEAVING)"
    ]);
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

  it("is ONE privileged busybox run that chroots into the host and only reads", async () => {
    const args = hostCommandArgs();
    expect(args.slice(0, 11)).to.deep.equal([
      "run", "--rm", "--privileged", "--net=host", "--pid=host", "-v", "/:/host", "busybox", "chroot", "/host", "sh"
    ]);
    expect(args[12]).to.equal(HOST_SCRIPT);
    for (const s of ["uptime", "loadavg", "meminfo", "os", "kernel", "df", "links", "addrs", "routes", "netstate", "hwmon", "dmesg"]) {
      // on its own line even after a file without a final newline
      expect(HOST_SCRIPT).to.include(`echo; echo '### ${s}'`);
    }
    expect(HOST_SCRIPT.replace(/2>\/dev\/null/g, "")).to.not.match(/\b(rm|mv|kill|reboot|tee|dd)\b|>/);

    const runOk = sinon.stub().resolves(SAMPLE);
    const host = proxyquire("modules/diagnostics/host", { "./exec": { runOk } });
    expect(await host.runHostScript()).to.equal(SAMPLE);
    expect(runOk.callCount).to.equal(1);
    expect(runOk.firstCall.args[0]).to.equal("docker");
    expect(runOk.firstCall.args[2]).to.deep.equal({ timeout: 10000 });
  });
});
