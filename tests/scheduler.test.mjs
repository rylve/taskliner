import assert from "node:assert/strict";
import test from "node:test";
import {
  createSyncScheduler,
  DEFAULT_ACTIVE_PULL_MS,
  DEFAULT_IDLE_PULL_MS,
  DEFAULT_PUSH_DEBOUNCE_MS,
} from "../src/sync/scheduler.mjs";

function fakeTimers() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    find(delay) {
      return [...timers.entries()].find(([, timer]) => timer.delay === delay)?.[0] ?? null;
    },
    async run(id) {
      const timer = timers.get(id);
      assert.ok(timer, `timer ${id} should exist`);
      timers.delete(id);
      await timer.fn();
    },
  };
}

test("local changes debounce into one push and foreground pull adapts to visibility", async () => {
  const timers = fakeTimers();
  const pushes = [];
  const pulls = [];
  const scheduler = createSyncScheduler({
    onPush: async () => pushes.push("push"),
    onPull: async () => pulls.push("pull"),
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.start();
  scheduler.noteLocalChange();
  scheduler.noteLocalChange();
  assert.equal(timers.find(DEFAULT_PUSH_DEBOUNCE_MS) !== null, true);
  await timers.run(timers.find(DEFAULT_PUSH_DEBOUNCE_MS));
  assert.deepEqual(pushes, ["push"]);

  assert.equal(timers.find(DEFAULT_ACTIVE_PULL_MS) !== null, true);
  scheduler.setVisible(false);
  assert.equal(timers.find(DEFAULT_ACTIVE_PULL_MS), null);
  assert.equal(timers.find(DEFAULT_IDLE_PULL_MS), null);
  scheduler.setVisible(true);
  assert.equal(timers.find(DEFAULT_ACTIVE_PULL_MS) !== null, true);
  await timers.run(timers.find(DEFAULT_ACTIVE_PULL_MS));
  assert.deepEqual(pulls, ["pull"]);
});

test("offline keeps a local change queued until sync resumes", async () => {
  const timers = fakeTimers();
  let pushCount = 0;
  const scheduler = createSyncScheduler({
    onPush: async () => { pushCount += 1; },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.setOnline(false);
  scheduler.noteLocalChange();
  assert.equal(scheduler.getStatus().pushQueued, true);
  scheduler.setOnline(true);
  await timers.run(timers.find(DEFAULT_PUSH_DEBOUNCE_MS));
  assert.equal(pushCount, 1);
  assert.equal(scheduler.getStatus().pushQueued, false);
});

test("realtime connection suspends polling and disconnect restores the fallback", () => {
  const timers = fakeTimers();
  const scheduler = createSyncScheduler({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.start();
  assert.notEqual(timers.find(DEFAULT_ACTIVE_PULL_MS), null);

  scheduler.setRealtimeConnected(true);
  assert.equal(timers.find(DEFAULT_ACTIVE_PULL_MS), null);
  assert.equal(scheduler.getStatus().realtimeConnected, true);

  scheduler.setRealtimeConnected(false);
  assert.notEqual(timers.find(DEFAULT_ACTIVE_PULL_MS), null);
  assert.equal(scheduler.getStatus().realtimeConnected, false);
});
