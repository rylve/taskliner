import { decryptJson, deriveWorkspaceKey, encryptJson, DEFAULT_PBKDF2_ITERATIONS } from "../crypto/workspace-crypto.mjs";
import { createDeviceState, validateDeviceState } from "../sync/device-state.mjs";
import { mergeDeviceStates } from "../sync/merge.mjs";
import { projectMergedState } from "../sync/project.mjs";
import { retryWithBackoff } from "../sync/backoff.mjs";
import { createDriveAppDataClient } from "./drive-appdata.mjs";

export const DRIVE_SYNC_FILE_NAME = "taskliner-sync-v1.json";
export const DRIVE_SYNC_FORMAT = "taskliner-drive-sync-v1";
export const DRIVE_SYNC_VERSION = 1;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function createId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeMetadata(value, createDeviceId = () => createId("device")) {
  const source = isRecord(value) ? value : {};
  return {
    version: 1,
    deviceId: typeof source.deviceId === "string" && source.deviceId ? source.deviceId : createDeviceId(),
    workspaceId: typeof source.workspaceId === "string" && source.workspaceId ? source.workspaceId : null,
    lamportCounter: Number.isInteger(source.lamportCounter) && source.lamportCounter >= 0 ? source.lamportCounter : 0,
    syncFileId: typeof source.syncFileId === "string" && source.syncFileId ? source.syncFileId : null,
    hasSynced: source.hasSynced === true,
    lastSyncedAt: typeof source.lastSyncedAt === "string" ? source.lastSyncedAt : null,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    lastState: isRecord(source.lastState) ? source.lastState : null,
  };
}

function normalizeEnvelope(value) {
  if (!isRecord(value) || value.format !== DRIVE_SYNC_FORMAT || value.version !== DRIVE_SYNC_VERSION) {
    throw new Error("Unsupported Taskliner Drive sync payload");
  }
  if (typeof value.workspaceId !== "string" || !value.workspaceId) throw new Error("Drive sync payload has no workspace");
  if (!isRecord(value.kdf) || typeof value.kdf.salt !== "string" || !Number.isInteger(value.kdf.iterations)) {
    throw new Error("Drive sync payload has invalid key metadata");
  }
  if (!isRecord(value.encrypted)) throw new Error("Drive sync payload has no encrypted state");
  return value;
}

function associatedData(workspaceId) {
  return `${DRIVE_SYNC_FORMAT}:${workspaceId}`;
}

function quoteDriveQuery(value) {
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

export class SyncPassphraseRequiredError extends Error {
  constructor(message = "A sync passphrase is required") {
    super(message);
    this.name = "SyncPassphraseRequiredError";
    this.code = "sync_passphrase_required";
  }
}

export class SyncAuthorizationRequiredError extends Error {
  constructor(message = "Google authorization is required") {
    super(message);
    this.name = "SyncAuthorizationRequiredError";
    this.code = "sync_authorization_required";
  }
}

/**
 * Encrypted, single-file appDataFolder sync for the Taskliner document.
 * The passphrase never leaves this module and the derived CryptoKey is the
 * only sync secret stored locally.
 */
export function createTasklinerDriveSync({
  auth,
  storage,
  driveClient,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  getDocument,
  applyDocument = async () => undefined,
  now = () => Date.now(),
  createDeviceId = () => createId("device"),
} = {}) {
  if (!auth || typeof auth.getToken !== "function") throw new TypeError("auth is required");
  if (!storage || typeof storage.readSyncMetadata !== "function" || typeof storage.writeSyncMetadata !== "function") {
    throw new TypeError("storage sync metadata methods are required");
  }
  if (typeof getDocument !== "function") throw new TypeError("getDocument is required");
  const drive = driveClient || createDriveAppDataClient({
    fetch: fetchImpl,
    tokenProvider: { getToken: () => auth.getToken() },
  });

  let metadata = null;
  let secret = null;
  let loaded = false;

  async function load() {
    if (loaded) return;
    metadata = normalizeMetadata(await storage.readSyncMetadata(), createDeviceId);
    const stored = await storage.readSyncSecret?.();
    if (stored?.key?.type === "secret") {
      secret = {
        key: stored.key,
        workspaceId: stored.workspaceId || metadata.workspaceId,
        salt: stored.salt,
        iterations: stored.iterations || DEFAULT_PBKDF2_ITERATIONS,
        deviceId: stored.deviceId || metadata.deviceId,
      };
    }
    loaded = true;
  }

  async function saveMetadata(patch = {}) {
    metadata = normalizeMetadata({ ...metadata, ...patch }, createDeviceId);
    await storage.writeSyncMetadata(cloneJson(metadata));
    return metadata;
  }

  async function saveSecret(nextSecret) {
    secret = nextSecret;
    if (typeof storage.writeSyncSecret === "function") {
      try {
        await storage.writeSyncSecret({
          key: secret.key,
          workspaceId: secret.workspaceId,
          salt: secret.salt,
          iterations: secret.iterations,
          deviceId: secret.deviceId,
        });
      } catch {
        // Private browsing may reject CryptoKey persistence; memory sync still works.
      }
    }
  }

  async function ensureAuthorization(interactive = false) {
    if (auth.hasToken?.()) return true;
    if (await auth.restore?.()) return true;
    if (!interactive) return false;
    await auth.connect();
    return true;
  }

  async function callDrive(operation) {
    return retryWithBackoff(operation, { maxRetries: 2 });
  }

  async function readRemoteFile() {
    const result = await callDrive(() => drive.list({
      pageSize: 10,
      q: `name = ${quoteDriveQuery(DRIVE_SYNC_FILE_NAME)} and trashed = false`,
    }));
    const file = (result?.files || []).find((candidate) => candidate?.id);
    if (!file) return null;
    const envelope = normalizeEnvelope(await callDrive(() => drive.download(file.id)));
    return { file, envelope };
  }

  async function decryptEnvelope(envelope, key) {
    if (envelope.workspaceId !== key.workspaceId) throw new Error("Drive sync workspace does not match this device");
    const state = await decryptJson(envelope.encrypted, key.key, { associatedData: associatedData(key.workspaceId) });
    const validation = validateDeviceState(state);
    if (!validation.ok) throw new Error(`Invalid decrypted sync state: ${validation.errors.join("; ")}`);
    if (state.workspaceId !== key.workspaceId) throw new Error("Decrypted sync state has the wrong workspace");
    return state;
  }

  async function createKeyFromPassphrase(passphrase, remote) {
    const kdf = remote?.envelope?.kdf || {};
    const derived = await deriveWorkspaceKey(passphrase, {
      salt: kdf.salt || secret?.salt,
      iterations: Number.isInteger(kdf.iterations) ? kdf.iterations : (secret?.iterations || DEFAULT_PBKDF2_ITERATIONS),
    });
    const workspaceId = remote?.envelope?.workspaceId || metadata.workspaceId || secret?.workspaceId || createId("workspace");
    return {
      key: derived.key,
      workspaceId,
      salt: derived.salt,
      iterations: derived.iterations,
      deviceId: metadata.deviceId,
    };
  }

  async function setPassphrase(passphrase, { interactive = true } = {}) {
    await load();
    if (!(await ensureAuthorization(interactive))) throw new SyncAuthorizationRequiredError();
    const remote = await readRemoteFile();
    const nextSecret = await createKeyFromPassphrase(passphrase, remote);
    if (remote) await decryptEnvelope(remote.envelope, nextSecret);
    await saveSecret(nextSecret);
    await saveMetadata({
      workspaceId: nextSecret.workspaceId,
      syncFileId: remote?.file?.id || metadata.syncFileId,
      lastError: null,
    });
    return { hasRemote: !!remote, workspaceId: nextSecret.workspaceId };
  }

  async function requireReady({ interactive = false } = {}) {
    await load();
    if (!(await ensureAuthorization(interactive))) throw new SyncAuthorizationRequiredError();
    if (!secret?.key || !secret.workspaceId) throw new SyncPassphraseRequiredError();
  }

  async function localState(counter) {
    const current = await getDocument();
    const state = createDeviceState({
      doc: current,
      workspaceId: secret.workspaceId,
      deviceId: metadata.deviceId,
      lamportCounter: counter,
      generatedAt: new Date(now()).toISOString(),
    });
    const previousNodes = metadata.lastState?.nodes;
    if (isRecord(previousNodes)) {
      const deletionStamp = { counter, deviceId: metadata.deviceId };
      for (const [nodeId, previousNode] of Object.entries(previousNodes)) {
        if (state.nodes[nodeId] || !isRecord(previousNode)) continue;
        state.nodes[nodeId] = {
          ...cloneJson(previousNode),
          deletedAt: { value: new Date(now()).toISOString(), stamp: deletionStamp },
        };
        state.tombstones[nodeId] = state.nodes[nodeId].deletedAt;
      }
    }
    return state;
  }

  async function applyMergedState(state, baseDoc) {
    const projected = projectMergedState(state, {
      baseDoc,
      schemaVersion: Number.isInteger(baseDoc?.schemaVersion) ? baseDoc.schemaVersion : 3,
    });
    if (!sameJson(projected, baseDoc)) await applyDocument(projected);
    return projected;
  }

  async function writeRemote(state, remote) {
    const envelope = {
      format: DRIVE_SYNC_FORMAT,
      version: DRIVE_SYNC_VERSION,
      workspaceId: secret.workspaceId,
      deviceId: metadata.deviceId,
      updatedAt: new Date(now()).toISOString(),
      kdf: { salt: secret.salt, iterations: secret.iterations },
      encrypted: await encryptJson(state, secret.key, { associatedData: associatedData(secret.workspaceId) }),
    };
    const input = {
      name: DRIVE_SYNC_FILE_NAME,
      mimeType: "application/json",
      mediaMimeType: "application/json",
      appProperties: { taskliner: "sync", format: DRIVE_SYNC_FORMAT },
      content: JSON.stringify(envelope),
      fields: "id,name,modifiedTime,version,appProperties",
    };
    const result = remote?.file?.id
      ? await callDrive(() => drive.update(remote.file.id, input))
      : await callDrive(() => drive.create(input));
    await saveMetadata({
      workspaceId: secret.workspaceId,
      syncFileId: result?.id || remote?.file?.id || metadata.syncFileId,
      lamportCounter: Math.max(metadata.lamportCounter, state.lamportCounter || 0),
      hasSynced: true,
      lastSyncedAt: new Date(now()).toISOString(),
      lastError: null,
      lastState: state,
    });
    return result;
  }

  async function pull(options = {}) {
    try {
      await requireReady(options);
      const remote = await readRemoteFile();
      if (!remote) return { skipped: false, remote: false, changed: false };
      const remoteState = await decryptEnvelope(remote.envelope, secret);
      const baseDoc = await getDocument();
      let merged = remoteState;
      if (metadata.hasSynced) {
        const local = await localState(metadata.lamportCounter);
        merged = mergeDeviceStates([remoteState, local]);
      }
      const projected = await applyMergedState(merged, baseDoc);
      await saveMetadata({
        workspaceId: secret.workspaceId,
        syncFileId: remote.file.id,
        lamportCounter: Math.max(metadata.lamportCounter, remoteState.lamportCounter || 0),
        hasSynced: true,
        lastSyncedAt: new Date(now()).toISOString(),
        lastError: null,
        lastState: merged,
      });
      return { skipped: false, remote: true, changed: !sameJson(projected, baseDoc), state: merged };
    } catch (error) {
      await saveMetadata({ lastError: error.message || "sync pull failed" });
      throw error;
    }
  }

  async function push(options = {}) {
    try {
      await requireReady(options);
      const remote = await readRemoteFile();
      const current = await getDocument();
      let merged;
      if (remote) {
        const remoteState = await decryptEnvelope(remote.envelope, secret);
        if (!metadata.hasSynced) {
          merged = remoteState;
        } else {
          const counter = Math.max(metadata.lamportCounter, remoteState.lamportCounter || 0) + 1;
          merged = mergeDeviceStates([remoteState, await localState(counter)]);
        }
      } else {
        merged = await localState(metadata.lamportCounter + 1);
      }
      const projected = await applyMergedState(merged, current);
      await writeRemote(merged, remote);
      return { skipped: false, remote: !!remote, changed: !sameJson(projected, current), state: merged };
    } catch (error) {
      await saveMetadata({ lastError: error.message || "sync push failed" });
      throw error;
    }
  }

  async function syncNow({ interactive = true } = {}) {
    await load();
    if (!(await ensureAuthorization(interactive))) throw new SyncAuthorizationRequiredError();
    if (!secret?.key) throw new SyncPassphraseRequiredError();
    return push({ interactive: false });
  }

  async function disconnect() {
    await load();
    secret = null;
    auth.clear?.();
    await storage.clearSyncSecret?.();
    await storage.writeSyncMetadata(normalizeMetadata({ deviceId: metadata.deviceId }, createDeviceId));
    metadata = normalizeMetadata({ deviceId: metadata.deviceId }, createDeviceId);
  }

  return {
    load,
    setPassphrase,
    pull,
    push,
    syncNow,
    disconnect,
    getStatus() {
      return {
        authorized: !!auth.hasToken?.(),
        hasPassphrase: !!secret?.key,
        workspaceId: secret?.workspaceId || metadata?.workspaceId || null,
        hasSynced: !!metadata?.hasSynced,
        lastSyncedAt: metadata?.lastSyncedAt || null,
        lastError: metadata?.lastError || null,
      };
    },
  };
}
