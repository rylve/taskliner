import { createDeviceState } from "../sync/device-state.mjs";
import { mergeDeviceStates } from "../sync/merge.mjs";
import { projectMergedState } from "../sync/project.mjs";
import { createSyncContentSnapshot } from "../sync/content-snapshot.mjs";

export const SERVER_SYNC_WORKSPACE_ID = "taskliner-google-account-v1";
export const REALTIME_HEARTBEAT_MS = 300_000;
export const REALTIME_PONG_TIMEOUT_MS = 60_000;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizeMetadata(value) {
  const source = isRecord(value) ? value : {};
  return {
    version: 2,
    deviceId: typeof source.deviceId === "string" && source.deviceId ? source.deviceId : createId("device"),
    workspaceId: typeof source.workspaceId === "string" && source.workspaceId ? source.workspaceId : null,
    accountId: typeof source.accountId === "string" && source.accountId ? source.accountId : null,
    lamportCounter: Number.isInteger(source.lamportCounter) && source.lamportCounter >= 0 ? source.lamportCounter : 0,
    syncFileId: null,
    hasSynced: source.hasSynced === true,
    syncPaused: source.syncPaused === true,
    remoteMissing: source.remoteMissing === true,
    accountMismatch: source.accountMismatch === true,
    reauthorizeRequired: source.reauthorizeRequired === true,
    remoteFingerprint: typeof source.remoteFingerprint === "string" ? source.remoteFingerprint : null,
    lastSyncedAt: typeof source.lastSyncedAt === "string" ? source.lastSyncedAt : null,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    lastState: isRecord(source.lastState) ? source.lastState : null,
  };
}

function addDeletionTombstones(state, previousState, counter, deviceId, now) {
  const previousNodes = previousState?.nodes;
  if (!isRecord(previousNodes)) return state;
  const deletionStamp = { counter, deviceId };
  for (const [nodeId, previousNode] of Object.entries(previousNodes)) {
    if (state.nodes[nodeId] || !isRecord(previousNode)) continue;
    state.nodes[nodeId] = {
      ...cloneJson(previousNode),
      deletedAt: { value: new Date(now()).toISOString(), stamp: deletionStamp },
    };
    state.tombstones[nodeId] = state.nodes[nodeId].deletedAt;
  }
  return state;
}

export class ServerSyncAuthorizationRequiredError extends Error {
  constructor(message = "Google authorization is required") {
    super(message);
    this.name = "ServerSyncAuthorizationRequiredError";
    this.code = "sync_authorization_required";
  }
}

export class ServerSyncUnavailableError extends Error {
  constructor(message = "Taskliner sync server is unavailable") {
    super(message);
    this.name = "ServerSyncUnavailableError";
    this.code = "sync_server_unavailable";
  }
}

export class ServerSyncAccountMismatchError extends Error {
  constructor(message = "This device is connected to a different Google account") {
    super(message);
    this.name = "ServerSyncAccountMismatchError";
    this.code = "sync_account_mismatch";
  }
}

export function createTasklinerServerSync({
  auth,
  storage,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  getDocument,
  applyDocument = async () => undefined,
  now = () => Date.now(),
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  realtimeHeartbeatMs = REALTIME_HEARTBEAT_MS,
  realtimePongTimeoutMs = REALTIME_PONG_TIMEOUT_MS,
} = {}) {
  if (!auth || typeof auth.hasToken !== "function") throw new TypeError("auth is required");
  if (!storage || typeof storage.readSyncMetadata !== "function" || typeof storage.writeSyncMetadata !== "function") {
    throw new TypeError("storage sync metadata methods are required");
  }
  if (typeof getDocument !== "function") throw new TypeError("getDocument is required");

  let metadata = null;
  let loaded = false;
  let localDirty = false;
  let realtimeSocket = null;
  let realtimeState = "disconnected";
  let realtimeHeartbeatTimer = null;
  let realtimePongTimer = null;

  async function load() {
    if (loaded) return;
    metadata = normalizeMetadata(await storage.readSyncMetadata());
    await storage.writeSyncMetadata(cloneJson(metadata));
    loaded = true;
  }

  async function saveMetadata(patch = {}) {
    metadata = normalizeMetadata({ ...metadata, ...patch });
    await storage.writeSyncMetadata(cloneJson(metadata));
    return metadata;
  }

  async function ensureAuthorization(interactive = false) {
    if (auth.hasToken()) return true;
    if (!interactive) return false;
    await auth.connect();
    return true;
  }

  function currentAccountId() {
    return typeof auth.getUser === "function" && typeof auth.getUser()?.accountId === "string"
      ? auth.getUser().accountId
      : null;
  }

  function assertAccountMatch() {
    const current = currentAccountId();
    if (metadata?.accountId && current && metadata.accountId !== current) throw new ServerSyncAccountMismatchError();
    return current;
  }

  async function bindAccount(responseAccountId = null) {
    const current = currentAccountId();
    const next = current || (typeof responseAccountId === "string" && responseAccountId ? responseAccountId : null);
    if (metadata.accountId && next && metadata.accountId !== next) throw new ServerSyncAccountMismatchError();
    if (next && metadata.accountId !== next) await saveMetadata({ accountId: next });
    return next;
  }

  async function request(path, options = {}, interactive = false) {
    if (!(await ensureAuthorization(interactive))) throw new ServerSyncAuthorizationRequiredError();
    if (typeof fetchImpl !== "function") throw new ServerSyncUnavailableError();
    let response;
    try {
      response = await fetchImpl(path, {
        credentials: "include",
        cache: "no-store",
        ...options,
        headers: { Accept: "application/json", ...(options.headers || {}) },
      });
    } catch {
      throw new ServerSyncUnavailableError();
    }
    if (response.status === 304) return { notModified: true };
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (response.status === 401) {
      const error = new ServerSyncAuthorizationRequiredError(body?.message || undefined);
      error.requiresReauthorization = body?.code === "refresh_token_invalid";
      throw error;
    }
    if (!response.ok) throw new Error(body?.message || `Sync request failed: ${response.status}`);
    return body;
  }

  function mergedFromResponse(response) {
    const devices = Array.isArray(response?.devices) ? response.devices.map((entry) => entry?.state).filter(isRecord) : [];
    return isRecord(response?.mergedState) ? response.mergedState : mergeDeviceStates(devices);
  }

  async function applyRemote(response, { expectedSnapshot = null } = {}) {
    const merged = mergedFromResponse(response);
    const baseDoc = await getDocument();
    if (expectedSnapshot !== null && createSyncContentSnapshot(baseDoc) !== expectedSnapshot) {
      return {
        merged,
        projected: baseDoc,
        changed: false,
        skipped: true,
        reason: "local_changes_during_sync",
      };
    }
    if (!merged.workspaceId) return { merged, projected: baseDoc, changed: false };
    const projected = Object.keys(merged.nodes || {}).length
      ? projectMergedState(merged, { baseDoc, schemaVersion: Number.isInteger(baseDoc?.schemaVersion) ? baseDoc.schemaVersion : 3 })
      : baseDoc;
    if (!sameJson(projected, baseDoc)) {
      await applyDocument(projected, { expectedSnapshot });
      const afterApply = await getDocument();
      if (expectedSnapshot !== null && createSyncContentSnapshot(afterApply) !== createSyncContentSnapshot(projected)) {
        return {
          merged,
          projected: afterApply,
          changed: false,
          skipped: true,
          reason: "local_changes_during_sync",
        };
      }
    }
    return { merged, projected, changed: !sameJson(projected, baseDoc) };
  }

  async function pull(options = {}) {
    try {
      await load();
      if (!await ensureAuthorization(options.interactive === true)) throw new ServerSyncAuthorizationRequiredError();
      assertAccountMatch();
      if (metadata.syncPaused) return { skipped: true, reason: "sync_paused_after_delete" };
      if (localDirty) return { skipped: true, reason: "local_changes_pending" };
      const expectedSnapshot = createSyncContentSnapshot(await getDocument());
      const response = await request("/api/sync", {
        headers: metadata.remoteFingerprint ? { "If-None-Match": `"${metadata.remoteFingerprint}"` } : {},
      }, false);
      if (response.notModified) {
        await saveMetadata({ lastSyncedAt: new Date(now()).toISOString(), lastError: null });
        return { skipped: false, notModified: true, remote: metadata.hasSynced };
      }
      await bindAccount(response.accountId);
      const remoteDevices = Array.isArray(response.devices) ? response.devices : [];
      const hadRemote = metadata.hasSynced || !!metadata.lastState;
      if (!remoteDevices.length) {
        await saveMetadata({
          workspaceId: response.workspaceId || metadata.workspaceId || SERVER_SYNC_WORKSPACE_ID,
          remoteFingerprint: response.fingerprint || null,
        remoteMissing: hadRemote,
          accountMismatch: false,
          reauthorizeRequired: false,
          lastSyncedAt: new Date(now()).toISOString(),
          lastError: null,
        });
        return {
          skipped: false,
          remote: false,
          remoteMissing: hadRemote,
          merged: metadata.lastState || response.mergedState,
          projected: await getDocument(),
          changed: false,
        };
      }
      const applied = await applyRemote(response, { expectedSnapshot });
      await saveMetadata({
        workspaceId: response.workspaceId || metadata.workspaceId || SERVER_SYNC_WORKSPACE_ID,
        remoteFingerprint: response.fingerprint || null,
        remoteMissing: false,
        accountMismatch: false,
        reauthorizeRequired: false,
        hasSynced: true,
        lastSyncedAt: new Date(now()).toISOString(),
        lastError: null,
        lastState: applied.merged,
      });
      return { skipped: !!applied.skipped, remote: (response.devices || []).length > 0, ...applied };
    } catch (error) {
      await saveMetadata({
        lastError: error.message || "sync pull failed",
        accountMismatch: error.code === "sync_account_mismatch",
        reauthorizeRequired: error.requiresReauthorization === true,
      });
      throw error;
    }
  }

  async function push(options = {}) {
    if (globalThis.navigator?.locks?.request) {
      return globalThis.navigator.locks.request(`taskliner-sync:${metadata?.deviceId || "device"}`, async () => pushInternal(options));
    }
    return pushInternal(options);
  }

  async function pushInternal(options = {}) {
    try {
      await load();
      if (!await ensureAuthorization(options.interactive === true)) throw new ServerSyncAuthorizationRequiredError();
      assertAccountMatch();
      if (metadata.syncPaused) return { skipped: true, reason: "sync_paused_after_delete" };
      const remote = await request("/api/sync", {}, false);
      if (remote.notModified) return { skipped: false, notModified: true, remote: metadata.hasSynced };
      await bindAccount(remote.accountId);
      if (metadata.hasSynced && !(remote.devices || []).length && options.allowEmptyRemote !== true) {
        await saveMetadata({ remoteMissing: true, remoteFingerprint: remote.fingerprint || null, lastError: null });
        return { skipped: true, reason: "remote_data_missing", remoteMissing: true };
      }
      const workspaceId = remote.workspaceId || metadata.workspaceId || SERVER_SYNC_WORKSPACE_ID;
      const counter = Math.max(metadata.lamportCounter, Number(remote.mergedState?.lamportCounter) || 0) + 1;
      const localDoc = await getDocument();
      const submittedSnapshot = createSyncContentSnapshot(localDoc);
      let state = createDeviceState({
        doc: localDoc,
        workspaceId,
        deviceId: metadata.deviceId,
        lamportCounter: counter,
        generatedAt: new Date(now()).toISOString(),
        previousState: metadata.lastState,
      });
      state = addDeletionTombstones(state, metadata.lastState, counter, metadata.deviceId, now);
      const response = await request("/api/sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      }, false);
      const applied = await applyRemote(response, { expectedSnapshot: submittedSnapshot });
      const currentSnapshot = createSyncContentSnapshot(await getDocument());
      const projectedSnapshot = createSyncContentSnapshot(applied.projected);
      const localChangesPending = applied.skipped === true || currentSnapshot !== projectedSnapshot;
      if (!localChangesPending) localDirty = false;
      await saveMetadata({
        workspaceId: response.workspaceId || workspaceId,
        remoteFingerprint: response.fingerprint || null,
        remoteMissing: false,
        accountMismatch: false,
        reauthorizeRequired: false,
        lamportCounter: Math.max(counter, Number(applied.merged.lamportCounter) || 0),
        hasSynced: true,
        lastSyncedAt: new Date(now()).toISOString(),
        lastError: null,
        lastState: applied.merged,
      });
      return { skipped: localChangesPending, remote: (response.devices || []).length > 0, ...applied };
    } catch (error) {
      await saveMetadata({
        lastError: error.message || "sync push failed",
        accountMismatch: error.code === "sync_account_mismatch",
        reauthorizeRequired: error.requiresReauthorization === true,
      });
      throw error;
    }
  }

  async function syncNow({ interactive = true } = {}) {
    await load();
    if (!(await ensureAuthorization(interactive))) throw new ServerSyncAuthorizationRequiredError();
    assertAccountMatch();
    if (metadata.syncPaused) return { skipped: true, reason: "sync_paused_after_delete" };
    if (!metadata.hasSynced) {
      const pulled = await pull({ interactive: false });
      if (pulled.remote) return pulled;
      return push({ interactive: false, allowEmptyRemote: true });
    }
    return localDirty ? push({ interactive: false }) : pull({ interactive: false });
  }

  async function resumeSync() {
    await load();
    if (!(await ensureAuthorization(false))) throw new ServerSyncAuthorizationRequiredError();
    assertAccountMatch();
    await saveMetadata({ syncPaused: false, remoteMissing: false, hasSynced: false, lastState: null, lastError: null });
    localDirty = true;
    return push({ interactive: false, allowEmptyRemote: true });
  }

  async function resetAccountLink(strategy = "remote") {
    await load();
    if (!(await ensureAuthorization(false))) throw new ServerSyncAuthorizationRequiredError();
    const accountId = currentAccountId();
    await saveMetadata({
      accountId,
      workspaceId: null,
      hasSynced: false,
      syncPaused: false,
      remoteMissing: false,
      remoteFingerprint: null,
      lastSyncedAt: null,
      lastState: null,
      lastError: null,
    });
    if (strategy === "local") await request("/api/sync", { method: "DELETE" }, false);
    localDirty = strategy === "local";
    return strategy === "local" ? push({ interactive: false, allowEmptyRemote: true }) : pull({ interactive: false });
  }

  async function disconnect() {
    await load();
    disconnectRealtime();
    localDirty = false;
    await auth.logout();
    await storage.clearSyncSecret?.();
    metadata = normalizeMetadata({ deviceId: metadata.deviceId, syncPaused: false });
    await storage.writeSyncMetadata(cloneJson(metadata));
  }

  async function revokeAccount() {
    await load();
    disconnectRealtime();
    if (typeof auth.revoke === "function") await auth.revoke();
    else await auth.logout();
    localDirty = false;
    await storage.clearSyncSecret?.();
    metadata = normalizeMetadata({ deviceId: metadata.deviceId });
    await storage.writeSyncMetadata(cloneJson(metadata));
  }

  async function deleteRemoteData() {
    await load();
    await request("/api/sync", { method: "DELETE" }, false);
    localDirty = false;
    await saveMetadata({
      workspaceId: null,
      hasSynced: false,
      syncPaused: true,
      remoteMissing: false,
      remoteFingerprint: null,
      lastSyncedAt: null,
      lastError: null,
      lastState: null,
    });
  }

  function disconnectRealtime() {
    const socket = realtimeSocket;
    realtimeSocket = null;
    realtimeState = "disconnected";
    if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
    if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
    realtimeHeartbeatTimer = null;
    realtimePongTimer = null;
    if (socket) socket.close();
  }

  function connectRealtime({
    onChange = async () => undefined,
    onStatus = () => undefined,
  } = {}) {
    if (realtimeSocket) return true;
    if (!auth.hasToken() || typeof globalThis.WebSocket !== "function") return false;
    const location = globalThis.location;
    if (!location?.host || !/^https?:$/.test(location.protocol || "")) return false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const reportStatus = (state, details = {}) => {
      realtimeState = state;
      try { onStatus({ state, ...details }); } catch { /* status reporting must not break sync */ }
    };
    try {
      const socket = new globalThis.WebSocket(`${protocol}//${location.host}/api/realtime`);
      realtimeSocket = socket;
      reportStatus("connecting");
      socket.onopen = () => {
        if (realtimeSocket !== socket) return;
        reportStatus("connected");
        const heartbeat = () => {
          if (realtimeSocket !== socket) return;
          try {
            socket.send("ping");
          } catch {
            realtimeSocket = null;
            if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
            if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
            realtimeHeartbeatTimer = null;
            realtimePongTimer = null;
            reportStatus("error");
            try { socket.close(); } catch { /* already closed */ }
            return;
          }
          realtimePongTimer = setTimeoutFn(() => {
            if (realtimeSocket !== socket) return;
            if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
            if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
            realtimeSocket = null;
            realtimeHeartbeatTimer = null;
            realtimePongTimer = null;
            reportStatus("disconnected", { reason: "heartbeat_timeout" });
            try { socket.close(4000, "heartbeat timeout"); } catch { /* already closed */ }
          }, realtimePongTimeoutMs);
          realtimeHeartbeatTimer = setTimeoutFn(heartbeat, realtimeHeartbeatMs);
        };
        realtimeHeartbeatTimer = setTimeoutFn(heartbeat, realtimeHeartbeatMs);
      };
      socket.onmessage = (event) => {
        if (event?.data === "pong") {
          if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
          realtimePongTimer = null;
          return;
        }
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message?.type === "changed") Promise.resolve(onChange(message)).catch(() => undefined);
      };
      socket.onclose = (event) => {
        if (realtimeSocket !== socket) return;
        realtimeSocket = null;
        if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
        if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
        realtimeHeartbeatTimer = null;
        realtimePongTimer = null;
        reportStatus("disconnected", { code: event?.code || 0, reason: event?.reason || "" });
      };
      socket.onerror = () => {
        if (realtimeSocket !== socket) return;
        realtimeSocket = null;
        if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
        if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
        realtimeHeartbeatTimer = null;
        realtimePongTimer = null;
        reportStatus("error");
        socket.close();
      };
      return true;
    } catch (error) {
      realtimeSocket = null;
      reportStatus("disconnected", { error });
      return false;
    }
  }

  return {
    load,
    pull,
    push,
    syncNow,
    resumeSync,
    resetAccountLink,
    disconnect,
    revokeAccount,
    connectRealtime,
    disconnectRealtime,
    deleteRemoteData,
    noteLocalChange() {
      localDirty = true;
    },
    getStatus() {
      return {
        authorized: auth.hasToken(),
        hasPassphrase: false,
        workspaceId: metadata?.workspaceId || null,
        hasSynced: !!metadata?.hasSynced,
        localDirty,
        syncPaused: !!metadata?.syncPaused,
        remoteMissing: !!metadata?.remoteMissing,
        accountMismatch: !!metadata?.accountMismatch,
        reauthorizeRequired: !!metadata?.reauthorizeRequired,
        realtimeConnected: realtimeState === "connected",
        realtimeState,
        accountId: metadata?.accountId || null,
        lastSyncedAt: metadata?.lastSyncedAt || null,
        lastError: metadata?.lastError || null,
      };
    },
  };
}
