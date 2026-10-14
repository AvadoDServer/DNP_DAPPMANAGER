const expect = require("chai").expect;
const { run, runOk } = require("modules/diagnostics/exec");
const { withTimeout, mapLimit } = require("modules/diagnostics/timeout");

describe("Module: diagnostics/exec and timeout", () => {
  const node = process.execPath;

  it("collects stdout, stderr and both together, for any exit code", async () => {
    const res = await run(node, ["-e", "process.stdout.write('a\\n'); process.stderr.write('b\\n'); process.exit(3)"]);
    expect(res.code).to.equal(3);
    expect(res.stdout).to.equal("a\n");
    expect(res.stderr).to.equal("b\n");
    expect(res.combined).to.include("a\n").and.to.include("b\n");
  });

  it("passes arguments without a shell", async () => {
    const res = await run(node, ["-e", "console.log(process.argv[1])", "it's $HOME; `x`"]);
    expect(res.stdout.trim()).to.equal("it's $HOME; `x`");
  });

  it("runOk: a non-zero exit is an error with the first stderr line", async () => {
    let err;
    await runOk(node, ["-e", "console.error('Error: No such container: x\\nmore'); process.exit(1)"]).catch(e => (err = e));
    expect(err.message).to.equal("Error: No such container: x");
  });

  it("stops at the timeout", async () => {
    let err;
    await run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 200 }).catch(e => (err = e));
    expect(err.message).to.equal("timed out after 0 s");
  });

  it("withTimeout and mapLimit", async () => {
    let err;
    await withTimeout(new Promise(() => {}), 20).catch(e => (err = e));
    expect(err.message).to.equal("timed out");
    expect(await withTimeout(Promise.resolve(1), 20)).to.equal(1);
    let active = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async x => {
      active++;
      max = Math.max(max, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      return x * 2;
    });
    expect(out).to.deep.equal([2, 4, 6, 8, 10]);
    expect(max).to.equal(2);
  });
});
