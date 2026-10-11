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

One scan of every installed non-core package. Read-only.

```
{ message, result: LostDataEntry[] }   // only packages with >= 1 candidate
```

### `findLostData({ id })`

The same scan for one package. `id` is required. Read-only.

```
{ message, result: LostDataEntry }
// candidates: [] when there are none; for a core or not installed package
// result is { package: id, live: [], candidates: [], recovered: [] }
```

### `recoverLostData({ id, volume })`

`volume` must be the `name` of a candidate of a fresh scan, otherwise it throws
`That volume is not on the list any more. Reload the page and try again.`
Refuses core packages and the DAPPMANAGER. Stops the package, copies every file
and folder that does not exist in the live volume yet (existing files are never
overwritten; owners, modes and symlinks are kept), checks that every source file
exists in the live volume, and always starts the package again. On success the
volume is stored in the db under `lostDataRecovered` (`[{ volume, package, at }]`)
and is never offered as a candidate again; it is listed under `recovered`.

```
{
  message: "Recovered <files> files into <target> from <volume>",
  logMessage: true,
  userAction: true,
  result: {
    files,     // number of files in the old volume (all present in the live one)
    sizeKb,    // du -sk of the live volume after the copy
    skipped,   // files of the old volume that already existed in the live one
               // and were kept as they were (not copied)
    warning?   // only when skipped > 0 and a kept file's path contains
               // "wallet" or "password" (any case):
               // "Some files already existed in the app's storage and were kept;
               //  the copy from the old storage was not used for them."
  }
}
```

Errors: `Recovering the data failed: <first line>. Nothing was deleted; contact
AVADO support.` (a `MISSING ./path` line or the first error line), and
`Recovering the data took longer than 10 minutes and was stopped. Files already
copied were kept; contact AVADO support.` The package is started again in both
cases.

### Shapes

```
LostDataEntry = {
  package: string,             // dnp name
  title: string,               // e.g. "Rocketpool"
  live: LiveVolume[],
  candidates: Candidate[],
  recovered: { volume: string, at: string /* ISO date */ }[]
}
LiveVolume = { name: string, mountPath: string|null }  // named volumes of the package
Candidate  = {
  name: string,                // the unused volume
  anonymous: boolean,
  createdAt: string|null,      // docker volume inspect .CreatedAt
  entries: string[],           // first 50 top-level names
  sizeKb: number,
  target: string               // live volume the data would be copied into
}
```

### How candidates are found

A candidate is a volume that no container mounts (running or not), that was not
recovered before, and that

- is named `<prefix>_<short>`, where `<short>` is the part after the last `_`
  of one of the package's live volumes and `<prefix>` equals the package name
  once everything but `[a-z0-9]` is removed from both; `target` is that live
  volume, or
- is anonymous (64 hex characters), the package has exactly one live volume
  (`target`), and both share at least one top-level entry name.

Candidates are probed read-only with busybox (`entries`, `sizeKb` from
`du -sk`); empty ones and ones that cannot be read are left out. Every volume
name is checked against `/^[A-Za-z0-9_.-]+$/` before it is used in a command. A
healthy box costs one `docker volume ls`, the container list and one db read;
busybox only runs when an unused volume matches.
