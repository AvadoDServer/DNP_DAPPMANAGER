const expect = require("chai").expect;
const { tick } = require("watchers/backup");

describe("watchers > backup (every week)", () => {
  const DAY = 24 * 3600 * 1000;
  const now = Date.parse("2026-11-12T10:00:00Z");
  const base = { setUp: true, weekly: true, job: null };
  const run = async (s, startImpl = async () => {}) => tick({ now, status: async () => s, start: startImpl });
  it("starts when the last good backup is a week old or missing", async () => {
    expect(await run({ ...base, lastSuccessAt: new Date(now - 7 * DAY).toISOString() })).to.equal("started");
    expect(await run({ ...base, lastSuccessAt: null })).to.equal("started");
  });
  it("waits otherwise, and never when off, not set up or busy", async () => {
    expect(await run({ ...base, lastSuccessAt: new Date(now - 3 * DAY).toISOString() })).to.equal("notYet");
    expect(await run({ ...base, weekly: false })).to.equal("skip");
    expect(await run({ ...base, setUp: false })).to.equal("skip");
    expect(await run({ ...base, job: { done: false } })).to.equal("skip");
  });
  it("keeps a note when the disk is missing", async () => {
    let note;
    const r = await tick({
      now,
      status: async () => base,
      start: async () => {
        throw Error("The backup disk is not plugged in. Plug it in and try again.");
      },
      setNote: m => (note = m)
    });
    expect(r).to.equal("failed");
    expect(note).to.match(/not plugged in/);
  });
});
