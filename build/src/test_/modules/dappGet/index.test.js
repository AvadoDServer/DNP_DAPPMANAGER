const proxyquire = require("proxyquire");
const expect = require("chai").expect;
const sinon = require("sinon");

/**
 * dappGet always uses the "basic" resolver: the request plus its first-level
 * dependencies, minus what is already installed at that version. The full
 * aggregate/resolve pipeline is covered by integration.test.js.
 */

const installed = [
  { name: "web.dnp.dappnode.eth", version: "0.1.0" },
  { name: "nginx-proxy.dnp.dappnode.eth", version: "0.0.3" },
  { name: "letsencrypt-nginx.dnp.dappnode.eth", version: "0.0.4" }
];

const manifests = {
  "nginx-proxy.dnp.dappnode.eth": {
    name: "nginx-proxy.dnp.dappnode.eth",
    version: "0.0.4",
    dependencies: {
      "letsencrypt-nginx.dnp.dappnode.eth": "0.0.4",
      "bind.dnp.dappnode.eth": "0.1.4",
      "empty-version.dnp.dappnode.eth": "",
      "ipfs.dnp.dappnode.eth": "/ipfs/QmVn9UxfeprfQvfx9NkWD5s3bPxFJUZ73tuBtTfQ6FQ32X"
    }
  }
};

describe("dappGet", () => {
  const dockerList = {
    listContainers: sinon.stub().callsFake(async () => installed)
  };
  const getManifest = sinon.stub().callsFake(async req => manifests[req.name]);

  const dappGet = proxyquire("modules/dappGet", {
    "./basic": proxyquire("modules/dappGet/basic", {
      "modules/dockerList": dockerList,
      "modules/getManifest": getManifest
    })
  });

  let result;
  it("Should resolve the request with its first-level dependencies", async () => {
    result = await dappGet({
      name: "nginx-proxy.dnp.dappnode.eth",
      ver: "0.0.4"
    });
    expect(result.state).to.deep.equal({
      "nginx-proxy.dnp.dappnode.eth": "0.0.4",
      "bind.dnp.dappnode.eth": "0.1.4",
      "ipfs.dnp.dappnode.eth":
        "/ipfs/QmVn9UxfeprfQvfx9NkWD5s3bPxFJUZ73tuBtTfQ6FQ32X"
    });
  });

  it("Should skip dependencies already installed at that version", () => {
    expect(result.state).to.not.have.property(
      "letsencrypt-nginx.dnp.dappnode.eth"
    );
  });

  it("Should ignore dependencies without a version", () => {
    expect(result.state).to.not.have.property("empty-version.dnp.dappnode.eth");
  });

  it("Should list containers once and fetch the manifest once", () => {
    sinon.assert.calledOnce(dockerList.listContainers);
    sinon.assert.calledOnce(getManifest);
  });

  it("Should still resolve when listing containers fails", async () => {
    const failingDappGet = proxyquire("modules/dappGet", {
      "./basic": proxyquire("modules/dappGet/basic", {
        "modules/dockerList": {
          listContainers: async () => {
            throw Error("docker down");
          }
        },
        "modules/getManifest": getManifest
      })
    });
    const res = await failingDappGet({
      name: "nginx-proxy.dnp.dappnode.eth",
      ver: "0.0.4"
    });
    expect(res.state).to.have.property("letsencrypt-nginx.dnp.dappnode.eth");
  });
});
