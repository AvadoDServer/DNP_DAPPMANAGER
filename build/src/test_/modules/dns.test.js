const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const realParams = require("params");
const dns = require("modules/dns");
const { classifyEvent } = require("watchers/dns");

const P = "DAppNodePackage-";
const C = "DAppNodeCore-";

const container = (name, ip, network = "dncore_network") => ({
  name,
  state: ip ? "running" : "exited",
  networks: { [network]: ip || "" }
});

// The box's my.ava.do zone on 2026-11-04 (named-compilezone -s full), trimmed
const liveMyAvaDo = `
zone my.ava.do/IN: loaded serial 1515764960
my.ava.do.				      38400 IN SOA	my.ava.do. administrator.my.ava.do. 1515764960 10800 3600 604800 38400
my.ava.do.				      38400 IN NS	172.33.1.2.
my.ava.do.				      38400 IN A	172.33.1.9
admin.my.ava.do.			      60 IN A		172.33.1.9
assistant.my.ava.do.			      60 IN A		172.33.0.7
bind.my.ava.do.				      60 IN A		172.33.1.2
care.my.ava.do.				      60 IN A		172.33.0.4
dappmanager.my.ava.do.			      60 IN A		172.33.1.7
ethchain-geth.my.ava.do.		      60 IN A		172.33.0.8
ipfs.my.ava.do.				      60 IN A		172.33.1.5
mcp.my.ava.do.				      60 IN A		172.33.0.7
remoteconnect.my.ava.do.		      60 IN A		172.33.1.20
settingstest.my.ava.do.			      60 IN A		172.33.0.10
wamp.my.ava.do.				      60 IN A		172.33.1.8
wifi.my.ava.do.				      60 IN A		172.33.1.10
OK
`;

const staticMyAvaDo = `
zone my.ava.do/IN: loaded serial 1515764902
my.ava.do.				      38400 IN SOA	my.ava.do. administrator.my.ava.do. 1515764902 10800 3600 604800 38400
my.ava.do.				      38400 IN NS	172.33.1.2.
my.ava.do.				      38400 IN A	172.33.1.9
dappmanager.my.ava.do.			      38400 IN A	172.33.1.7
ipfs.my.ava.do.				      38400 IN A	172.33.1.5
remoteconnect.my.ava.do.		      38400 IN A	172.33.1.20
wamp.my.ava.do.				      38400 IN A	172.33.1.8
OK
`;

const liveEth = `
eth.					      38400 IN SOA	eth. admin.eth. 1515764965 10800 3600 604800 38400
*.eth.					      38400 IN A	172.33.1.3
my.admin.dnp.dappnode.eth.		      38400 IN A	172.33.1.9
my.care.avado.dnp.dappnode.eth.		      60 IN A		172.33.0.4
my.mcp.avado.dnp.dappnode.eth.		      60 IN A		172.33.0.7
my.ethchain.dnp.dappnode.eth.		      38400 IN A	172.33.1.6
my.ethchain-geth.public.dappnode.eth.	      60 IN A		172.33.0.8
`;
const staticEth = `
eth.					      38400 IN SOA	eth. admin.eth. 1515764906 10800 3600 604800 38400
*.eth.					      38400 IN A	172.33.1.3
my.admin.dnp.dappnode.eth.		      38400 IN A	172.33.1.9
`;

// The box's containers: core, three running packages, one stopped package
const boxContainers = [
  container(`${C}admin.dnp.dappnode.eth`, "172.33.1.9"),
  container(`${C}bind.dnp.dappnode.eth`, "172.33.1.2"),
  container(`${C}dappmanager.dnp.dappnode.eth`, "172.33.1.7"),
  container(`${C}ipfs.dnp.dappnode.eth`, "172.33.1.5"),
  container(`${C}remoteconnect.avado.dnp.dappnode.eth`, "172.33.1.20"),
  container(`${C}wamp.dnp.dappnode.eth`, "172.33.1.8"),
  // wifi is being recreated: no container right now
  container(`${P}care.avado.dnp.dappnode.eth`, "172.33.0.4"),
  container(`${P}grafana.avado.dappnode.eth`, "172.33.0.6"),
  // assistant got mcp's old IP
  container(`${P}assistant.avado.dnp.dappnode.eth`, "172.33.0.7"),
  container(`${P}settingstest.avado.dnp.dappnode.eth`, ""),
  container("DAppNodeTool-restart.dnp.dappnode.eth", "")
];

function zonesFrom(pairs) {
  const out = {};
  for (const [zone, text] of Object.entries(pairs)) out[zone] = dns.parseZoneDump(text);
  return out;
}

describe("modules > dns", () => {
  describe("names, the same as build/dns_updater.sh", () => {
    const script = path.resolve(__dirname, "../../../dns_updater.sh");
    const names = [
      `${P}care.avado.dnp.dappnode.eth`,
      `${P}grafana.avado.dappnode.eth`,
      `${P}avado-dnp-nethermind.public.dappnode.eth`,
      `${P}ethchain-geth.public.dappnode.eth`,
      `${P}with_under.dnp.dappnode.eth`,
      `${P}x.avadoz.dnp.dappnode.eth`,
      `${P}bitcoin.dnp.dappnode.eth`,
      `${C}admin.dnp.dappnode.eth`,
      `${C}remoteconnect.avado.dnp.dappnode.eth`
    ];

    it("gives every container exactly the names the cron script writes", function() {
      if (!fs.existsSync(script)) this.skip();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnsupd-"));
      try {
        const ips = {};
        names.forEach((n, i) => (ips[n] = `172.33.0.${i + 2}`));
        fs.writeFileSync(
          path.join(dir, "containers"),
          names.map(n => `${n} ${ips[n]}`).join("\n") + "\n"
        );
        // Fake docker: ps -q -f name=X lists matching names as ids,
        // inspect prints "/name;ip" like the script's format string
        fs.writeFileSync(
          path.join(dir, "docker"),
          `#!/bin/sh
cmd="$1"; shift
if [ "$cmd" = ps ]; then
  for a in "$@"; do case "$a" in name=*) f="\${a#name=}";; esac; done
  awk '{print $1}' "${dir}/containers" | grep -F -- "$f"
elif [ "$cmd" = inspect ]; then
  shift; shift
  for id in "$@"; do awk -v n="$id" '$1==n {print "/" $1 ";" $2}' "${dir}/containers"; done
fi
`,
          { mode: 0o755 }
        );
        fs.writeFileSync(path.join(dir, "nsupdate"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const copy = path.join(dir, "dns_updater.sh");
        fs.writeFileSync(copy, fs.readFileSync(script, "utf8").split("/tmp/").join(`${dir}/`));
        execFileSync("sh", [copy], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });

        const fromScript = new Set();
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith("nsupdate") && f.endsWith(".txt"))) {
          let zone = null;
          for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
            const z = line.match(/^zone (\S+)\.$/);
            if (z) zone = z[1];
            const add = line.match(/^update add (\S+) 60 A (\S+)$/);
            if (add) fromScript.add(`${zone} ${add[1].toLowerCase()} ${add[2]}`);
          }
        }

        const fromModule = new Set();
        for (const n of names) {
          for (const { zone, name } of dns.namesOfContainer(n)) {
            // The script writes core names only in my.ava.do
            if (n.startsWith(C) && zone !== "my.ava.do") continue;
            fromModule.add(`${zone} ${name} ${ips[n]}`);
          }
        }
        expect(fromScript.size).to.be.greaterThan(30);
        expect([...fromModule].sort()).to.deep.equal([...fromScript].sort());
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("examples", () => {
      expect(dns.namesOfContainer(`${P}care.avado.dnp.dappnode.eth`)).to.deep.equal([
        { zone: "eth", name: "my.care.avado.dnp.dappnode.eth" },
        { zone: "dappnode", name: "care.avado.dappnode" },
        { zone: "avado", name: "care.avado.avado" },
        { zone: "avadopackage.com", name: "care.avadopackage.com" },
        { zone: "my.ava.do", name: "care.my.ava.do" }
      ]);
      expect(dns.namesOfContainer("/" + P + "ethchain-geth.public.dappnode.eth").pop()).to.deep.equal({
        zone: "my.ava.do",
        name: "ethchain-geth.my.ava.do"
      });
      expect(dns.namesOfContainer("DAppNodeTool-restart.dnp.dappnode.eth")).to.deep.equal([]);
      expect(dns.namesOfContainer("other")).to.deep.equal([]);
    });
  });

  describe("ipOf", () => {
    it("prefers the box network, else the first IP", () => {
      expect(dns.ipOf({ bridge: "172.17.0.2", dncore_network: "172.33.0.5" })).to.equal("172.33.0.5");
      expect(dns.ipOf({ other: "", bridge: "172.17.0.2" })).to.equal("172.17.0.2");
      expect(dns.ipOf({ dncore_network: "" })).to.equal("");
      expect(dns.ipOf(undefined)).to.equal("");
    });
  });

  describe("parseDump", () => {
    it("reads each zone, live and static; a zone that failed is left out", () => {
      const text = [
        "#zone live my.ava.do",
        liveMyAvaDo,
        "#zone static my.ava.do",
        staticMyAvaDo,
        "#zone live eth",
        "#failed",
        "#zone static eth",
        staticEth,
        "#zone live dappnode",
        "",
        "#zone static dappnode",
        "#zone live nope",
        liveEth
      ].join("\n");
      const res = dns.parseDump(text);
      expect(Object.keys(res.live)).to.deep.equal(["my.ava.do"]);
      expect(Object.keys(res.static).sort()).to.deep.equal(["eth", "my.ava.do"]);
      const mcp = res.live["my.ava.do"].get("mcp.my.ava.do");
      expect(mcp).to.deep.equal({ ttl: 60, ips: ["172.33.0.7"] });
      expect(res.live["my.ava.do"].get("my.ava.do")).to.deep.equal({ ttl: 38400, ips: ["172.33.1.9"] });
    });
  });

  describe("plan", () => {
    const zones = {
      live: zonesFrom({ "my.ava.do": liveMyAvaDo, eth: liveEth }),
      static: zonesFrom({ "my.ava.do": staticMyAvaDo, eth: staticEth })
    };

    function planFor(extra = {}) {
      const changes = dns.plan({
        containers: boxContainers,
        installed: [],
        live: zones.live,
        static: zones.static,
        ...extra
      });
      const byZone = {};
      for (const c of changes) byZone[c.zone] = c;
      return byZone;
    }

    it("deletes the names of packages that are gone, and only those", () => {
      const res = planFor();
      expect(res["my.ava.do"].deletes).to.deep.equal(["ethchain-geth.my.ava.do", "mcp.my.ava.do"]);
      expect(res.eth.deletes).to.deep.equal([
        "my.ethchain-geth.public.dappnode.eth",
        "my.mcp.avado.dnp.dappnode.eth"
      ]);
    });

    it("never touches core names, even a core container that is missing", () => {
      const res = planFor();
      const touched = [
        ...res["my.ava.do"].deletes,
        ...res["my.ava.do"].sets.map(s => s.name),
        ...res.eth.deletes,
        ...res.eth.sets.map(s => s.name)
      ];
      for (const core of [
        "admin.my.ava.do",
        "bind.my.ava.do",
        "dappmanager.my.ava.do",
        "ipfs.my.ava.do",
        "remoteconnect.my.ava.do",
        "wamp.my.ava.do",
        "wifi.my.ava.do",
        "my.ava.do",
        "my.admin.dnp.dappnode.eth",
        "my.ethchain.dnp.dappnode.eth",
        "*.eth"
      ])
        expect(touched).to.not.include(core);
    });

    it("keeps the name of an installed package that is stopped or being recreated", () => {
      expect(planFor()["my.ava.do"].deletes).to.not.include("settingstest.my.ava.do");
      // No container at all, but its compose file is there
      const res = planFor({
        containers: boxContainers.filter(c => !c.name.includes("settingstest")),
        installed: [`${P}settingstest.avado.dnp.dappnode.eth`]
      });
      expect(res["my.ava.do"].deletes).to.not.include("settingstest.my.ava.do");
    });

    it("sets missing names and changed IPs, leaves correct ones alone", () => {
      const res = planFor();
      // grafana has no record yet, care is right, assistant is right
      expect(res["my.ava.do"].sets).to.deep.equal([{ name: "grafana.my.ava.do", ip: "172.33.0.6" }]);
      const moved = planFor({
        containers: boxContainers.map(c =>
          c.name.includes("care.") ? container(c.name, "172.33.0.30") : c
        )
      });
      expect(moved["my.ava.do"].sets).to.deep.include({ name: "care.my.ava.do", ip: "172.33.0.30" });
      expect(moved.eth.sets).to.deep.include({ name: "my.care.avado.dnp.dappnode.eth", ip: "172.33.0.30" });
    });

    it("only deletes records with the updater's TTL", () => {
      const live = zonesFrom({
        "my.ava.do": liveMyAvaDo + "\nhandmade.my.ava.do.  3600 IN A 172.33.0.99\n"
      });
      const res = planFor({ live });
      expect(res["my.ava.do"].deletes).to.not.include("handmade.my.ava.do");
    });

    it("does not write a package name that is also a core name", () => {
      const res = planFor({
        containers: [...boxContainers, container(`${P}admin.avado.dnp.dappnode.eth`, "172.33.0.40")]
      });
      expect(res["my.ava.do"].sets.map(s => s.name)).to.not.include("admin.my.ava.do");
    });

    it("leaves a name two running containers claim alone", () => {
      const res = planFor({
        containers: [
          ...boxContainers,
          container(`${P}mcp.avado.dnp.dappnode.eth`, "172.33.0.50"),
          container(`${P}mcp.avado.public.dappnode.eth`, "172.33.0.51")
        ]
      });
      expect(res["my.ava.do"].sets.map(s => s.name)).to.not.include("mcp.my.ava.do");
      expect(res["my.ava.do"].deletes).to.not.include("mcp.my.ava.do");
    });

    it("zone that cannot be read: writes running names, deletes only the removed package", () => {
      const res = planFor({ live: {}, static: {}, removed: ["mcp.avado.dnp.dappnode.eth", "care.avado.dnp.dappnode.eth"] });
      expect(res["my.ava.do"].deletes).to.deep.equal(["mcp.my.ava.do"]);
      expect(res["my.ava.do"].sets.map(s => s.name).sort()).to.deep.equal([
        "assistant.my.ava.do",
        "care.my.ava.do",
        "grafana.my.ava.do"
      ]);
    });

    it("static list that cannot be read: no clean-up beyond the removed package", () => {
      const res = planFor({ static: {}, removed: [] });
      expect((res["my.ava.do"] || { deletes: [] }).deletes).to.deep.equal([]);
      const removed = planFor({ static: {}, removed: ["mcp.avado.dnp.dappnode.eth"] });
      expect(removed["my.ava.do"].deletes).to.deep.equal(["mcp.my.ava.do"]);
    });

    it("a removed core package keeps its names", () => {
      const res = planFor({ live: {}, static: {}, removed: ["wifi.dnp.dappnode.eth", "admin"] });
      expect(res["my.ava.do"].deletes).to.deep.equal([]);
    });
  });

  describe("nsupdateText", () => {
    it("deletes, then replaces each set", () => {
      expect(
        dns.nsupdateText({
          zone: "my.ava.do",
          deletes: ["mcp.my.ava.do"],
          sets: [{ name: "care.my.ava.do", ip: "172.33.0.4" }]
        })
      ).to.equal(
        [
          "server 172.33.1.2",
          "zone my.ava.do.",
          "update delete mcp.my.ava.do A",
          "update delete care.my.ava.do A",
          "update add care.my.ava.do 60 A 172.33.0.4",
          "send",
          ""
        ].join("\n")
      );
    });
  });

  describe("installedContainerNames", () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnsrepo-")) + "/";
      fs.mkdirSync(path.join(dir, "care.avado.dnp.dappnode.eth"));
      fs.writeFileSync(
        path.join(dir, "care.avado.dnp.dappnode.eth", "docker-compose.yml"),
        "version: '3.4'\nservices:\n  care.avado.dnp.dappnode.eth:\n    container_name: DAppNodePackage-care.avado.dnp.dappnode.eth\n"
      );
      fs.mkdirSync(path.join(dir, "broken.dnp.dappnode.eth"));
      fs.writeFileSync(path.join(dir, "broken.dnp.dappnode.eth", "docker-compose.yml"), "services: [: :");
      fs.mkdirSync(path.join(dir, "empty-dir"));
      fs.mkdirSync(path.join(dir, "DNCORE"));
      fs.writeFileSync(
        path.join(dir, "DNCORE", "docker-compose-wifi.yml"),
        "version: '3.4'\nservices:\n  wifi.dnp.dappnode.eth:\n    container_name: DAppNodeCore-wifi.dnp.dappnode.eth\n"
      );
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("lists packages and core packages from their compose files", () => {
      const mod = proxyquire("modules/dns", {
        params: { ...realParams, REPO_DIR: dir, DNCORE_DIR: "DNCORE" }
      });
      expect(mod.installedContainerNames().sort()).to.deep.equal([
        "DAppNodeCore-wifi.dnp.dappnode.eth",
        "DAppNodePackage-broken.dnp.dappnode.eth",
        "DAppNodePackage-care.avado.dnp.dappnode.eth"
      ]);
    });
  });

  describe("sync", () => {
    function load({ containers = boxContainers, dump, dockerExecCode = 0, nsupdateCode = 0 } = {}) {
      const nsupdates = [];
      const execs = [];
      let listCalls = 0;
      const spawn = (file, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        child.stdin = {
          on() {},
          end(input) {
            nsupdates.push({ file, args, input });
            setImmediate(() => child.emit("close", nsupdateCode));
          }
        };
        return child;
      };
      const mod = proxyquire("modules/dns", {
        child_process: { spawn },
        "modules/dockerList": {
          listContainerAddresses: async () => {
            listCalls++;
            return containers;
          }
        },
        "modules/diagnostics/exec": {
          run: async (file, args) => {
            execs.push({ file, args });
            return { code: dockerExecCode, stdout: dump, stderr: "Error: No such container" };
          }
        },
        params: { ...realParams, REPO_DIR: "/nonexistent-dns-test/" },
        "logs.js": () => ({ info() {}, warn() {}, error() {} })
      });
      return { mod, nsupdates, execs, listCalls: () => listCalls };
    }
    const dump = [
      "#zone live my.ava.do",
      liveMyAvaDo,
      "#zone static my.ava.do",
      staticMyAvaDo,
      "#zone live eth",
      liveEth,
      "#zone static eth",
      staticEth
    ].join("\n");

    it("reads the bind once, read only, and sends one nsupdate per changed zone on stdin", async () => {
      const { mod, nsupdates, execs } = load({ dump });
      const res = await mod.sync();
      expect(execs).to.have.length(1);
      expect(execs[0].args.slice(0, 2)).to.deep.equal(["exec", "DAppNodeCore-bind.dnp.dappnode.eth"]);
      expect(execs[0].args.join(" ")).to.not.match(/nsupdate|rndc|\brm\b|>\s*\/(etc|config)/);
      // my.ava.do and eth from the dump; the 3 zones the dump lacks get the
      // running names written, like the cron script does
      expect(nsupdates.map(n => n.file)).to.deep.equal(Array(5).fill("nsupdate"));
      const zonesSent = nsupdates.map(n => n.input.split("\n")[1]);
      expect(zonesSent.sort()).to.deep.equal(
        ["zone avado.", "zone avadopackage.com.", "zone dappnode.", "zone eth.", "zone my.ava.do."]
      );
      expect(nsupdates[0].args).to.deep.equal(["-v", "-t", "10"]);
      const all = nsupdates.map(n => n.input).join("\n");
      expect(all).to.include("update delete mcp.my.ava.do A");
      expect(all).to.include("update delete ethchain-geth.my.ava.do A");
      expect(all).to.not.match(/update (delete|add) (admin|wifi|bind|dappmanager)\.my\.ava\.do/);
      expect(res.deleted).to.include("mcp.my.ava.do");
      expect(res.zonesRead.sort()).to.deep.equal(["eth", "my.ava.do"]);
    });

    it("bind not readable: still writes running names, deletes the removed package", async () => {
      const { mod, nsupdates } = load({ dump: "", dockerExecCode: 1 });
      await mod.sync({ removed: ["mcp.avado.dnp.dappnode.eth"] });
      const myAvaDo = nsupdates.map(n => n.input).find(t => t.includes("zone my.ava.do."));
      expect(myAvaDo).to.include("update delete mcp.my.ava.do A");
      expect(myAvaDo).to.include("update add care.my.ava.do 60 A 172.33.0.4");
      expect(myAvaDo).to.not.include("ethchain-geth");
    });

    it("rejects when nsupdate fails; syncSafe does not", async () => {
      const { mod } = load({ dump, nsupdateCode: 2 });
      let error = null;
      await mod.sync().catch(e => (error = e));
      expect(error && error.message).to.match(/DNS update failed/);
      await mod.syncSafe();
    });

    it("calls during a pass share the next pass and keep the removed packages", async () => {
      const { mod, listCalls, nsupdates } = load({ dump: "", dockerExecCode: 1 });
      const a = mod.sync();
      const b = mod.sync({ removed: ["mcp.avado.dnp.dappnode.eth"] });
      const c = mod.sync();
      expect(b).to.equal(c);
      await Promise.all([a, b, c]);
      expect(listCalls()).to.equal(2);
      expect(nsupdates.map(n => n.input).join("\n")).to.include("update delete mcp.my.ava.do A");
    });
  });

  describe("watcher > classifyEvent", () => {
    const ev = (Type, Action, Attributes) => JSON.stringify({ Type, Action, Actor: { ID: "x", Attributes } });
    it("reacts to package containers, the box network and a bind start", () => {
      expect(classifyEvent(ev("container", "start", { name: `${P}care.avado.dnp.dappnode.eth` }))).to.equal("package");
      expect(classifyEvent(ev("container", "destroy", { name: `${P}mcp.avado.dnp.dappnode.eth` }))).to.equal("package");
      expect(classifyEvent(ev("network", "connect", { name: "dncore_network", container: "abc" }))).to.equal("package");
      expect(classifyEvent(ev("container", "start", { name: "DAppNodeCore-bind.dnp.dappnode.eth" }))).to.equal("bind");
    });
    it("ignores everything else", () => {
      expect(classifyEvent(ev("container", "die", { name: "DAppNodeCore-bind.dnp.dappnode.eth" }))).to.equal(null);
      expect(classifyEvent(ev("container", "start", { name: "DAppNodeCore-admin.dnp.dappnode.eth" }))).to.equal(null);
      expect(classifyEvent(ev("container", "start", { name: "random" }))).to.equal(null);
      expect(classifyEvent(ev("network", "connect", { name: "bridge" }))).to.equal(null);
      expect(classifyEvent("not json")).to.equal(null);
    });
  });
});
