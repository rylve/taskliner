import assert from "node:assert/strict";
import test from "node:test";

import { decryptJson, deriveWorkspaceKey, encryptJson, generateWorkspaceKey } from "../src/crypto/workspace-crypto.mjs";
import { createDeviceState } from "../src/sync/device-state.mjs";
import { mergeDeviceStates } from "../src/sync/merge.mjs";
import { compareStamps } from "../src/sync/stamps.mjs";

const stamped = (value, counter, deviceId) => ({ value, stamp: { counter, deviceId } });

function state(deviceId, nodes) {
  return { format: "taskliner-device-state", version: 1, workspaceId: "workspace-1", deviceId, nodes };
}

function documentWithFields(title, note) {
  return {
    schemaVersion: 3,
    rootIds: ["a"],
    selectedId: null,
    nodes: {
      a: {
        id: "a",
        title,
        note,
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: 1,
        completedAt: null,
        dueAt: null,
      },
    },
    ui: {},
  };
}

test("stamps use Lamport counter then deterministic device-id order", () => {
  assert.ok(compareStamps({ counter: 2, deviceId: "b" }, { counter: 1, deviceId: "z" }) > 0);
  assert.ok(compareStamps({ counter: 3, deviceId: "a" }, { counter: 3, deviceId: "b" }) < 0);
  assert.equal(compareStamps({ counter: 3, deviceId: "a" }, { counter: 3, deviceId: "a" }), 0);
});

test("merge keeps disjoint nodes and records losing title values", () => {
  const first = state("pc", {
    a: { id: "a", title: stamped("PC task", 1, "pc"), note: stamped("first", 1, "pc"), parentId: stamped(null, 1, "pc") },
  });
  const second = state("phone", {
    a: { id: "a", title: stamped("Phone task", 2, "phone"), note: stamped("first", 1, "pc"), parentId: stamped(null, 1, "pc") },
    b: { id: "b", title: stamped("Phone-only task", 1, "phone"), parentId: stamped(null, 1, "phone") },
  });

  const merged = mergeDeviceStates([first, second]);
  assert.equal(merged.nodes.a.title.value, "Phone task");
  assert.equal(merged.nodes.b.title.value, "Phone-only task");
  assert.deepEqual(merged.conflicts.map((conflict) => conflict.value), ["PC task"]);
});

test("merge is independent of the order in which device files are read", () => {
  const first = state("pc", { a: { id: "a", title: stamped("PC", 4, "pc"), parentId: stamped(null, 4, "pc") } });
  const second = state("phone", { a: { id: "a", title: stamped("Phone", 4, "phone"), parentId: stamped(null, 4, "phone") } });
  assert.deepEqual(mergeDeviceStates([first, second]), mergeDeviceStates([second, first]));
});

test("device snapshots retain stamps for fields that did not change locally", () => {
  const first = createDeviceState({
    doc: documentWithFields("Title from A", "Shared note"),
    workspaceId: "workspace-1",
    deviceId: "device-a",
    lamportCounter: 1,
  });
  const second = createDeviceState({
    doc: documentWithFields("Title from A", "Note from B"),
    workspaceId: "workspace-1",
    deviceId: "device-b",
    lamportCounter: 2,
    previousState: first,
  });

  const merged = mergeDeviceStates([first, second]);
  assert.equal(merged.nodes.a.title.value, "Title from A");
  assert.deepEqual(merged.nodes.a.title.stamp, first.nodes.a.title.stamp);
  assert.equal(merged.nodes.a.note.value, "Note from B");
  assert.deepEqual(merged.nodes.a.note.stamp, second.nodes.a.note.stamp);
});

test("parent cycles are quarantined as recovery entries", () => {
  const merged = mergeDeviceStates([
    state("pc", {
      a: { id: "a", title: stamped("A", 1, "pc"), parentId: stamped("b", 1, "pc") },
      b: { id: "b", title: stamped("B", 1, "pc"), parentId: stamped("a", 1, "pc") },
    }),
  ]);
  assert.equal(merged.nodes.a.parentId.value, null);
  assert.equal(merged.nodes.b.parentId.value, null);
  assert.equal(merged.recovery.length, 2);
});

test("AES-GCM envelope round-trips JSON and rejects tampering", async () => {
  const key = await generateWorkspaceKey();
  const payload = { format: "taskliner-device-state", nodes: { a: { title: "private" } } };
  const envelope = await encryptJson(payload, key, { associatedData: "workspace-1" });
  assert.equal(envelope.format, "taskliner-encrypted-v1");
  assert.equal(envelope.ciphertext.includes("private"), false);
  assert.deepEqual(await decryptJson(envelope, key, { associatedData: "workspace-1" }), payload);
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  await assert.rejects(() => decryptJson(envelope, key, { associatedData: "workspace-1" }));
});

test("passphrase derivation returns metadata needed by a second device", async () => {
  const first = await deriveWorkspaceKey("a sufficiently long passphrase", { iterations: 1_000 });
  const second = await deriveWorkspaceKey("a sufficiently long passphrase", { salt: first.salt, iterations: first.iterations });
  const envelope = await encryptJson({ ok: true }, first.key);
  assert.deepEqual(await decryptJson(envelope, second.key), { ok: true });
  assert.equal(first.kdf, "PBKDF2-SHA-256");
  assert.equal(first.salt, second.salt);
});

