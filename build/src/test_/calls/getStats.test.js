const proxyquire = require("proxyquire");
const expect = require("chai").expect;

const testedCmdResponses = {
  // "grep 'cpu ' /proc/stat | awk '{usage=($2+$4)*100/($2+$4+$5)} END {print usage}'":
  //   "46.3738",
  "free | awk 'NR==2 { print $2}'": "7903472",
  "free | awk 'NR==2 { print $3}'": "1203200",
  "df / | awk 'NR==2 { print $5}'": "39%",
  "df / | awk 'NR==2 { print $2}'": "976762584",
  "df / | awk 'NR==2 { print $3}'": "380857348"
};

describe("Calls > getStats", function() {
  async function shellExec(cmd) {
    if (!testedCmdResponses[cmd]) throw Error(`Unknown cmd: ${cmd}`);
    return testedCmdResponses[cmd];
  }

  const os = {
    cpus: () => [{ model: "Test CPU @ 3.20GHz" }],
    loadavg: () => [0.5]
  };

  const getStats = proxyquire("calls/getStats", {
    "utils/shell": shellExec,
    os: os
  });

  it("should return the expected result", async () => {
    const res = await getStats();
    expect(res).to.be.ok;
    expect(res).to.have.property("message");
    expect(res.result).to.deep.equal({
      cpu: "50%",
      cpuName: "Test CPU @ 3.20GHz",
      memory: "15%",
      memTotal: "7.54 GB",
      memUsed: "1.15 GB",
      disk: "39%",
      diskTotal: "0.91 TB",
      diskUsed: "0.35 TB"
    });
  });
});
