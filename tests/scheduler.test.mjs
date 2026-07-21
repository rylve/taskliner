import assert from "node:assert/strict";
import test from "node:test";
import {
  createSyncScheduler,
  createSyncOperationQueue,
  DEFAULT_ACTIVE_PULL_MS,
  DEFAULT_IDLE_PULL_MS,
  DEFAULT_PUSH_DEBOUNCE_MS,
  DEFAULT_PUSH_RETRY_BASE_MS,
} from "../src/sync/scheduler.mjs";

test("sync operations run serially and continue after a failure", async () => {
  const queue = createSyncOperationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run(async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = queue.run(async () => {
    events.push("second");
    throw new Error("expected");
  });
  const third = queue.run(async () => events.push("third"));

  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await first;
  await assert.rejects(second, /expected/);
  await third;
  assert.deepEqual(events, ["first-start", "first-end", "second", "third"]);
});

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

  scheduler.start();
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

test("an incomplete push stays queued and retries", async () => {
  const timers = fakeTimers();
  let pushCount = 0;
  const scheduler = createSyncScheduler({
    onPush: async () => {
      pushCount += 1;
      return pushCount > 1;
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.start();
  scheduler.noteLocalChange();
  await timers.run(timers.find(DEFAULT_PUSH_DEBOUNCE_MS));
  assert.equal(scheduler.getStatus().pushQueued, true);
  await timers.run(timers.find(DEFAULT_PUSH_DEBOUNCE_MS));
  assert.equal(pushCount, 2);
  assert.equal(scheduler.getStatus().pushQueued, false);
});

test("an out-of-band successful sync clears a stale push queue", () => {
  const timers = fakeTimers();
  const scheduler = createSyncScheduler({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.start();
  scheduler.noteLocalChange();
  assert.notEqual(timers.find(DEFAULT_PUSH_DEBOUNCE_MS), null);
  scheduler.clearLocalChanges();
  assert.equal(scheduler.getStatus().pushQueued, false);
  assert.equal(timers.find(DEFAULT_PUSH_DEBOUNCE_MS), null);
});

test("local edits stay queued without transport work until the scheduler starts", async () => {
  const timers = fakeTimers();
  let pushCount = 0;
  const scheduler = createSyncScheduler({
    onPush: async () => { pushCount += 1; },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.noteLocalChange();
  assert.equal(scheduler.getStatus().pushQueued, true);
  assert.equal(timers.find(DEFAULT_PUSH_DEBOUNCE_MS), null);
  scheduler.start();
  await timers.run(timers.find(DEFAULT_PUSH_DEBOUNCE_MS));
  assert.equal(pushCount, 1);
});

test("transport failures use exponential retry instead of the edit debounce loop", async () => {
  const timers = fakeTimers();
  let pushCount = 0;
  const scheduler = createSyncScheduler({
    onPush: async () => {
      pushCount += 1;
      throw new Error("offline transport");
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  scheduler.start();
  scheduler.noteLocalChange();
  await timers.run(timers.find(DEFAULT_PUSH_DEBOUNCE_MS));
  assert.notEqual(timers.find(DEFAULT_PUSH_RETRY_BASE_MS), null);
  await timers.run(timers.find(DEFAULT_PUSH_RETRY_BASE_MS));
  assert.equal(pushCount, 2);
  assert.notEqual(timers.find(DEFAULT_PUSH_RETRY_BASE_MS * 2), null);
});
