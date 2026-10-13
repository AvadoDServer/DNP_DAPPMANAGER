const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");
const operations = require("modules/operations");

/**
 * While resetIpfsData empties the IPFS storage, the IPFS package must not be
 * started, restarted, stopped, removed or reset by the package calls.
 */
describe("Package calls refuse IPFS while its storage is being reset", function() {
  const IPFS = "ipfs.dnp.dappnode.eth";
  const MESSAGE = "The IPFS storage is being reset. Try again when it is done. Nothing was changed.";
  // Any docker or file access means the guard did not stop the call
  const docker = new Proxy(
    {},
    {
      get: () =>
        new Proxy(() => Promise.reject(Error("docker used")), {
          get: () => () => Promise.reject(Error("docker used"))
        })
    }
  );
  const stubs = {
    "modules/docker": docker,
    "utils/shell": sinon.stub().rejects(Error("shell used")),
    "modules/dockerList": { listContainers: sinon.stub().rejects(Error("dockerList used")) }
  };
  const calls = ["restartPackage", "togglePackage", "removePackage", "restartPackageVolumes", "resyncPackage"];

  afterEach(() => operations._reset());

  for (const name of calls) {
    it(`${name} refuses IPFS during a reset`, async () => {
      const call = proxyquire(`calls/${name}`, stubs);
      const end = operations.begin("resetIpfsData", IPFS);
      let err;
      try {
        await call({ id: IPFS });
      } catch (e) {
        err = e;
      }
      end();
      expect(err && err.message).to.equal(MESSAGE);
    });

    it(`${name} is not stopped by the guard for IPFS without a reset, or for another package`, async () => {
      const call = proxyquire(`calls/${name}`, stubs);
      for (const [id, reset] of [[IPFS, false], ["teku.avado.dnp.dappnode.eth", true]]) {
        const end = reset ? operations.begin("resetIpfsData", IPFS) : () => {};
        let err;
        try {
          await call({ id });
        } catch (e) {
          err = e;
        }
        end();
        // it goes on and fails later, on the stubs or the missing files
        if (err) expect(err.message).to.not.equal(MESSAGE);
      }
    });
  }
});
