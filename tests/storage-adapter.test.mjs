import assert from "node:assert/strict";
import test from "node:test";
import { createStorageAdapter, STORAGE_SCHEMA_VERSION } from "../src/storage/storage-adapter.mjs";

test("storage adapter keeps sync state JSON-shaped without IndexedDB", async () => {
  const broadcastChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = undefined;
  try {
    const adapter = createStorageAdapter({ key: `taskliner-test-${Date.now()}` });
    const pending = {
      format: "taskliner-pending-operations",
      version: 1,
      operations: [{ operationId: "op-1", nodeId: "node-1", field: "title", value: "Draft" }],
    };
    const metadata = { workspaceId: "workspace-1", deviceId: "device-1", remoteVersion: "3" };

    assert.deepEqual(await adapter.writePendingOperations(pending), pending);
    assert.deepEqual(await adapter.readPendingOperations(), pending);
    assert.deepEqual(await adapter.writeSyncMetadata(metadata), metadata);
    assert.deepEqual(await adapter.readSyncMetadata(), metadata);
    const secret = { key: { type: "secret" }, workspaceId: "workspace-1", salt: "salt", iterations: 1_000 };
    assert.deepEqual(await adapter.writeSyncSecret(secret), secret);
    assert.deepEqual(await adapter.readSyncSecret(), secret);

    pending.operations[0].value = "Changed after write";
    metadata.remoteVersion = "4";
    assert.equal((await adapter.readPendingOperations()).operations[0].value, "Draft");
    assert.equal((await adapter.readSyncMetadata()).remoteVersion, "3");
  } finally {
    globalThis.BroadcastChannel = broadcastChannel;
  }
});

test("storage schema reserves a version for sync records", () => {
  assert.equal(STORAGE_SCHEMA_VERSION, 5);
});

test("integration settings and completion outbox stay outside JSON export", async () => {
  const indexedDB = globalThis.indexedDB;
  const broadcastChannel = globalThis.BroadcastChannel;
  globalThis.indexedDB = undefined;
  globalThis.BroadcastChannel = undefined;
  try {
    const adapter = createStorageAdapter({ key: `taskliner-discord-test-${Date.now()}` });
    const webhookUrl = "https://discord.com/api/webhooks/123/token";
    await adapter.writeIntegrationSettings("discord", { webhookUrl });
    await adapter.putCompletionEvent({
      id: "completion-1",
      taskId: "task-1",
      visibility: "hidden",
      status: "pending",
    });
    const exported = await adapter.exportDocument({ nodes: { "task-1": { id: "task-1", title: "Task" } } });
    assert.equal(JSON.stringify(exported).includes(webhookUrl), false);
    assert.equal((await adapter.readIntegrationSettings("discord")).webhookUrl, webhookUrl);
    assert.equal((await adapter.readCompletionOutbox()).length, 1);
  } finally {
    globalThis.indexedDB = indexedDB;
    globalThis.BroadcastChannel = broadcastChannel;
  }
});

test("guided tutorial storage cannot overwrite the main document", async () => {
  const previousLocalStorage = globalThis.localStorage;
  const previousBroadcastChannel = globalThis.BroadcastChannel;
  const values = new Map();
  globalThis.BroadcastChannel = undefined;
  globalThis.localStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  try {
    const mainKey = `taskliner-main-isolation-${Date.now()}`;
    const guidedKey = `taskliner-guided-isolation-${Date.now()}`;
    const main = createStorageAdapter({ key: mainKey, dbName: `${mainKey}-db` });
    const guided = createStorageAdapter({ key: guidedKey, dbName: `${guidedKey}-db` });
    const mainDoc = {
      schemaVersion: 3,
      nodes: { root: { id: "root", title: "本体のタスク", childIds: [], parentId: null } },
      rootIds: ["root"],
      selectedId: "root",
      ui: {},
    };
    const guidedDoc = {
      schemaVersion: 3,
      nodes: { "guided-root": { id: "guided-root", title: "練習用", childIds: [], parentId: null } },
      rootIds: ["guided-root"],
      selectedId: null,
      ui: {},
    };

    await main.write(mainDoc);
    await guided.write(guidedDoc);

    assert.deepEqual(JSON.parse(values.get(mainKey)), mainDoc);
    assert.deepEqual(JSON.parse(values.get(guidedKey)), guidedDoc);
    assert.equal(JSON.parse(values.get(mainKey)).nodes.root.title, "本体のタスク");
  } finally {
    globalThis.localStorage = previousLocalStorage;
    globalThis.BroadcastChannel = previousBroadcastChannel;
  }
});
