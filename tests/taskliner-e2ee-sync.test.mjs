import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkspaceDataKey } from "../src/crypto/device-envelope-v3.mjs";
import { base64urlEncode, canonicalJsonBytes, deriveHkdfAesKey, randomBytes, utf8, webCrypto } from "../src/crypto/e2ee-utils.mjs";
import { MIGRATION_BUNDLE_FORMAT, MIGRATION_BUNDLE_VERSION, migrationBundleAad } from "../src/crypto/migration-bundle-v1.mjs";
import { encryptSharedSetting } from "../src/crypto/shared-setting-envelope-v1.mjs";
import {
  createTasklinerE2eeSync,
  E2eeSyncLockedError,
  REALTIME_HEARTBEAT_MS,
  REALTIME_PONG_TIMEOUT_MS,
} from "../src/google/taskliner-e2ee-sync.mjs";
import { createDeviceState } from "../src/sync/device-state.mjs";

function doc(title) {
  return {
    schemaVersion: 3,
    rootIds: ["root"],
    selectedId: null,
    nodes: {
      root: {
        id: "root",
        title,
        note: "",
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: 1,
        completedAt: null,
        dueAt: null,
      },
    },
    ui: { theme: "easygoing", tab: "active" },
  };
}

function memoryStorage(deviceId, initial = {}) {
  let metadata = { version: 3, deviceId, ...initial };
  let secret = null;
  return {
    async readSyncMetadata() { return structuredClone(metadata); },
    async writeSyncMetadata(value) { metadata = structuredClone(value); },
    async readSyncSecret() { return secret; },
    async writeSyncSecret(value) { secret = value; },
    async clearSyncSecret() { secret = null; },
  };
}

async function legacyBundle(states, fingerprint, clientPublicKey) {
  const clientKey = await webCrypto().subtle.importKey(
    "jwk",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const server = await webCrypto().subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = new Uint8Array(await webCrypto().subtle.deriveBits({ name: "ECDH", public: clientKey }, server.privateKey, 256));
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await deriveHkdfAesKey(shared, { salt, info: utf8("taskliner-v2-migration-v1") });
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: migrationBundleAad(fingerprint) },
    key,
    canonicalJsonBytes({ states }),
  );
  const publicJwk = await webCrypto().subtle.exportKey("jwk", server.publicKey);
  return {
    format: MIGRATION_BUNDLE_FORMAT,
    version: MIGRATION_BUNDLE_VERSION,
    fingerprint,
    serverPublicKey: { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y, ext: true, key_ops: [] },
    salt: base64urlEncode(salt),
    nonce: base64urlEncode(nonce),
    ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
  };
}

function fakeApi({ workspaceId, keyId }) {
  const stores = new Map();
  const store = (kind) => {
    if (!stores.has(kind)) stores.set(kind, new Map());
    return stores.get(kind);
  };
  const response = (kind, artifactId = null) => ({
    accountId: "account-1",
    e2ee: { status: "encrypted-active", workspaceId, keyId },
    artifacts: [...store(kind).entries()]
      .filter(([id]) => artifactId == null || id === artifactId)
      .map(([id, payload]) => ({ artifactId: id, kind, payload })),
    fingerprint: `${kind}-${store(kind).size}`,
  });
  return {
    async status() { return response("device-envelope"); },
    async list(kind) { return response(kind); },
    async get(kind, artifactId) { return response(kind, artifactId); },
    async put(kind, artifactId, payload) { store(kind).set(artifactId, structuredClone(payload)); return response(kind, artifactId); },
    async delete(kind, artifactId) { store(kind).delete(artifactId); return { deleted: true }; },
  };
}

function auth() {
  return {
    hasToken: () => true,
    getUser: () => ({ accountId: "account-1" }),
    async logout() {},
  };
}

test("encrypted realtime heartbeat detects a silent WebSocket", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const timers = new Map();
  const sockets = [];
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
    const sync = createTasklinerE2eeSync({
      auth: auth(),
      storage: memoryStorage("device-a"),
      api: fakeApi({ workspaceId: "workspace-1", keyId: "key-1" }),
      getDocument: async () => doc("Local"),
      setTimeoutFn,
      clearTimeoutFn,
    });
    const states = [];
    assert.equal(sync.connectRealtime({ onStatus: ({ state }) => states.push(state) }), true);
    sockets[0].onopen();
    const heartbeatTimer = [...timers.entries()].find(([, timer]) => timer.delay === REALTIME_HEARTBEAT_MS)?.[0];
    await runTimer(heartbeatTimer);
    assert.deepEqual(sockets[0].sent, ["ping"]);
    const timeoutTimer = [...timers.entries()].find(([, timer]) => timer.delay === REALTIME_PONG_TIMEOUT_MS)?.[0];
    await runTimer(timeoutTimer);
    assert.equal(sync.getStatus().realtimeState, "disconnected");
    assert.deepEqual(states, ["connecting", "connected", "disconnected"]);
    assert.equal(sockets[0].closeCalls.length, 1);
    sync.disconnectRealtime();
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else delete globalThis.location;
    if (webSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", webSocketDescriptor);
    else delete globalThis.WebSocket;
  }
});

test("refreshStatus keeps active migration lock metadata without creating a key", async () => {
  const sync = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("current-device"),
    api: {
      async status() {
        return {
          accountId: "account-1",
          e2ee: {
            status: "migrating",
            workspaceId: "workspace-1",
            keyId: "key-1",
            lockExpiresAt: "2026-07-17T00:10:00.000Z",
          },
          legacy: { fingerprint: "legacy-fingerprint", count: 1 },
          fingerprint: "empty",
        };
      },
    },
    getDocument: async () => doc("Local"),
  });

  await sync.load();
  await sync.refreshStatus();
  assert.equal(sync.getStatus().e2eeStatus, "migrating");
  assert.equal(sync.getStatus().workspaceId, "workspace-1");
  assert.equal(sync.getStatus().keyId, "key-1");
  assert.equal(sync.getStatus().legacyCount, 1);
  assert.equal(sync.getStatus().migrationLockExpiresAt, "2026-07-17T00:10:00.000Z");
  assert.equal(sync.getWorkspaceKey(), null);
});

test("encrypted sync stores envelopes and merges them in the browser", async () => {
  const workspaceId = "workspace-1";
  const keyId = "key-1";
  const wdk = generateWorkspaceDataKey();
  const api = fakeApi({ workspaceId, keyId });
  let firstDoc = doc("First device");
  const first = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-a"),
    api,
    getDocument: async () => firstDoc,
    applyDocument: async (value) => { firstDoc = value; },
  });
  await first.persistWorkspaceKey(wdk, { workspaceId, keyId });
  first.noteLocalChange();
  await first.push({ allowEmptyRemote: true });

  let secondDoc = doc("Second device");
  const second = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-b"),
    api,
    getDocument: async () => secondDoc,
    applyDocument: async (value) => { secondDoc = value; },
  });
  await second.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await second.pull();
  assert.equal(secondDoc.nodes.root.title, "First device");

  secondDoc.nodes.root.title = "Changed on B";
  second.noteLocalChange();
  await second.push();
  await first.pull();
  assert.equal(firstDoc.nodes.root.title, "Changed on B");
});

test("encrypted push does not apply a stale response over an edit made during the request", async () => {
  const workspaceId = "workspace-1";
  const keyId = "key-1";
  const api = fakeApi({ workspaceId, keyId });
  const wdk = generateWorkspaceDataKey();
  let localDoc = doc("Initial");
  let blockPut = false;
  let releasePut;
  let putStarted;
  const putGate = new Promise((resolve) => { releasePut = resolve; });
  const putStartedGate = new Promise((resolve) => { putStarted = resolve; });
  const originalPut = api.put.bind(api);
  api.put = async (kind, artifactId, payload) => {
    if (blockPut && kind === "device-envelope") {
      putStarted();
      await putGate;
    }
    return originalPut(kind, artifactId, payload);
  };
  const sync = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-a"),
    api,
    getDocument: async () => localDoc,
    applyDocument: async (value) => { localDoc = value; },
  });
  await sync.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await sync.push({ allowEmptyRemote: true });

  blockPut = true;
  localDoc.nodes.root.title = "First edit";
  sync.noteLocalChange();
  const pushPromise = sync.push();
  await putStartedGate;
  localDoc.nodes.root.title = "Latest edit";
  sync.noteLocalChange();
  releasePut();

  const result = await pushPromise;
  assert.equal(result.skipped, true);
  assert.equal(localDoc.nodes.root.title, "Latest edit");
  assert.equal(sync.getStatus().localDirty, true);
});

test("encrypted pull does not apply a stale response over an edit made during the request", async () => {
  const workspaceId = "workspace-1";
  const keyId = "key-1";
  const wdk = generateWorkspaceDataKey();
  const api = fakeApi({ workspaceId, keyId });
  let localDoc = doc("Local");
  let remoteDoc = doc("Remote");
  let blockList = false;
  let releaseList;
  let listStarted;
  const listGate = new Promise((resolve) => { releaseList = resolve; });
  const listStartedGate = new Promise((resolve) => { listStarted = resolve; });
  const originalList = api.list.bind(api);
  api.list = async (kind) => {
    if (blockList && kind === "device-envelope") {
      listStarted();
      await listGate;
    }
    return originalList(kind);
  };

  const remote = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-b"),
    api,
    getDocument: async () => remoteDoc,
    applyDocument: async (value) => { remoteDoc = value; },
  });
  await remote.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await remote.push({ allowEmptyRemote: true });

  const local = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-a"),
    api,
    getDocument: async () => localDoc,
    applyDocument: async (value) => { localDoc = value; },
  });
  await local.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await local.pull();
  assert.equal(localDoc.nodes.root.title, "Remote");

  blockList = true;
  const pullPromise = local.pull();
  await listStartedGate;
  localDoc.nodes.root.title = "Typed while checking";
  local.noteLocalChange();
  releaseList();

  const result = await pullPromise;
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "local_changes_during_sync");
  assert.equal(localDoc.nodes.root.title, "Typed while checking");
  assert.equal(local.getStatus().localDirty, true);
});

test("a new device cannot pull encrypted state before it has a workspace key", async () => {
  const sync = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-new"),
    api: fakeApi({ workspaceId: "workspace-1", keyId: "key-1" }),
    getDocument: async () => doc("Local"),
  });
  await assert.rejects(() => sync.pull(), E2eeSyncLockedError);
  assert.equal(sync.getStatus().lastError, null, "device verification is an expected setup state, not a sync failure");
});

test("Discord shared settings and tombstones are encrypted while the outbox stays outside sync", async () => {
  const workspaceId = "workspace-1";
  const keyId = "key-1";
  const wdk = generateWorkspaceDataKey();
  const api = fakeApi({ workspaceId, keyId });
  const first = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-a"),
    api,
    getDocument: async () => doc("First"),
  });
  await first.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await first.pull();
  const settings = {
    enabled: true,
    webhookUrl: "https://discord.com/api/webhooks/1/token",
    visibility: "hidden",
    automaticPost: true,
    displayName: "Taskliner",
  };
  await first.pushSharedSetting(settings);

  const received = [];
  const second = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-b"),
    api,
    getDocument: async () => doc("Second"),
    validateSharedSetting: (value) => typeof value?.webhookUrl === "string",
    applySharedSetting: async (value) => { received.push(value); },
  });
  await second.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await second.pull();
  assert.deepEqual(received, [settings]);

  await first.pushSharedSetting(null);
  await second.pull();
  assert.deepEqual(received, [settings, null]);
});

test("concurrent Discord setting artifacts converge by Lamport stamp and device ID", async () => {
  const workspaceId = "workspace-1";
  const keyId = "key-1";
  const wdk = generateWorkspaceDataKey();
  const api = fakeApi({ workspaceId, keyId });
  const values = [
    ["device-a", "A"],
    ["device-b", "B"],
  ];
  for (const [deviceId, displayName] of values) {
    const settingId = `integrations.discord.${deviceId}`;
    const payload = {
      settingId,
      logicalId: "integrations.discord",
      stamp: { counter: 5, deviceId },
      value: { enabled: false, webhookUrl: "", visibility: "hidden", automaticPost: false, displayName },
    };
    await api.put("shared-setting", settingId, await encryptSharedSetting(payload, { workspaceId, keyId, settingId, wdk }));
  }
  const received = [];
  const sync = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("device-c"),
    api,
    getDocument: async () => doc("Local"),
    validateSharedSetting: () => true,
    applySharedSetting: async (value) => { received.push(value); },
  });
  await sync.persistWorkspaceKey(wdk, { workspaceId, keyId });
  await sync.pull();
  assert.equal(received[0].displayName, "B");
});

test("v2 cutover verifies encrypted v3 state before activation and can retry activation", async () => {
  const oldWorkspaceId = "taskliner-google-account-v1";
  const workspaceId = "workspace-v3";
  const keyId = "key-v3";
  const legacyState = createDeviceState({
    doc: doc("Legacy remote"),
    workspaceId: oldWorkspaceId,
    deviceId: "legacy-device",
    lamportCounter: 4,
  });
  const artifacts = new Map();
  let activateAttempts = 0;
  let activated = false;
  const api = {
    async status() {
      return {
        accountId: "account-1",
        e2ee: { status: activated ? "encrypted-active" : "legacy", workspaceId: activated ? workspaceId : null, keyId: activated ? keyId : null },
        legacy: { fingerprint: "legacy-fingerprint", count: activated ? 0 : 1 },
        fingerprint: "empty",
      };
    },
    async beginMigration({ migrationPublicKey }) {
      return {
        migration: {
          lockToken: "lock-token",
          legacyFingerprint: "legacy-fingerprint",
          legacyBundle: await legacyBundle([legacyState], "legacy-fingerprint", migrationPublicKey),
        },
      };
    },
    async put(kind, artifactId, payload) {
      artifacts.set(`${kind}:${artifactId}`, structuredClone(payload));
      return { fingerprint: `v3-${artifacts.size}` };
    },
    async list(kind) {
      return {
        artifacts: [...artifacts.entries()]
          .filter(([key]) => key.startsWith(`${kind}:`))
          .map(([key, payload]) => ({ kind, artifactId: key.slice(kind.length + 1), payload })),
        fingerprint: `v3-${artifacts.size}`,
      };
    },
    async activateMigration({ verifiedV3Fingerprint }) {
      activateAttempts += 1;
      assert.equal(verifiedV3Fingerprint, `v3-${artifacts.size}`);
      if (activateAttempts === 1) throw new Error("legacy delete failed");
      activated = true;
      return { e2ee: { status: "encrypted-active", workspaceId, keyId } };
    },
  };
  let localDoc = doc("Offline local change");
  const sync = createTasklinerE2eeSync({
    auth: auth(),
    storage: memoryStorage("current-device", { lastState: legacyState, lamportCounter: 4 }),
    api,
    getDocument: async () => localDoc,
    applyDocument: async (value) => { localDoc = value; },
  });
  await sync.persistWorkspaceKey(generateWorkspaceDataKey(), { workspaceId, keyId });
  await assert.rejects(() => sync.migrateLegacy(), /legacy delete failed/);
  assert.equal(activated, false);
  assert.equal(artifacts.has("device-envelope:legacy-device"), true);
  assert.equal(artifacts.has("device-envelope:current-device"), true);
  await sync.migrateLegacy();
  assert.equal(activated, true);
  assert.equal(localDoc.nodes.root.title, "Offline local change");
  assert.equal(sync.getStatus().e2eeStatus, "encrypted-active");
});
