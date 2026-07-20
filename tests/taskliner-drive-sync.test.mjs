import assert from "node:assert/strict";
import test from "node:test";

import { createTasklinerDriveSync } from "../src/google/taskliner-drive-sync.mjs";

function documentWithTitle(title) {
  return {
    schemaVersion: 3,
    nodes: {
      task: {
        id: "task",
        title,
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: 1,
        completedAt: null,
        dueAt: null,
        note: "private note",
        completedChildCount: 0,
      },
    },
    rootIds: ["task"],
    selectedId: null,
    ui: {
      tab: "active",
      theme: "easygoing",
      activeQuery: "",
      activeSort: "outline",
      progressMode: "all",
      categoryMode: false,
      dueKeepTree: false,
      dueShowUndated: false,
      titleWrap: false,
      plainTextMode: false,
      zoomId: null,
      archiveQuery: "",
      archiveSort: "completed-desc",
      archivePeriod: "all",
      archiveFrom: "",
      archiveTo: "",
    },
  };
}

function createHarness(initialTitle = "Local", deviceId = "device-test") {
  const state = { doc: documentWithTitle(initialTitle), metadata: null, secret: null, remote: null };
  const auth = {
    hasToken: () => true,
    getToken: async () => "token",
    restore: async () => true,
    connect: async () => "token",
    clear() {},
  };
  const driveClient = {
    async list() {
      return { files: state.remote ? [{ id: "file-1", name: "taskliner-sync-v1.json" }] : [] };
    },
    async download() {
      return state.remote;
    },
    async create({ content }) {
      state.remote = JSON.parse(content);
      return { id: "file-1" };
    },
    async update(_id, { content }) {
      state.remote = JSON.parse(content);
      return { id: "file-1" };
    },
  };
  const storage = {
    async readSyncMetadata() { return state.metadata; },
    async writeSyncMetadata(value) { state.metadata = JSON.parse(JSON.stringify(value)); return value; },
    async readSyncSecret() { return state.secret; },
    async writeSyncSecret(value) { state.secret = value; return value; },
    async clearSyncSecret() { state.secret = null; },
  };
  const applied = [];
  const sync = createTasklinerDriveSync({
    auth,
    storage,
    driveClient,
    getDocument: async () => state.doc,
    applyDocument: async (next) => {
      state.doc = next;
      applied.push(next);
    },
    createDeviceId: () => deviceId,
    now: () => 1_700_000_000_000,
  });
  return { state, sync, applied };
}

test("encrypted Drive sync creates a private appData snapshot", async () => {
  const harness = createHarness("Local title");
  await harness.sync.setPassphrase("a sufficiently long passphrase");
  await harness.sync.syncNow({ interactive: false });

  assert.equal(harness.state.remote.format, "taskliner-drive-sync-v1");
  assert.equal(harness.state.remote.encrypted.format, "taskliner-encrypted-v1");
  assert.equal(JSON.stringify(harness.state.remote).includes("Local title"), false);
  assert.equal(harness.state.metadata.hasSynced, true);
});

test("a second device derives the same key and adopts the remote document", async () => {
  const first = createHarness("Remote title");
  await first.sync.setPassphrase("a sufficiently long passphrase");
  await first.sync.syncNow({ interactive: false });

  const second = createHarness("Tutorial title");
  second.state.remote = first.state.remote;
  await second.sync.setPassphrase("a sufficiently long passphrase");
  await second.sync.syncNow({ interactive: false });

  assert.equal(second.state.doc.nodes.task.title, "Remote title");
  assert.equal(second.applied.length > 0, true);
});

test("a wrong sync passphrase is rejected before changing local data", async () => {
  const first = createHarness("Private");
  await first.sync.setPassphrase("a sufficiently long passphrase");
  await first.sync.syncNow({ interactive: false });

  const second = createHarness("Keep this");
  second.state.remote = first.state.remote;
  await assert.rejects(
    second.sync.setPassphrase("a different long passphrase"),
  );
  assert.equal(second.state.doc.nodes.task.title, "Keep this");
});

test("a deleted node is represented as a tombstone for another device", async () => {
  const first = createHarness("Keep", "device-first");
  await first.sync.setPassphrase("a sufficiently long passphrase");
  await first.sync.syncNow({ interactive: false });

  const second = createHarness("Tutorial", "device-second");
  second.state.remote = first.state.remote;
  await second.sync.setPassphrase("a sufficiently long passphrase");
  await second.sync.syncNow({ interactive: false });
  second.state.doc = documentWithTitle("Another task");
  second.state.doc.nodes.other = { ...second.state.doc.nodes.task, id: "other", title: "Another task" };
  second.state.doc.rootIds = ["other"];
  delete second.state.doc.nodes.task;
  await second.sync.syncNow({ interactive: false });

  const third = createHarness("Local", "device-third");
  third.state.remote = second.state.remote;
  await third.sync.setPassphrase("a sufficiently long passphrase");
  await third.sync.syncNow({ interactive: false });
  assert.equal(third.state.doc.nodes.task, undefined);
  assert.equal(third.state.doc.nodes.other.title, "Another task");
});
