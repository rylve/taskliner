import assert from "node:assert/strict";
import test from "node:test";

import { canRestoreTombstone, createTombstone, retainTombstones, TOMBSTONE_RETENTION_MS } from "../src/sync/tombstones.mjs";

test("tombstones cannot be restored by stale edits", () => {
  const tombstone = createTombstone({ nodeId: "task-1", deletedAt: "2026-07-14T00:00:00.000Z", stamp: { counter: 5, deviceId: "pc" } });
  assert.equal(canRestoreTombstone(tombstone, { counter: 5, deviceId: "aa" }), false);
  assert.equal(canRestoreTombstone(tombstone, { counter: 6, deviceId: "phone" }), true);
});

test("tombstones remain for 30 days and require acknowledgement before pruning", () => {
  const now = 100 * 24 * 60 * 60 * 1000;
  const old = createTombstone({ nodeId: "old", deletedAt: "2026-04-01", stamp: { counter: 1, deviceId: "pc" }, recordedAt: now - TOMBSTONE_RETENTION_MS - 1 });
  const recent = createTombstone({ nodeId: "recent", deletedAt: "2026-07-14", stamp: { counter: 2, deviceId: "pc" }, recordedAt: now - TOMBSTONE_RETENTION_MS + 1 });
  const retained = retainTombstones([old, recent], { now });
  assert.deepEqual(retained.map((item) => item.nodeId), ["old", "recent"]);
  const pruned = retainTombstones([old, recent], { now, acknowledged: (item) => item.nodeId === "old" });
  assert.deepEqual(pruned.map((item) => item.nodeId), ["recent"]);
});

