import assert from "node:assert/strict";
import test from "node:test";

import {
  PENDING_OPERATIONS_FORMAT,
  PendingOperations,
  addPendingOperation,
  coalescePendingOperations,
  createPendingOperations,
  getRetryCandidates,
  isOperationIdempotent,
} from "../src/sync/pending-operations.mjs";

function operation(operationId, value, overrides = {}) {
  return {
    operationId,
    nodeId: "node-1",
    field: "title",
    value,
    ...overrides,
  };
}

test("pending operations add in memory and survive JSON serialization", () => {
  const queue = createPendingOperations({ now: () => 100 });
  const added = queue.add(operation("op-1", "first", { stamp: { counter: 1, deviceId: "device-a" } }));

  assert.equal(added.operationId, "op-1");
  assert.equal(queue.size, 1);
  assert.equal(JSON.parse(JSON.stringify(queue)).format, PENDING_OPERATIONS_FORMAT);

  const restored = new PendingOperations(queue.serialize());
  assert.deepEqual(restored.operations(), queue.operations());
});

test("ack removes an operation and makes its ID idempotent", () => {
  const queue = createPendingOperations();
  queue.add(operation("op-1", "first"));

  assert.equal(queue.isIdempotent("op-1"), true);
  assert.equal(queue.ack("op-1"), true);
  assert.equal(queue.size, 0);
  assert.equal(queue.isIdempotent("op-1"), true);
  assert.equal(queue.ack("op-1"), true);
  assert.equal(queue.isIdempotent("op-2"), false);
});

test("retry candidates respect nextAttemptAt and attempt bookkeeping", () => {
  const queue = createPendingOperations(undefined, { now: () => 100, retryDelayMs: 50 });
  queue.add(operation("op-1", "first", { nextAttemptAt: 90 }));
  queue.add(operation("op-2", "second", { nodeId: "node-2", nextAttemptAt: 150 }));

  assert.deepEqual(queue.getRetryCandidates({ now: 100 }).map((item) => item.operationId), ["op-1"]);
  const attempted = queue.markAttempt("op-1", { now: 100 });
  assert.equal(attempted.attempts, 1);
  assert.equal(queue.getRetryCandidates({ now: 149 }).length, 0);
  assert.deepEqual(queue.getRetryCandidates({ now: 150 }).map((item) => item.operationId), ["op-1", "op-2"]);
});

test("adjacent edits to the same node field coalesce while preserving idempotency", () => {
  const queue = createPendingOperations();
  queue.add(operation("op-1", "A"));
  queue.add(operation("op-2", "AB"));

  assert.equal(queue.size, 1);
  assert.equal(queue.operations()[0].operationId, "op-1");
  assert.equal(queue.operations()[0].value, "AB");
  assert.equal(queue.isIdempotent("op-2"), true);
  assert.equal(queue.ack("op-2"), true);
  assert.equal(queue.size, 0);
  assert.equal(queue.isIdempotent("op-1"), true);
});

test("coalesce only joins consecutive edits and does not mutate attempted operations", () => {
  const state = {
    operations: [
      operation("op-1", "A"),
      operation("op-2", "B", { field: "note" }),
      operation("op-3", "C"),
      operation("op-4", "D", { attempts: 1 }),
      operation("op-5", "E"),
    ],
  };
  const result = coalescePendingOperations(state);

  assert.deepEqual(result.operations.map((item) => item.operationId), ["op-1", "op-2", "op-3", "op-4", "op-5"]);
  assert.deepEqual(result.operations.map((item) => item.value), ["A", "B", "C", "D", "E"]);
});

test("reusing an operation ID is a no-op, but changing its payload is rejected", () => {
  const queue = createPendingOperations();
  queue.add(operation("op-1", "A"));
  queue.add(operation("op-1", "A"));
  assert.equal(queue.size, 1);
  assert.throws(() => queue.add(operation("op-1", "different")), /collision/);
});

test("standalone helpers keep the state JSON-shaped", () => {
  const state = addPendingOperation(undefined, operation("op-1", "A"));
  assert.equal(isOperationIdempotent(state, "op-1"), true);
  assert.deepEqual(getRetryCandidates(state, { now: Date.now() }).map((item) => item.operationId), ["op-1"]);
  assert.equal(state.operations.length, 1);
});
