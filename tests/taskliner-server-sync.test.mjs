import assert from "node:assert/strict";
import test from "node:test";

import { createDeviceState } from "../src/sync/device-state.mjs";
import { mergeDeviceStates } from "../src/sync/merge.mjs";
import {
  createTasklinerServerSync,
  REALTIME_HEARTBEAT_MS,
  REALTIME_PONG_TIMEOUT_MS,
  ServerSyncAccountMismatchError,
} from "../src/google/taskliner-server-sync.mjs";

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
        note: "note",
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function createServer() {
  const states = new Map();
  return {
    fetch: async (_path, options = {}) => {
      if (options.method === "DELETE") {
        states.clear();
        return jsonResponse({ deleted: 1 });
      }
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        states.set(body.state.deviceId, body.state);
      }
      const devices = [...states.values()].map((state) => ({ fileId: `file-${state.deviceId}`, state }));
      return jsonResponse({
        workspaceId: "taskliner-google-account-v1",
        devices,
        mergedState: mergeDeviceStates(devices.map(({ state }) => state)),
      });
    },
    states,
  };
}

function createHarness(server, title, deviceId, syncOptions = {}) {
  const state = { doc: documentWithTitle(title), metadata: null };
  const auth = { hasToken: () => true, logout: async () => undefined };
  const storage = {
    async readSyncMetadata() { return state.metadata; },
    async writeSyncMetadata(value) { state.metadata = structuredClone(value); return value; },
    async clearSyncSecret() {},
  };
  const applied = [];
  const sync = createTasklinerServerSync({
    auth,
    storage,
    fetchImpl: server.fetch,
    getDocument: async () => state.doc,
    applyDocument: async (next) => { state.doc = next; applied.push(next); },
    now: () => 1_700_000_000_000,
    ...syncOptions,
  });
  // Keep deterministic device IDs without exposing a production-only option.
  const originalRead = storage.readSyncMetadata;
  storage.readSyncMetadata = async () => ({ ...(await originalRead()), deviceId });
  return { state, sync, applied, auth };
}

test("server sync uses the same Google account without a passphrase", async () => {
  const server = createServer();
  const first = createHarness(server, "First", "device-a");
  await first.sync.syncNow({ interactive: false });

  assert.equal(first.sync.getStatus().hasPassphrase, false);
  assert.equal(server.states.size, 1);
  assert.equal(server.states.get("device-a").nodes.task.title.value, "First");
});

test("first sync adopts existing Google Drive data before uploading local tutorial data", async () => {
  const server = createServer();
  const existing = createHarness(server, "Drive is the source of truth", "device-existing");
  await existing.sync.syncNow({ interactive: false });

  const newcomer = createHarness(server, "Local tutorial", "device-new");
  const result = await newcomer.sync.syncNow({ interactive: false });

  assert.equal(result.remote, true);
  assert.equal(newcomer.state.doc.nodes.task.title, "Drive is the source of truth");
  assert.equal(server.states.has("device-new"), false);
});

test("a second device pulls and pushes through Drive-backed server sync", async () => {
  const server = createServer();
  const first = createHarness(server, "First", "device-a");
  await first.sync.syncNow({ interactive: false });

  const second = createHarness(server, "Local second", "device-b");
  await second.sync.pull({ interactive: false });
  assert.equal(second.state.doc.nodes.task.title, "First");

  second.state.doc.nodes.task.title = "Changed on second";
  second.sync.noteLocalChange();
  await second.sync.syncNow({ interactive: false });
  await first.sync.pull({ interactive: false });
  assert.equal(first.state.doc.nodes.task.title, "Changed on second");
});

test("remote pull waits while local changes are queued", async () => {
  let requests = 0;
  const server = createServer();
  const harness = createHarness({
    fetch: async (...args) => { requests += 1; return server.fetch(...args); },
  }, "Local", "device-a");
  await harness.sync.load();
  harness.sync.noteLocalChange();
  const result = await harness.sync.pull({ interactive: false });
  assert.deepEqual(result, { skipped: true, reason: "local_changes_pending" });
  assert.equal(requests, 0);
});

test("push does not apply a stale response over an edit made during the request", async () => {
  const baseServer = createServer();
  let blockPut = false;
  let releasePut;
  let putStarted;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  const putStartedGate = new Promise((resolve) => { putStarted = resolve; });
  const server = {
    states: baseServer.states,
    fetch: async (path, options = {}) => {
      if (blockPut && options.method === "PUT") {
        putStarted();
        await putGate;
      }
      return baseServer.fetch(path, options);
    },
  };
  const harness = createHarness(server, "Initial", "device-a");
  await harness.sync.syncNow({ interactive: false });

  blockPut = true;
  harness.state.doc.nodes.task.title = "First edit";
  harness.sync.noteLocalChange();
  const pushPromise = harness.sync.push({ interactive: false });
  await putStartedGate;
  harness.state.doc.nodes.task.title = "Latest edit";
  harness.sync.noteLocalChange();
  releasePut();

  const result = await pushPromise;
  assert.equal(result.skipped, true);
  assert.equal(harness.state.doc.nodes.task.title, "Latest edit");
  assert.equal(harness.sync.getStatus().localDirty, true);
});

test("pull does not apply a stale response over an edit made during the request", async () => {
  const baseServer = createServer();
  let blockGet = false;
  let releaseGet;
  let getStarted;
  const getGate = new Promise((resolve) => { releaseGet = resolve; });
  const getStartedGate = new Promise((resolve) => { getStarted = resolve; });
  const server = {
    states: baseServer.states,
    fetch: async (path, options = {}) => {
      if (blockGet && !options.method) {
        getStarted();
        await getGate;
      }
      return baseServer.fetch(path, options);
    },
  };
  const local = createHarness(server, "Local", "device-a");
  const remote = createHarness(server, "Remote", "device-b");
  await local.sync.syncNow({ interactive: false });
  await remote.sync.syncNow({ interactive: false });

  blockGet = true;
  const pullPromise = local.sync.pull({ interactive: false });
  await getStartedGate;
  local.state.doc.nodes.task.title = "Typed while checking";
  local.sync.noteLocalChange();
  releaseGet();

  const result = await pullPromise;
  assert.equal(result.skipped, true);
  assert.equal(local.state.doc.nodes.task.title, "Typed while checking");
  assert.equal(local.sync.getStatus().localDirty, true);
});

test("an empty remote snapshot never clears an already-synced local document", async () => {
  const server = createServer();
  const harness = createHarness(server, "Keep me", "device-a");
  await harness.sync.syncNow({ interactive: false });
  server.states.clear();

  const result = await harness.sync.pull({ interactive: false });
  assert.equal(result.remoteMissing, true);
  assert.equal(harness.state.doc.nodes.task.title, "Keep me");
  assert.equal(harness.sync.getStatus().hasSynced, true);
});

test("an account mismatch stops before any Drive request", async () => {
  let requests = 0;
  const server = createServer();
  const harness = createHarness({
    fetch: async (...args) => { requests += 1; return server.fetch(...args); },
  }, "Local", "device-a");
  harness.auth.getUser = () => ({ accountId: "account-b" });
  await harness.sync.load();
  await harness.sync.resetAccountLink("local");
  harness.auth.getUser = () => ({ accountId: "account-a" });
  await assert.rejects(() => harness.sync.pull({ interactive: false }), ServerSyncAccountMismatchError);
  assert.equal(requests, 3);
});

test("deleting Drive data pauses automatic re-upload", async () => {
  const server = createServer();
  const harness = createHarness(server, "Keep local", "device-a");
  await harness.sync.syncNow({ interactive: false });
  await harness.sync.deleteRemoteData();
  const before = server.states.size;
  const result = await harness.sync.syncNow({ interactive: false });
  assert.deepEqual(result, { skipped: true, reason: "sync_paused_after_delete" });
  assert.equal(server.states.size, before);
  assert.equal(harness.sync.getStatus().syncPaused, true);
});

test("syncNow pulls without uploading when the local document is unchanged", async () => {
  const server = createServer();
  let gets = 0;
  let puts = 0;
  const harness = createHarness({
    fetch: async (path, options = {}) => {
      if (options.method === "PUT") puts += 1;
      else gets += 1;
      return server.fetch(path, options);
    },
  }, "Local", "device-a");

  await harness.sync.syncNow({ interactive: false });
  gets = 0;
  puts = 0;
  await harness.sync.syncNow({ interactive: false });

  assert.equal(gets, 1);
  assert.equal(puts, 0);
});

test("realtime status reflects WebSocket open and close", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closeCalls = [];
      sockets.push(this);
    }
    send(message) { this.sent.push(message); }
    close(...args) { this.closeCalls.push(args); }
  }

  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:", host: "taskliner.app" },
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
    const harness = createHarness(createServer(), "Local", "device-a");
    const states = [];
    let changes = 0;

    assert.equal(harness.sync.connectRealtime({
      onChange: () => { changes += 1; },
      onStatus: ({ state }) => states.push(state),
    }), true);
    assert.equal(harness.sync.getStatus().realtimeState, "connecting");
    assert.equal(sockets[0].url, "wss://taskliner.app/api/realtime");

    sockets[0].onopen();
    assert.equal(harness.sync.getStatus().realtimeConnected, true);
    sockets[0].onmessage({ data: JSON.stringify({ type: "changed" }) });
    await Promise.resolve();
    assert.equal(changes, 1);

    sockets[0].onclose({ code: 1006, reason: "lost" });
    assert.equal(harness.sync.getStatus().realtimeConnected, false);
    assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else delete globalThis.location;
    if (webSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", webSocketDescriptor);
    else delete globalThis.WebSocket;
  }
});

test("realtime heartbeat detects a silent WebSocket", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const sockets = [];
  const timers = new Map();
  let nextTimerId = 0;
  const setTimeoutFn = (fn, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { fn, delay });
    return id;
  };
  const clearTimeoutFn = (id) => timers.delete(id);
  const runTimer = async (id) => {
    const timer = timers.get(id);
    assert.ok(timer);
    timers.delete(id);
    await timer.fn();
  };
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closeCalls = [];
      sockets.push(this);
    }
    send(message) { this.sent.push(message); }
    close(...args) { this.closeCalls.push(args); }
  }

  try {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:", host: "taskliner.app" },
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
    const harness = createHarness(createServer(), "Local", "device-a", {
      setTimeoutFn,
      clearTimeoutFn,
      realtimeHeartbeatMs: REALTIME_HEARTBEAT_MS,
      realtimePongTimeoutMs: REALTIME_PONG_TIMEOUT_MS,
    });
    const states = [];
    assert.equal(harness.sync.connectRealtime({ onStatus: ({ state }) => states.push(state) }), true);
    sockets[0].onopen();

    const heartbeatTimer = [...timers.entries()].find(([, timer]) => timer.delay === REALTIME_HEARTBEAT_MS)?.[0];
    assert.ok(heartbeatTimer);
    await runTimer(heartbeatTimer);
    assert.deepEqual(sockets[0].sent, ["ping"]);

    const pongTimer = [...timers.entries()].find(([, timer]) => timer.delay === REALTIME_PONG_TIMEOUT_MS)?.[0];
    assert.ok(pongTimer);
    sockets[0].onmessage({ data: "pong" });
    assert.equal(timers.has(pongTimer), false);

    const nextHeartbeatTimer = [...timers.entries()].find(([, timer]) => timer.delay === REALTIME_HEARTBEAT_MS)?.[0];
    await runTimer(nextHeartbeatTimer);
    const timeoutTimer = [...timers.entries()].find(([, timer]) => timer.delay === REALTIME_PONG_TIMEOUT_MS)?.[0];
    await runTimer(timeoutTimer);
    assert.equal(harness.sync.getStatus().realtimeConnected, false);
    assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
    assert.equal(sockets[0].closeCalls.length, 1);
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else delete globalThis.location;
    if (webSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", webSocketDescriptor);
    else delete globalThis.WebSocket;
  }
});
