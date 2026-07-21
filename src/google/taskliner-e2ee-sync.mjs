import { createDeviceState, validateDeviceState } from "../sync/device-state.mjs";
import { mergeDeviceStates } from "../sync/merge.mjs";
import { projectMergedState } from "../sync/project.mjs";
import { createSyncContentSnapshot } from "../sync/content-snapshot.mjs";
import {
  decryptDeviceState,
  encryptDeviceState,
  generateWorkspaceDataKey,
} from "../crypto/device-envelope-v3.mjs";
import {
  createDeviceStorageKeyWrapper,
  generateDeviceStorageKey,
  unwrapDeviceStorageKeyWrapper,
  unwrapPasskeyKeyWrapper,
  unwrapRecoveryKeyWrapper,
} from "../crypto/key-wrappers-v1.mjs";
import { createSyncV3Api } from "./sync-v3-api.mjs";
import {
  decryptLegacyMigrationBundle,
  generateMigrationClientKeyPair,
} from "../crypto/migration-bundle-v1.mjs";
import { decryptSharedSetting, encryptSharedSetting } from "../crypto/shared-setting-envelope-v1.mjs";

const LOCAL_KEY_FORMAT = "taskliner-local-key-wrapper";
const LOCAL_KEY_VERSION = 1;
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
  try {
    return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function normalizeMetadata(value) {
  const source = isRecord(value) ? value : {};
  return {
    version: 3,
    deviceId: typeof source.deviceId === "string" && source.deviceId ? source.deviceId : createId("device"),
    deviceName: typeof source.deviceName === "string" && source.deviceName ? source.deviceName : "Taskliner device",
    workspaceId: typeof source.workspaceId === "string" && source.workspaceId ? source.workspaceId : null,
    keyId: typeof source.keyId === "string" && source.keyId ? source.keyId : null,
    accountId: typeof source.accountId === "string" && source.accountId ? source.accountId : null,
    lamportCounter: Number.isInteger(source.lamportCounter) && source.lamportCounter >= 0 ? source.lamportCounter : 0,
    hasSynced: source.hasSynced === true,
    localDirty: source.localDirty === true,
    syncPaused: source.syncPaused === true,
    remoteMissing: source.remoteMissing === true,
    accountMismatch: source.accountMismatch === true,
    reauthorizeRequired: source.reauthorizeRequired === true,
    remoteFingerprint: typeof source.remoteFingerprint === "string" ? source.remoteFingerprint : null,
    lastSyncedAt: typeof source.lastSyncedAt === "string" ? source.lastSyncedAt : null,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    lastState: isRecord(source.lastState) ? source.lastState : null,
    e2eeStatus: typeof source.e2eeStatus === "string" ? source.e2eeStatus : "unknown",
    migrationLockExpiresAt: typeof source.migrationLockExpiresAt === "string" ? source.migrationLockExpiresAt : null,
    legacyCount: Number.isInteger(source.legacyCount) && source.legacyCount >= 0 ? source.legacyCount : 0,
    legacyFingerprint: typeof source.legacyFingerprint === "string" ? source.legacyFingerprint : null,
    migration: isRecord(source.migration) ? cloneJson(source.migration) : null,
    sharedSettingStamp: isRecord(source.sharedSettingStamp) ? cloneJson(source.sharedSettingStamp) : null,
    pendingKeyWrappers: Array.isArray(source.pendingKeyWrappers) ? cloneJson(source.pendingKeyWrappers) : [],
  };
}

function artifactPayloads(response) {
  return (Array.isArray(response?.artifacts) ? response.artifacts : [])
    .map((artifact) => artifact?.payload)
    .filter(isRecord);
}

function addDeletionTombstones(state, previousState, counter, deviceId, now) {
  if (!isRecord(previousState?.nodes)) return state;
  const stamp = { counter, deviceId };
  for (const [nodeId, previousNode] of Object.entries(previousState.nodes)) {
    if (state.nodes[nodeId] || !isRecord(previousNode)) continue;
    state.nodes[nodeId] = {
      ...cloneJson(previousNode),
      deletedAt: { value: new Date(now()).toISOString(), stamp },
    };
    state.tombstones[nodeId] = state.nodes[nodeId].deletedAt;
  }
  return state;
}

function validateDecryptedState(state, expected) {
  const validation = validateDeviceState(state);
  if (!validation.ok) return false;
  return state.workspaceId === expected.workspaceId && state.deviceId === expected.deviceId;
}

export class E2eeSyncLockedError extends Error {
  constructor(message = "This device needs a passkey, device approval, or recovery file") {
    super(message);
    this.name = "E2eeSyncLockedError";
    this.code = "e2ee_locked";
  }
}

export class E2eeSetupRequiredError extends Error {
  constructor(message = "End-to-end encrypted sync must be set up before syncing") {
    super(message);
    this.name = "E2eeSetupRequiredError";
    this.code = "e2ee_setup_required";
  }
}

export class E2eeMigrationLockedError extends Error {
  constructor(message = "Encrypted sync setup is already in progress. Try again in a few minutes.") {
    super(message);
    this.name = "E2eeMigrationLockedError";
    this.code = "migration_locked";
  }
}

export class E2eeAccountMismatchError extends Error {
  constructor(message = "This device is connected to a different Google account") {
    super(message);
    this.name = "E2eeAccountMismatchError";
    this.code = "sync_account_mismatch";
  }
}

export function createTasklinerE2eeSync({
  auth,
  storage,
  api = createSyncV3Api(),
  getDocument,
  applyDocument = async () => undefined,
  applySharedSetting = async () => undefined,
  validateSharedSetting = () => true,
  now = () => Date.now(),
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  realtimeHeartbeatMs = REALTIME_HEARTBEAT_MS,
  realtimePongTimeoutMs = REALTIME_PONG_TIMEOUT_MS,
  lockManager = globalThis.navigator?.locks,
} = {}) {
  if (!auth || typeof auth.hasToken !== "function") throw new TypeError("auth is required");
  if (!storage || typeof storage.readSyncMetadata !== "function" || typeof storage.readSyncSecret !== "function") {
    throw new TypeError("storage sync methods are required");
  }
  if (typeof getDocument !== "function") throw new TypeError("getDocument is required");

  let metadata = null;
  let localSecret = null;
  let wdk = null;
  let loaded = false;
  let localDirty = false;
  let realtimeSocket = null;
  let realtimeState = "disconnected";
  let realtimeHeartbeatTimer = null;
  let realtimePongTimer = null;

  async function saveMetadata(patch = {}) {
    metadata = normalizeMetadata({ ...metadata, ...patch });
    await storage.writeSyncMetadata(cloneJson(metadata));
    return metadata;
  }

  function currentAccountId() {
    return typeof auth.getUser === "function" && typeof auth.getUser()?.accountId === "string"
      ? auth.getUser().accountId
      : null;
  }

  function assertAccountMatch() {
    const current = currentAccountId();
    if (metadata?.accountId && current && metadata.accountId !== current) throw new E2eeAccountMismatchError();
    return current;
  }

  async function bindAccount(responseAccountId = null) {
    const next = currentAccountId() || (typeof responseAccountId === "string" ? responseAccountId : null);
    if (metadata.accountId && next && metadata.accountId !== next) throw new E2eeAccountMismatchError();
    if (next && metadata.accountId !== next) await saveMetadata({ accountId: next });
  }

  async function restoreLocalKey() {
    if (!isRecord(localSecret) || localSecret.format !== LOCAL_KEY_FORMAT || localSecret.version !== LOCAL_KEY_VERSION) return false;
    if (!localSecret.deviceStorageKey || !isRecord(localSecret.localWrapper)) return false;
    try {
      const restored = await unwrapDeviceStorageKeyWrapper(localSecret.localWrapper, localSecret.deviceStorageKey, {
        expectedWorkspaceId: localSecret.workspaceId,
        expectedKeyId: localSecret.keyId,
      });
      wdk = restored;
      await saveMetadata({ workspaceId: localSecret.workspaceId, keyId: localSecret.keyId });
      return true;
    } catch {
      wdk = null;
      return false;
    }
  }

  async function load() {
    if (loaded) return;
    metadata = normalizeMetadata(await storage.readSyncMetadata());
    localSecret = await storage.readSyncSecret();
    await restoreLocalKey();
    localDirty = metadata.localDirty;
    if (metadata.lastState) {
      try {
        const currentDoc = await getDocument();
        const lastProjected = projectMergedState(metadata.lastState, { baseDoc: currentDoc });
        localDirty ||= createSyncContentSnapshot(currentDoc) !== createSyncContentSnapshot(lastProjected);
      } catch {
        // A malformed prior snapshot must never clear an explicitly persisted dirty marker.
      }
    }
    metadata.localDirty = localDirty;
    await storage.writeSyncMetadata(cloneJson(metadata));
    loaded = true;
  }

  async function refreshLocalDirty() {
    const persisted = normalizeMetadata(await storage.readSyncMetadata());
    if (persisted.localDirty) localDirty = true;
    if (!localDirty && metadata.lastState) {
      try {
        const currentDoc = await getDocument();
        const lastProjected = projectMergedState(metadata.lastState, { baseDoc: currentDoc });
        localDirty = createSyncContentSnapshot(currentDoc) !== createSyncContentSnapshot(lastProjected);
      } catch {
        // Keep the current marker when the comparison cannot be completed safely.
      }
    }
    if (localDirty && !metadata.localDirty) await saveMetadata({ localDirty: true });
    return localDirty;
  }

  async function requireAuthorization(interactive = false) {
    if (auth.hasToken()) return;
    if (interactive && typeof auth.connect === "function") await auth.connect();
    if (!auth.hasToken()) {
      const error = new Error("Google authorization is required");
      error.code = "sync_authorization_required";
      throw error;
    }
  }

  async function persistWorkspaceKey(nextWdk, { workspaceId, keyId } = {}) {
    await load();
    if (!(nextWdk instanceof Uint8Array) || nextWdk.length !== 32) throw new TypeError("WDK must be 32 bytes");
    const deviceStorageKey = await generateDeviceStorageKey();
    const wrapperId = `local-${metadata.deviceId}`;
    const localWrapper = await createDeviceStorageKeyWrapper({
      workspaceId,
      keyId,
      wrapperId,
      deviceId: metadata.deviceId,
      wdk: nextWdk,
      deviceStorageKey,
    });
    localSecret = {
      format: LOCAL_KEY_FORMAT,
      version: LOCAL_KEY_VERSION,
      workspaceId,
      keyId,
      deviceStorageKey,
      localWrapper,
    };
    await storage.writeSyncSecret(localSecret);
    wdk = new Uint8Array(nextWdk);
    await saveMetadata({ workspaceId, keyId, lastError: null, e2eeStatus: "unlocked" });
    return { workspaceId, keyId };
  }

  async function createWorkspaceKeyMaterial({ workspaceId = createId("workspace"), keyId = createId("key") } = {}) {
    const nextWdk = generateWorkspaceDataKey();
    await persistWorkspaceKey(nextWdk, { workspaceId, keyId });
    return { workspaceId, keyId, wdk: new Uint8Array(nextWdk) };
  }

  async function unlockWithPasskey(wrapper, prfResult) {
    const nextWdk = await unwrapPasskeyKeyWrapper(wrapper, prfResult, {
      expectedWorkspaceId: metadata?.workspaceId || wrapper.workspaceId,
      expectedKeyId: metadata?.keyId || wrapper.keyId,
    });
    await persistWorkspaceKey(nextWdk, { workspaceId: wrapper.workspaceId, keyId: wrapper.keyId });
    return true;
  }

  async function unlockWithRecovery(wrapper, recoveryKey) {
    const nextWdk = await unwrapRecoveryKeyWrapper(wrapper, recoveryKey, {
      expectedWorkspaceId: metadata?.workspaceId || wrapper.workspaceId,
      expectedKeyId: metadata?.keyId || wrapper.keyId,
    });
    await persistWorkspaceKey(nextWdk, { workspaceId: wrapper.workspaceId, keyId: wrapper.keyId });
    return true;
  }

  async function decryptRemoteStates(response) {
    if (!wdk) throw new E2eeSyncLockedError();
    const states = [];
    for (const envelope of artifactPayloads(response)) {
      if (envelope.workspaceId !== metadata.workspaceId || envelope.keyId !== metadata.keyId) {
        throw new Error("Encrypted device envelope belongs to a different workspace key");
      }
      const state = await decryptDeviceState(envelope, wdk, {
        expectedWorkspaceId: metadata.workspaceId,
        expectedKeyId: metadata.keyId,
        expectedDeviceId: envelope.deviceId,
        validate: (value) => validateDecryptedState(value, {
          workspaceId: metadata.workspaceId,
          deviceId: envelope.deviceId,
        }),
      });
      states.push(state);
    }
    return states;
  }

  function compareStamp(left, right) {
    const counter = Number(left?.counter || 0) - Number(right?.counter || 0);
    return counter || String(left?.deviceId || "").localeCompare(String(right?.deviceId || ""));
  }

  function discordSettingArtifactId(deviceId = metadata.deviceId) {
    return `integrations.discord.${deviceId}`;
  }

  async function readRemoteSharedSetting() {
    if (!wdk) throw new E2eeSyncLockedError();
    const response = await api.list("shared-setting");
    const candidates = [];
    for (const envelope of artifactPayloads(response)) {
      if (envelope.settingId !== "integrations.discord" && !envelope.settingId?.startsWith("integrations.discord.")) continue;
      const payload = await decryptSharedSetting(envelope, wdk, {
        expectedWorkspaceId: metadata.workspaceId,
        expectedKeyId: metadata.keyId,
        expectedSettingId: envelope.settingId,
        validateValue: validateSharedSetting,
      });
      if (payload.logicalId && payload.logicalId !== "integrations.discord") throw new Error("Unexpected shared setting logical id");
      candidates.push(payload);
    }
    return candidates.sort((left, right) => compareStamp(right.stamp, left.stamp))[0] || null;
  }

  async function pullSharedSetting() {
    const payload = await readRemoteSharedSetting();
    if (!payload || compareStamp(payload.stamp, metadata.sharedSettingStamp) <= 0) return null;
    await applySharedSetting(cloneJson(payload.value), cloneJson(payload.stamp));
    await saveMetadata({ sharedSettingStamp: payload.stamp });
    return payload;
  }

  async function pushSharedSetting(value, { setup = false } = {}) {
    await load();
    await requireAuthorization(false);
    if (!wdk || (metadata.e2eeStatus !== "encrypted-active" && !(setup && metadata.e2eeStatus === "migrating"))) return { skipped: true };
    const remote = await readRemoteSharedSetting();
    const counter = Math.max(
      metadata.lamportCounter,
      Number(metadata.sharedSettingStamp?.counter) || 0,
      Number(remote?.stamp?.counter) || 0,
    ) + 1;
    const payload = {
      settingId: discordSettingArtifactId(),
      logicalId: "integrations.discord",
      stamp: { counter, deviceId: metadata.deviceId },
      value: value == null ? null : cloneJson(value),
    };
    const envelope = await encryptSharedSetting(payload, {
      workspaceId: metadata.workspaceId,
      keyId: metadata.keyId,
      settingId: payload.settingId,
      wdk,
    });
    await api.put("shared-setting", payload.settingId, envelope);
    await saveMetadata({ sharedSettingStamp: payload.stamp, lamportCounter: counter });
    return { skipped: false, payload };
  }

  async function applyStates(states, { expectedSnapshot = null } = {}) {
    const merged = mergeDeviceStates(states);
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
    if (!merged.workspaceId || !Object.keys(merged.nodes || {}).length) {
      return { merged, projected: baseDoc, changed: false };
    }
    const projected = projectMergedState(merged, {
      baseDoc,
      schemaVersion: Number.isInteger(baseDoc?.schemaVersion) ? baseDoc.schemaVersion : 3,
    });
    const changed = !sameJson(projected, baseDoc);
    if (changed) {
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
    return { merged, projected, changed };
  }

  async function remoteStatus() {
    await requireAuthorization(false);
    assertAccountMatch();
    const response = await api.status();
    await bindAccount(response?.accountId);
    const e2ee = isRecord(response?.e2ee) ? response.e2ee : {};
    const patch = {
      e2eeStatus: typeof e2ee.status === "string" ? e2ee.status : "unconfigured",
      workspaceId: e2ee.workspaceId || metadata.workspaceId,
      keyId: e2ee.keyId || metadata.keyId,
      migrationLockExpiresAt: typeof e2ee.lockExpiresAt === "string" ? e2ee.lockExpiresAt : null,
      remoteFingerprint: response?.fingerprint || metadata.remoteFingerprint,
      legacyCount: Number.isInteger(response?.legacy?.count) ? response.legacy.count : metadata.legacyCount,
      legacyFingerprint: typeof response?.legacy?.fingerprint === "string" ? response.legacy.fingerprint : metadata.legacyFingerprint,
    };
    await saveMetadata(patch);
    return response;
  }

  async function assertReady({ allowMigrating = false } = {}) {
    const response = await remoteStatus();
    const status = response?.e2ee?.status || "unconfigured";
    if (status === "unconfigured" || status === "legacy" || (status === "migrating" && !allowMigrating)) throw new E2eeSetupRequiredError();
    if (!wdk) await restoreLocalKey();
    if (!wdk) throw new E2eeSyncLockedError();
    if (metadata.pendingKeyWrappers.length) {
      for (const wrapper of metadata.pendingKeyWrappers) await api.put("key-wrapper", wrapper.wrapperId, wrapper);
      localDirty = true;
      await saveMetadata({ pendingKeyWrappers: [], localDirty: true });
    }
    return response;
  }

  async function pull({ interactive = false } = {}) {
    try {
      await load();
      await refreshLocalDirty();
      await requireAuthorization(interactive);
      await assertReady();
      if (metadata.syncPaused) return { skipped: true, reason: "sync_paused" };
      if (localDirty) return { skipped: true, reason: "local_changes_pending" };
      const expectedSnapshot = createSyncContentSnapshot(await getDocument());
      const response = await api.list("device-envelope");
      await bindAccount(response?.accountId);
      const states = await decryptRemoteStates(response);
      const hadRemote = metadata.hasSynced || !!metadata.lastState;
      if (!states.length) {
        await pullSharedSetting();
        await saveMetadata({
          remoteFingerprint: response?.fingerprint || null,
          remoteMissing: hadRemote,
          lastSyncedAt: new Date(now()).toISOString(),
          lastError: null,
        });
        return { skipped: false, remote: false, remoteMissing: hadRemote, changed: false, projected: await getDocument() };
      }
      const applied = await applyStates(states, { expectedSnapshot });
      await pullSharedSetting();
      const skippedDuring = applied.skipped === true;
      if (skippedDuring) localDirty = true;
      const metadataPatch = {
        remoteFingerprint: response?.fingerprint || null,
        remoteMissing: false,
        accountMismatch: false,
        hasSynced: true,
        lamportCounter: Math.max(metadata.lamportCounter, Number(applied.merged.lamportCounter) || 0),
        lastSyncedAt: new Date(now()).toISOString(),
        lastError: null,
        e2eeStatus: "encrypted-active",
        localDirty: skippedDuring,
      };
      // Do not stamp a remote merge that excluded in-flight local edits as lastState.
      if (!skippedDuring) metadataPatch.lastState = applied.merged;
      await saveMetadata(metadataPatch);
      return { skipped: skippedDuring, remote: true, ...applied };
    } catch (error) {
      const expectedDeviceSetup = error instanceof E2eeSyncLockedError || error instanceof E2eeSetupRequiredError || error instanceof E2eeMigrationLockedError;
      await saveMetadata({
        lastError: expectedDeviceSetup ? null : (error.message || "encrypted sync pull failed"),
        accountMismatch: error.code === "sync_account_mismatch",
      });
      throw error;
    }
  }

  async function push(options = {}) {
    await load();
    if (lockManager?.request) {
      return lockManager.request(`taskliner-sync:${metadata?.deviceId || "device"}`, () => pushInternal(options));
    }
    return pushInternal(options);
  }

  async function pushInternal({ interactive = false, allowEmptyRemote = false, setup = false } = {}) {
    try {
      await load();
      await requireAuthorization(interactive);
      await assertReady({ allowMigrating: setup });
      if (metadata.syncPaused) return { skipped: true, reason: "sync_paused" };
      const response = await api.list("device-envelope");
      const remoteStates = await decryptRemoteStates(response);
      if (metadata.hasSynced && !remoteStates.length && !allowEmptyRemote) {
        await saveMetadata({ remoteMissing: true, lastError: null });
        return { skipped: true, reason: "remote_data_missing", remoteMissing: true };
      }
      const remoteMerged = mergeDeviceStates(remoteStates);
      const counter = Math.max(metadata.lamportCounter, Number(remoteMerged.lamportCounter) || 0) + 1;
      const localDoc = await getDocument();
      const submittedSnapshot = createSyncContentSnapshot(localDoc);
      let state = createDeviceState({
        doc: localDoc,
        workspaceId: metadata.workspaceId,
        deviceId: metadata.deviceId,
        lamportCounter: counter,
        generatedAt: new Date(now()).toISOString(),
        previousState: metadata.lastState,
      });
      state.workspaceSettings = {};
      state = addDeletionTombstones(state, metadata.lastState, counter, metadata.deviceId, now);
      const envelope = await encryptDeviceState(state, {
        workspaceId: metadata.workspaceId,
        keyId: metadata.keyId,
        deviceId: metadata.deviceId,
        wdk,
      });
      await api.put("device-envelope", metadata.deviceId, envelope);
      const verified = await api.get("device-envelope", metadata.deviceId);
      const verifiedStates = await decryptRemoteStates(verified);
      if (verifiedStates.length !== 1 || !sameJson(verifiedStates[0], state)) {
        throw new Error("Encrypted device state verification failed");
      }
      const allStates = remoteStates.filter((entry) => entry.deviceId !== metadata.deviceId).concat(state);
      const applied = await applyStates(allStates, { expectedSnapshot: submittedSnapshot });
      await pullSharedSetting();
      const currentSnapshot = createSyncContentSnapshot(await getDocument());
      const projectedSnapshot = createSyncContentSnapshot(applied.projected);
      const localChangesPending = applied.skipped === true || currentSnapshot !== projectedSnapshot;
      if (!localChangesPending) localDirty = false;
      else localDirty = true;
      const metadataPatch = {
        remoteFingerprint: verified?.fingerprint || response?.fingerprint || null,
        remoteMissing: false,
        accountMismatch: false,
        hasSynced: true,
        lamportCounter: Math.max(counter, Number(applied.merged.lamportCounter) || 0),
        lastSyncedAt: new Date(now()).toISOString(),
        lastError: null,
        e2eeStatus: "encrypted-active",
        localDirty: localChangesPending,
      };
      if (!localChangesPending) metadataPatch.lastState = applied.merged;
      await saveMetadata(metadataPatch);
      return { skipped: localChangesPending, remote: allStates.length > 1, ...applied };
    } catch (error) {
      const expectedDeviceSetup = error instanceof E2eeSyncLockedError || error instanceof E2eeSetupRequiredError || error instanceof E2eeMigrationLockedError;
      await saveMetadata({
        lastError: expectedDeviceSetup ? null : (error.message || "encrypted sync push failed"),
        accountMismatch: error.code === "sync_account_mismatch",
      });
      throw error;
    }
  }

  async function syncNow({ interactive = true } = {}) {
    await load();
    await refreshLocalDirty();
    await requireAuthorization(interactive);
    await assertReady();
    return localDirty ? push({ interactive: false }) : pull({ interactive: false });
  }

  async function listKeyWrappers() {
    await load();
    await requireAuthorization(false);
    const response = await api.list("key-wrapper");
    await bindAccount(response?.accountId);
    return artifactPayloads(response);
  }

  async function uploadKeyWrapper(wrapper) {
    await load();
    await requireAuthorization(false);
    if (!isRecord(wrapper) || typeof wrapper.wrapperId !== "string") throw new TypeError("A key wrapper is required");
    if (wrapper.workspaceId !== metadata.workspaceId || wrapper.keyId !== metadata.keyId) {
      throw new Error("Key wrapper belongs to a different workspace key");
    }
    return api.put("key-wrapper", wrapper.wrapperId, wrapper);
  }

  async function listArtifacts(kind) {
    await load();
    await requireAuthorization(false);
    const response = await api.list(kind);
    await bindAccount(response?.accountId);
    return Array.isArray(response?.artifacts) ? response.artifacts : [];
  }

  async function putArtifact(kind, artifactId, payload) {
    await load();
    await requireAuthorization(false);
    return api.put(kind, artifactId, payload);
  }

  async function deleteArtifact(kind, artifactId) {
    await load();
    await requireAuthorization(false);
    return api.delete(kind, artifactId);
  }

  async function activateNewWorkspace({ wrappers = [], sharedSetting = undefined } = {}) {
    await load();
    await requireAuthorization(false);
    if (!wdk || !metadata.workspaceId || !metadata.keyId) throw new E2eeSetupRequiredError();
    await saveMetadata({ pendingKeyWrappers: wrappers });
    const begun = await api.beginWorkspaceInitialization({ workspaceId: metadata.workspaceId, keyId: metadata.keyId });
    const lock = begun?.e2ee || begun;
    await saveMetadata({
      e2eeStatus: "migrating",
      migration: { lockToken: lock?.lockToken, lockExpiresAt: lock?.lockExpiresAt || null },
    });
    for (const wrapper of wrappers) await uploadKeyWrapper(wrapper);
    localDirty = true;
    const pushed = await push({ interactive: false, allowEmptyRemote: true, setup: true });
    if (sharedSetting !== undefined) await pushSharedSetting(sharedSetting, { setup: true });
    await api.finalizeWorkspaceInitialization({
      lockToken: lock?.lockToken,
      workspaceId: metadata.workspaceId,
      keyId: metadata.keyId,
      verifiedDeviceId: metadata.deviceId,
      requirePasskey: wrappers.some((wrapper) => wrapper.kind === "passkey-prf"),
    });
    await saveMetadata({ e2eeStatus: "encrypted-active", pendingKeyWrappers: [], migration: null });
    return pushed;
  }

  async function migrateLegacy({ wrappers = [] } = {}) {
    await load();
    await requireAuthorization(false);
    if (!wdk || !metadata.workspaceId || !metadata.keyId) throw new E2eeSetupRequiredError();

    if (wrappers.length) await saveMetadata({ pendingKeyWrappers: wrappers });
    const wrappersToUpload = wrappers.length ? wrappers : metadata.pendingKeyWrappers;
    let migration = metadata.migration;
    let sourceStates = null;
    if (!migration?.lockToken) {
      const status = await api.status();
      await bindAccount(status?.accountId);
      const expectedFingerprint = status?.legacy?.fingerprint;
      if (typeof expectedFingerprint !== "string" || !expectedFingerprint) {
        throw new Error("Legacy sync fingerprint is missing");
      }
      const keyPair = await generateMigrationClientKeyPair();
      const begun = await api.beginMigration({
        workspaceId: metadata.workspaceId,
        keyId: metadata.keyId,
        expectedFingerprint,
        migrationPublicKey: keyPair.migrationPublicKey,
      });
      const details = begun?.migration || begun;
      const legacyFingerprint = details?.legacyFingerprint || expectedFingerprint;
      const bundle = details?.legacyBundle;
      const decrypted = await decryptLegacyMigrationBundle(bundle, keyPair.privateKey, {
        expectedFingerprint: legacyFingerprint,
        validateState: (state) => validateDeviceState(state).ok,
      });
      sourceStates = decrypted.states;
      const localDocument = await getDocument();
      let localNeedsMerge = localDirty || !metadata.lastState;
      if (!localNeedsMerge && metadata.lastState) {
        try {
          const lastProjection = projectMergedState(metadata.lastState, {
            baseDoc: localDocument,
            schemaVersion: Number.isInteger(localDocument?.schemaVersion) ? localDocument.schemaVersion : 3,
          });
          localNeedsMerge = createSyncContentSnapshot(lastProjection) !== createSyncContentSnapshot(localDocument);
        } catch {
          localNeedsMerge = true;
        }
      }
      if (localNeedsMerge) {
        const remoteCounter = sourceStates.reduce(
          (maximum, state) => Math.max(maximum, Number(state?.lamportCounter) || 0),
          metadata.lamportCounter,
        );
        const counter = remoteCounter + 1;
        let localState = createDeviceState({
          doc: localDocument,
          workspaceId: metadata.workspaceId,
          deviceId: metadata.deviceId,
          lamportCounter: counter,
          generatedAt: new Date(now()).toISOString(),
        });
        localState.workspaceSettings = {};
        localState = addDeletionTombstones(localState, metadata.lastState, counter, metadata.deviceId, now);
        sourceStates = sourceStates.filter((state) => state.deviceId !== metadata.deviceId).concat(localState);
      }
      migration = {
        lockToken: details.lockToken,
        legacyFingerprint,
        verifiedV3Fingerprint: null,
      };
      await saveMetadata({ migration, e2eeStatus: "migrating" });
    }

    for (const wrapper of wrappersToUpload) await uploadKeyWrapper(wrapper);
    if (sourceStates) {
      for (const sourceState of sourceStates) {
        const state = cloneJson(sourceState);
        state.workspaceId = metadata.workspaceId;
        state.workspaceSettings = {};
        const validation = validateDeviceState(state);
        if (!validation.ok) throw new Error(`Legacy state failed validation: ${validation.errors[0]}`);
        const envelope = await encryptDeviceState(state, {
          workspaceId: metadata.workspaceId,
          keyId: metadata.keyId,
          deviceId: state.deviceId,
          wdk,
        });
        await api.put("device-envelope", state.deviceId, envelope);
      }
    }

    const verified = await api.list("device-envelope");
    const verifiedStates = await decryptRemoteStates(verified);
    if (!verifiedStates.length) throw new Error("No encrypted state was found after migration upload");
    const verifiedMerged = mergeDeviceStates(verifiedStates);
    if (!Object.keys(verifiedMerged.nodes || {}).length && sourceStates?.some((state) => Object.keys(state.nodes || {}).length)) {
      throw new Error("Encrypted migration content verification failed");
    }
    migration = {
      ...migration,
      verifiedV3Fingerprint: verified?.fingerprint,
    };
    await saveMetadata({ migration, e2eeStatus: "migrating" });
    await api.activateMigration({
      lockToken: migration.lockToken,
      expectedFingerprint: migration.legacyFingerprint,
      verifiedV3Fingerprint: migration.verifiedV3Fingerprint,
    });
    const applied = await applyStates(verifiedStates);
    localDirty = false;
    await saveMetadata({
      migration: null,
      pendingKeyWrappers: [],
      e2eeStatus: "encrypted-active",
      hasSynced: true,
      remoteMissing: false,
      remoteFingerprint: verified?.fingerprint || null,
      lastState: applied.merged,
      lamportCounter: Number(applied.merged.lamportCounter) || 0,
      lastSyncedAt: new Date(now()).toISOString(),
      lastError: null,
    });
    return { skipped: false, migrated: true, ...applied };
  }

  function disconnectRealtime() {
    const socket = realtimeSocket;
    realtimeSocket = null;
    realtimeState = "disconnected";
    if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
    if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
    realtimeHeartbeatTimer = null;
    realtimePongTimer = null;
    socket?.close();
  }

  function connectRealtime({ onChange = async () => undefined, onStatus = () => undefined } = {}) {
    if (realtimeSocket || !auth.hasToken() || typeof globalThis.WebSocket !== "function") return false;
    const location = globalThis.location;
    if (!location?.host || !/^https?:$/.test(location.protocol || "")) return false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const report = (state, details = {}) => {
      realtimeState = state;
      try { onStatus({ state, ...details }); } catch { /* reporting cannot break sync */ }
    };
    try {
      const socket = new globalThis.WebSocket(`${protocol}//${location.host}/api/realtime`);
      realtimeSocket = socket;
      report("connecting");
      socket.onopen = () => {
        if (realtimeSocket !== socket) return;
        report("connected");
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
            report("error");
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
            report("disconnected", { reason: "heartbeat_timeout" });
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
        report("disconnected", { code: event?.code || 0 });
      };
      socket.onerror = () => {
        if (realtimeSocket !== socket) return;
        realtimeSocket = null;
        if (realtimeHeartbeatTimer !== null) clearTimeoutFn(realtimeHeartbeatTimer);
        if (realtimePongTimer !== null) clearTimeoutFn(realtimePongTimer);
        realtimeHeartbeatTimer = null;
        realtimePongTimer = null;
        report("error");
        socket.close();
      };
      return true;
    } catch {
      realtimeSocket = null;
      report("disconnected");
      return false;
    }
  }

  async function disconnect() {
    await load();
    disconnectRealtime();
    localDirty = false;
    wdk = null;
    localSecret = null;
    await auth.logout();
    await storage.clearSyncSecret();
    metadata = normalizeMetadata({ deviceId: metadata.deviceId, deviceName: metadata.deviceName });
    await storage.writeSyncMetadata(cloneJson(metadata));
  }

  async function discardWorkspaceKey() {
    await load();
    wdk = null;
    localSecret = null;
    await storage.clearSyncSecret();
    await saveMetadata({
      workspaceId: null,
      keyId: null,
      pendingKeyWrappers: [],
      migration: null,
      e2eeStatus: "unknown",
      lastError: null,
    });
  }

  async function resumeSync() {
    await load();
    await saveMetadata({ syncPaused: false, remoteMissing: false, lastError: null });
    localDirty = true;
    return push({ interactive: false, allowEmptyRemote: true });
  }

  async function deleteRemoteData() {
    await load();
    await requireAuthorization(false);
    await api.deleteAll();
    localDirty = false;
    wdk = null;
    localSecret = null;
    await storage.clearSyncSecret();
    metadata = normalizeMetadata({ deviceId: metadata.deviceId, deviceName: metadata.deviceName });
    await storage.writeSyncMetadata(cloneJson(metadata));
  }

  return {
    load,
    pull,
    push,
    syncNow,
    createWorkspaceKeyMaterial,
    persistWorkspaceKey,
    unlockWithPasskey,
    unlockWithRecovery,
    listKeyWrappers,
    uploadKeyWrapper,
    pullSharedSetting,
    pushSharedSetting,
    listArtifacts,
    putArtifact,
    deleteArtifact,
    activateNewWorkspace,
    migrateLegacy,
    refreshStatus: remoteStatus,
    connectRealtime,
    disconnectRealtime,
    disconnect,
    discardWorkspaceKey,
    resumeSync,
    deleteRemoteData,
    noteLocalChange() {
      localDirty = true;
      if (loaded) void saveMetadata({ localDirty: true });
      else void load().then(() => saveMetadata({ localDirty: true }));
    },
    clearLocalChange() {
      localDirty = false;
      if (loaded) void saveMetadata({ localDirty: false });
      else void load().then(() => saveMetadata({ localDirty: false }));
    },
    getWorkspaceKey() { return wdk ? new Uint8Array(wdk) : null; },
    getStatus() {
      return {
        authorized: auth.hasToken(),
        workspaceId: metadata?.workspaceId || null,
        keyId: metadata?.keyId || null,
        hasSynced: !!metadata?.hasSynced,
        localDirty,
        syncPaused: !!metadata?.syncPaused,
        remoteMissing: !!metadata?.remoteMissing,
        accountMismatch: !!metadata?.accountMismatch,
        reauthorizeRequired: !!metadata?.reauthorizeRequired,
        lastSyncedAt: metadata?.lastSyncedAt || null,
        lastError: metadata?.lastError || null,
        realtimeState,
        e2eeStatus: metadata?.e2eeStatus || "unknown",
        migrationLockExpiresAt: metadata?.migrationLockExpiresAt || null,
        legacyCount: Number.isInteger(metadata?.legacyCount) ? metadata.legacyCount : 0,
        legacyFingerprint: metadata?.legacyFingerprint || null,
        locked: !wdk,
        deviceId: metadata?.deviceId || null,
        deviceName: metadata?.deviceName || "Taskliner device",
        accountId: currentAccountId(),
      };
    },
  };
}

export { LOCAL_KEY_FORMAT, LOCAL_KEY_VERSION };
