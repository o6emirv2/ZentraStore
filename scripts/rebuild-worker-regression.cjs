"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createWorker } = require("../server/core/workerScheduler");
let now = 2000000000000;
let id = 0;
const scheduled = new Map();
const clock = () => now,
  schedule = (fn, delay) => {
    const key = ++id;
    scheduled.set(key, { fn, delay });
    return key;
  },
  cancel = (key) => scheduled.delete(key);
function harness(run, onError) {
  return createWorker({
    run,
    onError,
    clock,
    random: () => 0,
    schedule,
    cancel,
  });
}
async function next() {
  const [key, row] = scheduled.entries().next().value || [];
  assert(row, "worker scheduled");
  scheduled.delete(key);
  now += row.delay;
  await row.fn();
  return row;
}
test("idle work polls once per minute and active durable work polls promptly", async () => {
  let calls = 0,
    active = false;
  const w = harness(async () => {
    calls++;
    return active ? 1 : 0;
  });
  w.start();
  await next();
  assert.equal(calls, 1);
  assert.equal([...scheduled.values()][0].delay, 60000);
  active = true;
  await next();
  assert.equal(calls, 2);
  assert.equal([...scheduled.values()][0].delay, 1500);
  w.stop();
  assert.equal(scheduled.size, 0);
});
test("quota exhaustion opens a shared cooldown that manual wakeups cannot bypass", async () => {
  let failed = 0;
  const w = harness(
    async () => {
      throw Object.assign(Error("quota"), { code: 8 });
    },
    () => failed++,
  );
  w.start();
  await next();
  assert.equal(failed, 1);
  const delay = [...scheduled.values()][0].delay;
  assert.equal(delay, 900000);
  w.wake();
  assert.equal([...scheduled.values()][0].delay, 900000);
  let calls = 0;
  const other = harness(async () => {
    calls++;
    return 0;
  });
  other.start();
  assert([...scheduled.values()].every((x) => x.delay >= 900000));
  w.stop();
  await next();
  assert.equal(calls, 1);
  other.stop();
  assert.equal(scheduled.size, 0);
});
test("transient failures back off, repeated identical errors do not flood logs, and stop cancels pending work", async () => {
  now += 7200000;
  let logs = 0;
  const w = harness(
    async () => {
      throw Object.assign(Error("unavailable"), { code: 14 });
    },
    () => logs++,
  );
  w.start();
  await next();
  assert.equal([...scheduled.values()][0].delay, 60000);
  await next();
  assert.equal([...scheduled.values()][0].delay, 120000);
  assert.equal(logs, 1);
  w.stop();
  assert.equal(scheduled.size, 0);
});
