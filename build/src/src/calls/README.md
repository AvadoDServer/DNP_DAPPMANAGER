# Calls

Each call function is a Remote procedure call (RPC) registered to autobahn.js (crossbar). All files return an async function with only one argument (key-word arguments, kwargs) and returns a response object. The kwargs is es6-deconstructed to access the arguments sent by the callee to execute the task.

```javascript
const someCall = async ({ arg1, arg2 }) => {
  /*
   * Call code
   */
  return {
    message: "Successfully did something",
    result
  };
};
```

The response object must always contain a message property and can also contain

- `result`: data to be consumed by the RPC callee
- `logMessage`: boolean flag, the DAPPMANAGER will log the result to its logs.
- `userAction`: boolean flag, the DAPPMANAGER will log the result to the userAction logs.

When registered to autobahn.js, each handler is wrapped with a function. It calls the handler inside a try/catch block and standarizes the response. Autobahn calls its handlers with three arguments:

0.  `args`: an array with call arguments
1.  `kwargs`: an object with call arguments
1.  `details`: an object which provides call metadata

Currently we only use kwargs.

```javascript
const wrapper = (handler) => async function(args, kwargs, details) {

    try {
        const res = await handler(kwargs);

        ...

        // Return to call result
        return JSON.stringify({
            success: true,
            message: res.message,
            result: res.result || {},
        });
    } catch (err) {

        ...

        return JSON.stringify({
            success: false,
            message: err.message,
        });
    }
};
```

## Lost data recovery

A package can come up after an update with a new, empty volume while its data
stays in an old one that no container uses (for example a compose v1 vs v2
project name). These calls find such volumes and copy the data back. Nothing is
ever deleted. The scan lives in `modules/lostData.js`.

### `listLostData()`

One scan of every installed non-core package, for the Home finding. Read-only.
Only name-matched candidates (`confidence: "high"`); anonymous volumes are never
looked at here.

```
{ message, result: LostDataEntry[] }   // only packages with >= 1 candidate
```

### `findLostData({ id })`

The same scan for one package, for the package page, including anonymous
volumes (`confidence: "low"`). `id` is required. Read-only.

```
{ message, result: LostDataEntry }
// candidates: [] when there are none; for a core or not installed package
// result is { package: id, live: [], candidates: [], recovered: [] }
```

### `recoverLostData({ id, volume })`

`volume` must be the `name` of a candidate of a fresh scan (high or low
confidence), otherwise it throws `That volume is not on the list any more.
Reload the page and try again.` Refuses core packages and the DAPPMANAGER, and
a second recovery of the same package while one is running (`A recovery for
this app is already running.`).

Stops the package, then copies, in one busybox run:
- every entry is walked parents first (any file name, also with newlines);
- an entry that already exists in the live volume, or whose parent folder in
  the live volume is a symlink, is kept as it is and counted as skipped;
- a missing folder is created with the old owner and mode; anything else is
  copied with `cp -a` to `<name>.avado-recover-tmp-<8 random hex>` (a new
  suffix for every run) and renamed into place with `mv -n`, so an
  interrupted copy never leaves half a file under the real name. A retry
  copies the file again under a new temporary name; the half file of the
  interrupted run stays under its temporary name (nothing is deleted). If an
  entry with the run's temporary name exists already, that entry fails;
- a failed entry is counted and the walk goes on;
- the number of files walked must equal an independent count of the old
  volume's files, and an old volume with files must lead to at least one
  copied or skipped file. Otherwise it fails with `FAILED walk` (busybox
  before 1.32 cannot walk NUL-separated names and would copy nothing).

**The package is always started again afterwards, also when it was stopped
before the call**, and also when the copy failed. On success the volume is
stored in the db under `lostDataRecovered` (`[{ volume, package, at }]`), is
never offered as a candidate again, and is listed under `recovered`.

```
{
  message: "Recovered <copied> files into <target> from <volume>",
  logMessage: true,
  userAction: true,
  result: {
    files,     // regular files in the old volume
    copied,    // files - skipped
    skipped,   // files that already existed in the live volume (or sit
               // under a symlinked folder there) and were kept as they were
    sizeKb,    // du -sk of the live volume after the copy
    warning?   // only when a kept file whose path contains "wallet" or
               // "password" (any case) differs from the old one (an identical
               // file, e.g. copied by an earlier attempt, gives no warning):
               // "Some files already existed in the app's storage and were kept;
               //  the copy from the old storage was not used for them."
  }
}
```

Errors (the package is started again in every case; the files copied before
the error stay in the live volume):
- `Recovering the data failed: <n> file(s) could not be copied (first: <path>).
  Nothing was deleted; contact AVADO support.`
- `Recovering the data failed: only <walked> of the <found> files in the old
  storage could be read. Nothing was deleted; contact AVADO support.`
- `Recovering the data failed: <first error line>. Nothing was deleted; contact
  AVADO support.`
- `Recovering the data took longer than 10 minutes and was stopped. Files
  already copied were kept; contact AVADO support.`

### Shapes

```
LostDataEntry = {
  package: string,             // dnp name
  title: string,               // e.g. "Rocketpool"
  live: LiveVolume[],
  candidates: Candidate[],     // "high" first
  recovered: { volume: string, at: string /* ISO date */ }[]
}
LiveVolume = { name: string, mountPath: string|null }  // named volumes of the package
Candidate  = {
  name: string,                // the unused volume
  anonymous: boolean,
  confidence: "high" | "low",  // "low" = anonymous, show as "not sure"
  createdAt: string|null,      // docker volume inspect .CreatedAt
  entries: string[],           // first 50 top-level names
  sizeKb: number,
  target: string               // live volume the data would be copied into
}
```

### How candidates are found

Only volumes that no container mounts (running or not, package or not) and that
were not recovered before are looked at.

- **confidence "high"** (name match): each live volume's key is the part after
  the first `_` whose prefix, lower-cased with everything but `[a-z0-9]`
  removed, equals the package name treated the same way (e.g.
  `nethermindavadodnpdappnodeeth_nethermind_db` has key `nethermind_db`). A
  volume matches when it splits at some `_` into such a prefix and the same key;
  `target` is that live volume.
- **confidence "low"** (anonymous, 64 hex characters), only in `findLostData`
  and `recoverLostData`, only when all of these hold:
  - the package has exactly one live volume (`target`);
  - the package name contains none of teku, nimbus, lighthouse, prysm,
    validator, eth2 (their data holds validator keys);
  - the volume shares a top-level name with the live volume, not counting
    `settings.json`, `settings`, `data`, `config`, `keys`, `logs`, `db`,
    `validators`, `validator` and names starting with `.`;
  - it fits no other package with one live volume (validator packages
    included), and every such live volume could be read.

Volumes are probed read-only with busybox: `ls -A`, batched with up to 20
volumes per busybox run (a failed batch is retried one volume at a time), then
`du -sk` only for the final candidates. Empty ones and ones that cannot be
read are left out; a probe container that fails is removed by name. Every
volume name is checked against `/^[A-Za-z0-9_.-]+$/` before it is used in a
command.

Cost: `listLostData` runs one `docker volume ls`, the container list and one
db read; busybox only runs when an unused volume matches a package by name.
`findLostData` and `recoverLostData` (which scans again before copying, also
for a high-confidence candidate) also run the batched `ls -A` (20 volumes per
busybox run) over the unused anonymous volumes and the single live volumes
when the package could receive an anonymous volume.

### Known limits

- A file or folder name longer than about 228 characters cannot be copied:
  the temporary name is 27 characters longer and would pass the 255-character
  limit. Such an entry fails (`FAILED`), everything else is copied.
- Temporary files of an interrupted run stay in the live volume.
- Folders created by the recovery do not keep their modification time.

## IPFS storage reset

After a few sudden power losses the IPFS repo can be damaged: the IPFS core
container then restarts over and over, and with IPFS down nothing can be
installed or updated. These calls let the Admin show that and fix it with one
click. The container helpers live in `modules/ipfsNode.js`.

### `getIpfsHealth()`

Read-only and cheap, for the Admin's "IPFS keeps restarting" check (the Admin
polls it every 2 minutes while its tab is open; DAPPMANAGER 10.0.52 and newer). One
`docker inspect DAppNodeCore-ipfs.dnp.dappnode.eth`, plus
`docker logs --tail 10` only when IPFS is restarting, not running, or
restarted in the last hour. It is a call of its own rather than a part of
`listLostData` (a volume scan every 10 minutes that can take minutes) or
`getStats` (every few seconds).

```
{
  message,
  result: {
    exists,            // false when there is no IPFS container (all else empty)
    running,           // running and not restarting
    restarting,        // Docker State.Restarting
    restartCount,      // Docker RestartCount since the container was created
    restartsLastHour,  // from earlier calls of this DAPPMANAGER process: 0
                       // until a second call; a new container counts from 0
    startedAt,         // Docker State.StartedAt or null
    lastLogLines,      // <= 10 lines, colours removed, each <= 300 characters
    resetRunning       // resetIpfsData is running now
  }
}
```

### `resetIpfsData()`

No arguments. Empties the IPFS data volume and starts IPFS on a new repo.

1. Refuses (nothing is changed) while another long operation runs in this
   process (`modules/operations.js`): an install or update (also core updates
   and the auto-updater), a beacon reset (`resetBeaconData`), a lost-data
   recovery (`recoverLostData`), or another IPFS reset (`Resetting the IPFS
   storage is already running.`). An install stops counting after **2 hours**
   (`operations.MAX_AGE`): an IPFS download that stalls after its first chunk
   never times out, and the longest legitimate install (a multi-GB image over
   a slow line, then loaded into Docker on a busy disk) stays well under that.
   Refuses when `DNCORE/docker-compose-ipfs.yml` is missing, or when the IPFS
   container's `/data/ipfs` mount is not one named volume matching
   `/^[a-z0-9]+_ipfsdnpdappnodeeth_data$/`.
2. While it runs, these refuse for `ipfs.dnp.dappnode.eth` (`The IPFS storage
   is being reset. Try again when it is done. Nothing was changed.`):
   `installPackage` (for every package), `restartPackage`, `togglePackage`,
   `removePackage`, `restartPackageVolumes` and `resyncPackage`.
3. `docker-compose -p dncore -f DNCORE/docker-compose-ipfs.yml stop --timeout
   300`. The container is **stopped, never removed**: a stopped
   `restart: always` container is started again when Docker starts, so a power
   cut or a Reboot in the middle never leaves the box without IPFS.
   `compose down` is never used (it can remove networks).
4. In named busybox containers (removed by name when the shell fails or times
   out), in this order:
   - `rm -f /v/migrate3`: the IPFS package's `start_ipfs` wipes the repo and
     runs `ipfs init` whenever this marker is missing, so from here on any
     interrupted reset still ends in a clean new repo on the next start;
   - `du -sk` (read-only, 5 minutes, best effort: `removedKb: null`);
   - `rm -f /v/migrate3; rm -rf /v/* /v/.[!.]* /v/..?*` (1 hour);
   - `ls -A` (read-only, 5 minutes), which must print nothing.
   The volume itself stays (`docker volume rm` is never used), so it keeps its
   name and compose project.
5. `docker-compose … up -d`, always, also after a failure in 3 or 4: it starts
   the stopped container (or creates a missing one). Waits up to 2 minutes for
   the IPFS API (`POST http://my.ipfs.dnp.dappnode.eth:5001/api/v0/id`). IPFS
   counts as started only when its container is then in state `running`
   (`restarting` or `created` are a failed start, also when the API answered
   once). Then it connects to the AVADO store nodes
   (`params.IPFS_STORE_PEERS`, best effort) and counts the peers.

**IPFS container missing** (with the compose file in place): the call does not
refuse. It empties the volume compose uses for it
(`<project>_ipfsdnpdappnodeeth_data`, `dncore_…` on a box) when that exists,
and runs `up -d`, which creates the container.

**Interrupted by a DAPPMANAGER restart** (its own update, a crash): the db key
`ipfsResetRunning` is set for the whole call. A stopped container is not
started by its restart policy until Docker itself restarts, so on start the
DAPPMANAGER (`recoverInterruptedReset`, called from `index.js`) removes any
`ipfs-reset-*` busybox still running and runs `up -d`. The marker was deleted
first, so IPFS sets up a new repo by itself.

The IPFS package (AVADO-DNP-ipfs `build/start_ipfs`) runs `ipfs init` when the
repo has no `migrate3` file (lines 19–27) and applies its config (API and
gateway addresses, routing, connection manager, `StorageMax`, profile) on
every start, so nothing else has to be set again. The new repo has a new peer
id, no pins and the default bootstrap peers. The DAPPMANAGER keeps no "hash not
available" state: every download asks IPFS again (and pins what it downloaded).

**Deleted:** only the contents of the IPFS data volume
(`dncore_ipfsdnpdappnodeeth_data`): the package files IPFS keeps as a cache,
its pins and its peer identity. **Kept:** the volume itself, the export volume
(`dncore_ipfsdnpdappnodeeth_export`), everything in `DNCORE`, every package
and its data. Packages that are installed keep working; IPFS downloads
package files again when they are needed.

```
{
  message: "Deleted 1.3 GB of IPFS storage. IPFS is running again.",
  logMessage: true,
  userAction: true,
  result: {
    removedKb,           // du -sk before emptying, null when unknown
    restarted,           // the API answered within 2 minutes; false when the
                         // container runs but is still starting
    peersConnected,      // IPFS peers at the end, null when unknown
    storePeersConnected  // AVADO store nodes connected
  }
}
```

Errors (IPFS is started again in every case after step 3):
- `IPFS could not be stopped. Nothing was deleted; IPFS is being started again.`
- `Deleting the IPFS storage failed. IPFS is being started again.`
- `Could not check the IPFS storage after deleting it. IPFS is being started again.`
- `Some of the IPFS storage could not be deleted. IPFS is being started again.`
- `IPFS storage was emptied but IPFS did not start again. Restart your AVADO or
  contact AVADO support.` (the start failed, or the container is not in state
  `running` after 2 minutes)
- an error of step 3 or 4 and a failed start: the first message without
  "IPFS is being started again", then `IPFS did not start again. Restart your
  AVADO or contact AVADO support.`

Safe to call again after any failure.

### Known limits

- The lock is in memory: a DAPPMANAGER restart forgets it (the operations it
  guards end with that restart; an interrupted IPFS reset is finished by
  `recoverInterruptedReset`).
- `restartsLastHour` starts at 0 after a DAPPMANAGER restart; `restarting`
  still shows a crash loop right away.
- The store node's peer id is fixed in `params.js`; if that node gets a new
  repo the connect fails (logged) and IPFS finds the store through the DHT,
  which can take hours for a new build.
- `rebootHost` is not refused during a reset; a reboot mid-reset is safe (the
  stopped container comes back with Docker and re-inits its repo).
