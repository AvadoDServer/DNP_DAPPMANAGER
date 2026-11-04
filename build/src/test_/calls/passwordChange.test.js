const expect = require("chai").expect;
const proxyquire = require("proxyquire").noCallThru();

describe("Calls: passwordChange, passwordIsSecure", () => {
  function wrap(handler, event) {
    const logged = [];
    const lines = [];
    const { wrapErrors } = proxyquire("registerHandler", {
      "./logUserAction": { log: info => logged.push(info) },
      "./logs": () => ({ debug: m => lines.push(m), info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) })
    });
    return { call: kwargs => wrapErrors(handler, event)([], kwargs).then(JSON.parse), logged, lines };
  }

  it("success: logged as a user action with both passwords hidden", async () => {
    let received;
    const passwordChange = proxyquire("calls/passwordChange", {
      "modules/hostPassword": { changePassword: async kwargs => (received = kwargs) }
    });
    const { call, logged, lines } = wrap(passwordChange, "passwordChange.dappmanager.dnp.dappnode.eth");
    const reply = await call({ currentPassword: "avado", newPassword: "brand new 1234" });
    expect(reply).to.deep.include({ success: true, message: "Box password changed" });
    // The handler got the real values
    expect(received).to.deep.equal({ currentPassword: "avado", newPassword: "brand new 1234" });
    expect(logged).to.have.length(1);
    expect(logged[0].kwargs).to.deep.equal({ currentPassword: "(hidden)", newPassword: "(hidden)" });
    const everything = JSON.stringify(logged) + lines.join(" ") + JSON.stringify(reply);
    expect(everything).to.not.include("brand new 1234");
  });

  it("error: the plain message reaches the Admin, the passwords reach no log", async () => {
    const passwordChange = proxyquire("calls/passwordChange", {
      "modules/hostPassword": {
        changePassword: async () => {
          throw Error("The current password is wrong.");
        }
      }
    });
    const { call, logged, lines } = wrap(passwordChange, "passwordChange.dappmanager.dnp.dappnode.eth");
    const reply = await call({ currentPassword: "guess1234", newPassword: "brand new 1234" });
    expect(reply).to.deep.equal({ success: false, message: "The current password is wrong." });
    expect(logged[0]).to.include({ level: "error", message: "The current password is wrong." });
    expect(logged[0].kwargs).to.deep.equal({ currentPassword: "(hidden)", newPassword: "(hidden)" });
    const everything = JSON.stringify(logged) + lines.join(" ");
    expect(everything).to.not.match(/guess1234|brand new 1234/);
  });

  it("passwordIsSecure: true / false / null, never a user action", async () => {
    for (const [isDefault, result] of [[true, false], [false, true], [null, null]]) {
      const passwordIsSecure = proxyquire("calls/passwordIsSecure", {
        "modules/hostPassword": { isDefaultPassword: async () => isDefault }
      });
      const { call, logged } = wrap(passwordIsSecure, "passwordIsSecure.dappmanager.dnp.dappnode.eth");
      const reply = await call({});
      expect(reply.success).to.equal(true);
      expect(reply.result).to.equal(result);
      // Not flagged: logUserAction's format drops entries without userAction
      expect(logged.every(l => !l.userAction)).to.equal(true);
    }
  });

  it("hideSecrets leaves other kwargs as they are", () => {
    const { hideSecrets } = proxyquire("registerHandler", {
      "./logUserAction": { log() {} },
      "./logs": () => ({ debug() {}, info() {}, warn() {}, error() {} })
    });
    const kwargs = { id: "teku.avado.dnp.dappnode.eth", options: { a: 1 } };
    expect(hideSecrets(kwargs)).to.equal(kwargs);
    expect(hideSecrets({ id: "x", keystorePassword: "k", secret: "s", mnemonic: "m", passphrase: "p" })).to.deep.equal({
      id: "x",
      keystorePassword: "(hidden)",
      secret: "(hidden)",
      mnemonic: "(hidden)",
      passphrase: "(hidden)"
    });
    expect(hideSecrets(undefined)).to.equal(undefined);
  });
});
