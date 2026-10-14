// HAND-WRITTEN `docker inspect` entries in Docker 20.10's format (only the
// fields getDiagnostics reads, plus a few around them), replaying
// ticket-0928: Teku's container runs but its teku process is FATAL. Not
// captured from a real box.

const tekuInspect = {
  Id: "6f1c2d3e4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
  Created: "2026-10-01T09:00:00.000000000Z",
  Path: "supervisord",
  Args: ["--nodaemon", "--configuration", "/etc/supervisord.conf"],
  State: {
    Status: "running",
    Running: true,
    Paused: false,
    Restarting: false,
    OOMKilled: false,
    Dead: false,
    Pid: 4242,
    ExitCode: 0,
    Error: "",
    StartedAt: "2026-10-14T08:00:00.123456789Z",
    FinishedAt: "2026-10-14T07:59:50.000000000Z"
  },
  Image: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  Name: "/DAppNodePackage-teku.avado.dnp.dappnode.eth",
  RestartCount: 0,
  Config: {
    Hostname: "6f1c2d3e4b5a",
    Image: "teku.avado.dnp.dappnode.eth:0.0.77",
    Labels: { "dappnode.dnp.dependencies": "{}" }
  },
  NetworkSettings: {
    Networks: {
      dncore_network: {
        IPAMConfig: null,
        Aliases: ["teku.avado.dnp.dappnode.eth", "6f1c2d3e4b5a"],
        NetworkID: "abc",
        Gateway: "172.33.0.1",
        IPAddress: "172.33.0.20",
        IPPrefixLen: 16
      }
    }
  }
};

const ipfsInspect = {
  Id: "1111",
  State: {
    Status: "restarting",
    Running: true,
    Restarting: true,
    OOMKilled: false,
    Dead: false,
    Pid: 0,
    ExitCode: 1,
    Error: "",
    StartedAt: "2026-10-14T09:59:30.000000000Z",
    FinishedAt: "2026-10-14T09:59:40.000000000Z"
  },
  Name: "/DAppNodeCore-ipfs.dnp.dappnode.eth",
  RestartCount: 41,
  Config: { Image: "ipfs.dnp.dappnode.eth:0.2.31" },
  NetworkSettings: { Networks: { dncore_network: { IPAddress: "" } } }
};

const nethermindInspect = {
  Id: "2222",
  State: {
    Status: "exited",
    Running: false,
    Restarting: false,
    OOMKilled: true,
    Dead: false,
    Pid: 0,
    ExitCode: 137,
    Error: "",
    StartedAt: "2026-10-13T08:00:00Z",
    FinishedAt: "2026-10-14T09:55:00Z",
    Health: { Status: "unhealthy", FailingStreak: 3, Log: [] }
  },
  Name: "/DAppNodePackage-avado-dnp-nethermind.public.dappnode.eth",
  RestartCount: 0,
  Config: { Image: "avado-dnp-nethermind.public.dappnode.eth:0.0.73" },
  NetworkSettings: { Networks: { dncore_network: { IPAddress: "" } } }
};

const psOutput = [
  "DAppNodePackage-teku.avado.dnp.dappnode.eth\tUp 2 hours",
  "DAppNodeCore-ipfs.dnp.dappnode.eth\tRestarting (1) 20 seconds ago",
  "DAppNodePackage-avado-dnp-nethermind.public.dappnode.eth\tExited (137) 5 minutes ago",
  "portainer\tUp 3 days"
].join("\n");

const tekuSupervisor = [
  "monitor                          RUNNING   pid 31, uptime 1:59:58",
  "nginx                            RUNNING   pid 32, uptime 1:59:58",
  "reload-certs                     RUNNING   pid 33, uptime 1:59:58",
  "teku                             FATAL     Exited too quickly (process log may have details)"
].join("\n");

const SECRET = "hunter2-very-secret";
const tekuLogs = [
  "2026-10-14T09:58:00.000000001Z 09:58:00.000 INFO  - Loading initial state from https://checkpoint.example.org/eth/v2/debug/beacon/states/finalized",
  "2026-10-14T09:58:01.000000001Z 09:58:01.000 ERROR - Failed to load initial state: java.net.SocketTimeoutException: Connect timed out",
  `2026-10-14T09:58:01.500000001Z settings: password=${SECRET} token: abc`,
  "2026-10-14T09:58:02.000000001Z \u001b[31m09:58:02.000 FATAL - Exiting due to fatal error\u001b[0m"
].join("\n");

module.exports = {
  tekuInspect,
  ipfsInspect,
  nethermindInspect,
  psOutput,
  tekuSupervisor,
  tekuLogs,
  SECRET
};
