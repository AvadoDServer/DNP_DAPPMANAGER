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

- `listLostData()`: one scan of every installed non-core package. `result` is a
  `LostDataEntry[]` with only the packages that have at least one candidate.
- `findLostData({ id })`: the same scan for one package. `result` is one
  `LostDataEntry`, with `candidates: []` when there are none.
- `recoverLostData({ id, volume })`: `volume` must be the `name` of a candidate
  of a fresh scan. Stops the package, copies every file and folder that does not
  exist in the live volume yet (existing files are never overwritten; owners,
  modes and symlinks are kept), checks that every source file exists in the live
  volume, and always starts the package again. `result` is `{ files, sizeKb }`.
  Refuses core packages and the DAPPMANAGER.

```
LostDataEntry = { package, title, live: LiveVolume[], candidates: Candidate[] }
LiveVolume    = { name, mountPath }  // named volumes mounted by the package
Candidate     = { name, anonymous, createdAt, entries, sizeKb, target }
```

A candidate is a volume that no container mounts (running or not) and that

- is named `<prefix>_<short>`, where `<short>` is the part after the last `_`
  of one of the package's live volumes and `<prefix>` equals the package name
  once everything but `[a-z0-9]` is removed from both; `target` is that live
  volume, or
- is anonymous (64 hex characters), the package has exactly one live volume
  (`target`), and both share at least one top-level entry name.

Candidates are probed read-only with busybox (`entries`: first 50 top-level
names, `sizeKb`: `du -sk`); empty ones and ones that cannot be read are left
out. Every volume name is checked against `/^[A-Za-z0-9_.-]+$/` before it is
used in a command. A healthy box costs one `docker volume ls` and the container
list; busybox only runs when an unused volume matches.
