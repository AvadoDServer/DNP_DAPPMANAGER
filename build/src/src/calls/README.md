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
  copied with `cp -a` to `<name>.avado-recover-tmp` and renamed into place
  with `mv -n`, so an interrupted copy never leaves half a file under the real
  name (a retry finishes it);
- a failed entry is counted and the walk goes on.

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
    warning?   // only when skipped > 0 and a kept file's path contains
               // "wallet" or "password" (any case):
               // "Some files already existed in the app's storage and were kept;
               //  the copy from the old storage was not used for them."
  }
}
```

Errors (the package is started again in every case; the files copied before
the error stay in the live volume):
- `Recovering the data failed: <n> file(s) could not be copied (first: <path>).
  Nothing was deleted; contact AVADO support.`
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

Volumes are probed read-only with busybox: `ls -A` (several volumes per run),
then `du -sk` only for the final candidates. Empty ones and ones that cannot be
read are left out; a probe container that fails is removed by name. Every
volume name is checked against `/^[A-Za-z0-9_.-]+$/` before it is used in a
command.

Cost: `listLostData` runs one `docker volume ls`, the container list and one
db read; busybox only runs when an unused volume matches a package by name.
`findLostData` and `recoverLostData` also run one batched `ls -A` over the
unused anonymous volumes and the single live volumes when the package could
receive an anonymous volume.
