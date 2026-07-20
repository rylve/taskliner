import { mergeDeviceStates } from "../../src/sync/merge.mjs";
import { validateDeviceState } from "../../src/sync/device-state.mjs";
import { deleteFile, downloadFile, getDriveAccessToken, listTasklinerFiles, writeSyncArtifact, writeTasklinerFile } from "./drive.mjs";
import { artifactFromFile, MAX_SYNC_ARTIFACT_BYTES, validateArtifactPayload } from "./sync-artifacts.mjs";

export const SERVER_SYNC_WORKSPACE_ID = "taskliner-google-account-v1";
export const STALE_DEVICE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
const MIGRATION_LOCK_MS = 10 * 60 * 1000;
const textEncoder = new TextEncoder();
const schemaPromises = new WeakMap();
const E2EE_COLUMNS = Object.freeze([
  ["workspace_id", "TEXT"],
  ["key_id", "TEXT"],
  ["e2ee_status", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["legacy_fingerprint", "TEXT"],
  ["cutover_lock_token", "TEXT"],
  ["cutover_lock_expires_at", "TEXT"],
  ["cutover_verified_at", "TEXT"],
]);

function validationError(message, status = 400, code = "invalid_state") {
  throw Object.assign(new Error(message), { status, code });
}

export async function ensureSyncV3Schema(env) {
  const database = env?.DB;
  if (!database || (typeof database !== "object" && typeof database !== "function")) {
    throw new Error("D1 binding DB is required");
  }
  if (schemaPromises.has(database)) return schemaPromises.get(database);
  const migration = (async () => {
    const current = await database.prepare("PRAGMA table_info(taskliner_users)").all();
    const columns = new Set((current?.results || []).map((entry) => entry.name));
    for (const [name, definition] of E2EE_COLUMNS) {
      if (columns.has(name)) continue;
      try {
        await database.prepare(`ALTER TABLE taskliner_users ADD COLUMN ${name} ${definition}`).run();
      } catch (error) {
        if (!/duplicate column name/i.test(String(error?.message || error))) throw error;
      }
    }
    const verified = await database.prepare("PRAGMA table_info(taskliner_users)").all();
    const verifiedColumns = new Set((verified?.results || []).map((entry) => entry.name));
    for (const [name] of E2EE_COLUMNS) {
      if (!verifiedColumns.has(name)) throw new Error(`D1 migration verification failed: ${name}`);
    }
  })().catch((error) => {
    schemaPromises.delete(database);
    throw error;
  });
  schemaPromises.set(database, migration);
  return migration;
}

function validateState(state) {
  const validation = validateDeviceState(state);
  if (!validation.ok) validationError(`Invalid Drive sync state: ${validation.errors.join("; ")}`);
  if (state.workspaceId !== SERVER_SYNC_WORKSPACE_ID) validationError("Drive sync state has the wrong workspace");
  return state;
}

function legacyFile(file) {
  return file?.appProperties?.format === "taskliner-device-state"
    || /^taskliner-device-v2\..+\.json$/.test(file?.name || "");
}

export function deviceIdFromFile(file) {
  if (typeof file?.appProperties?.deviceId === "string" && file.appProperties.deviceId) return file.appProperties.deviceId;
  const match = /^taskliner-device-v2\.(.+)\.json$/.exec(file?.name || "");
  return match?.[1] || null;
}

export function isActiveDeviceFile(file, now = Date.now()) {
  if (!file?.modifiedTime) return true;
  const modified = Date.parse(file.modifiedTime);
  return !Number.isFinite(modified) || now - modified < STALE_DEVICE_AFTER_MS;
}

export function fileFingerprint(files) {
  return files
    .map((file) => `${file.id}:${file.modifiedTime || ""}:${file.version || ""}`)
    .sort()
    .join("|") || "empty";
}

function unquoteEtag(value) {
  return String(value || "").replace(/^W\//, "").replace(/^\"|\"$/g, "");
}

async function allDriveFiles(env, user) {
  const accessToken = await getDriveAccessToken(env, user);
  return { accessToken, files: await listTasklinerFiles(accessToken) };
}

export async function getSyncSnapshot(env, user, { ifNoneMatch = null, now = Date.now() } = {}) {
  const { accessToken, files: allFiles } = await allDriveFiles(env, user);
  const files = allFiles.filter(legacyFile);
  const fingerprint = fileFingerprint(files);
  if (ifNoneMatch && unquoteEtag(ifNoneMatch) === fingerprint) {
    return { accessToken, allFiles, files, activeFiles: files.filter((file) => isActiveDeviceFile(file, now)), fingerprint, notModified: true };
  }
  const activeFiles = files.filter((file) => isActiveDeviceFile(file, now));
  const devices = [];
  for (const file of activeFiles) devices.push({ file, state: validateState(await downloadFile(accessToken, file.id)) });
  const mergedState = mergeDeviceStates(devices.map(({ state }) => state));
  return {
    accessToken,
    allFiles,
    files,
    activeFiles,
    devices,
    mergedState,
    fingerprint,
    staleDevices: files.filter((file) => !isActiveDeviceFile(file, now)).map((file) => ({
      fileId: file.id,
      deviceId: deviceIdFromFile(file),
      modifiedTime: file.modifiedTime || null,
    })),
    workspaceId: SERVER_SYNC_WORKSPACE_ID,
  };
}

async function readE2eeMetadata(env, googleSub) {
  return env.DB.prepare(
    `SELECT workspace_id, key_id, e2ee_status, legacy_fingerprint,
            cutover_lock_token, cutover_lock_expires_at, cutover_verified_at
       FROM taskliner_users WHERE google_sub = ?1`,
  ).bind(googleSub).first();
}

function publicE2ee(row) {
  return {
    status: row?.e2ee_status || "legacy",
    workspaceId: row?.workspace_id || null,
    keyId: row?.key_id || null,
    lockExpiresAt: row?.e2ee_status === "migrating" ? row?.cutover_lock_expires_at || null : null,
  };
}

export async function getE2eeStatus(env, user) {
  return publicE2ee(await readE2eeMetadata(env, user.google_sub));
}

export async function getLegacyInventory(env, user) {
  const { files } = await allDriveFiles(env, user);
  const legacyFiles = files.filter(legacyFile);
  return { fingerprint: fileFingerprint(legacyFiles), count: legacyFiles.length };
}

export async function putDeviceState(env, user, state) {
  const metadata = await readE2eeMetadata(env, user.google_sub);
  if (["migrating", "encrypted-active"].includes(metadata?.e2ee_status)) {
    validationError("Plaintext sync is disabled for this account", 409, "e2ee_upgrade_required");
  }
  validateState(state);
  const snapshot = await getSyncSnapshot(env, user);
  const current = await readE2eeMetadata(env, user.google_sub);
  if (["migrating", "encrypted-active"].includes(current?.e2ee_status)) {
    validationError("Plaintext sync is disabled for this account", 409, "e2ee_upgrade_required");
  }
  const existing = snapshot.files.find((file) => deviceIdFromFile(file) === state.deviceId);
  await writeTasklinerFile(snapshot.accessToken, { fileId: existing?.id || null, deviceId: state.deviceId, state });
  return getSyncSnapshot(env, user);
}

export async function initializeE2eeWorkspace(env, user, { workspaceId, keyId }, { now = Date.now() } = {}) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof keyId !== "string" || !keyId) validationError("workspaceId and keyId are required");
  const current = await readE2eeMetadata(env, user.google_sub);
  if (current?.e2ee_status === "encrypted-active") {
    if (current.workspace_id === workspaceId && current.key_id === keyId) return publicE2ee(current);
    validationError("A different encrypted workspace is already initialized", 409, "workspace_initialized");
  }
  const currentExpiry = Date.parse(current?.cutover_lock_expires_at || "");
  if (current?.e2ee_status === "migrating" && currentExpiry > now) validationError("Another initialization is in progress", 409, "migration_locked");

  const lockToken = newLockToken();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + MIGRATION_LOCK_MS).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE taskliner_users
        SET workspace_id = ?1, key_id = ?2, e2ee_status = 'migrating', legacy_fingerprint = NULL,
            cutover_lock_token = ?3, cutover_lock_expires_at = ?4, cutover_verified_at = NULL, updated_at = ?5
      WHERE google_sub = ?6
        AND (e2ee_status IS NULL OR e2ee_status = 'legacy'
             OR (e2ee_status = 'migrating' AND (cutover_lock_expires_at IS NULL OR cutover_lock_expires_at <= ?5)))`,
  ).bind(workspaceId, keyId, lockToken, expiresAt, nowIso, user.google_sub).run();
  if (changes(claimed) !== 1) validationError("Another initialization is in progress", 409, "migration_locked");

  let inventory;
  try {
    inventory = await allDriveFiles(env, user);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE taskliner_users SET workspace_id = NULL, key_id = NULL, e2ee_status = 'legacy',
              cutover_lock_token = NULL, cutover_lock_expires_at = NULL, updated_at = ?1
        WHERE google_sub = ?2 AND cutover_lock_token = ?3`,
    ).bind(new Date().toISOString(), user.google_sub, lockToken).run();
    throw error;
  }
  if (inventory.files.some(legacyFile)) {
    await env.DB.prepare(
      `UPDATE taskliner_users SET workspace_id = NULL, key_id = NULL, e2ee_status = 'legacy',
              cutover_lock_token = NULL, cutover_lock_expires_at = NULL, updated_at = ?1
        WHERE google_sub = ?2 AND cutover_lock_token = ?3`,
    ).bind(new Date().toISOString(), user.google_sub, lockToken).run();
    validationError("Legacy state exists and must be migrated", 409, "legacy_exists");
  }

  const activatedAt = new Date().toISOString();
  const activated = await env.DB.prepare(
    `UPDATE taskliner_users SET e2ee_status = 'encrypted-active', cutover_lock_token = NULL,
            cutover_lock_expires_at = NULL, cutover_verified_at = ?1, updated_at = ?1
      WHERE google_sub = ?2 AND e2ee_status = 'migrating' AND cutover_lock_token = ?3`,
  ).bind(activatedAt, user.google_sub, lockToken).run();
  if (changes(activated) !== 1) validationError("Initialization claim changed", 409, "migration_lock_mismatch");
  return { status: "encrypted-active", workspaceId, keyId };
}

export async function beginE2eeWorkspaceInitialization(env, user, { workspaceId, keyId }, { now = Date.now() } = {}) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof keyId !== "string" || !keyId) {
    validationError("workspaceId and keyId are required");
  }
  const current = await readE2eeMetadata(env, user.google_sub);
  if (current?.e2ee_status === "encrypted-active") {
    if (current.workspace_id === workspaceId && current.key_id === keyId) return { status: "encrypted-active", workspaceId, keyId };
    validationError("A different encrypted workspace is already initialized", 409, "workspace_initialized");
  }
  const currentExpiry = Date.parse(current?.cutover_lock_expires_at || "");
  if (current?.e2ee_status === "migrating" && currentExpiry > now) {
    validationError("Another initialization is in progress", 409, "migration_locked");
  }
  const lockToken = newLockToken();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + MIGRATION_LOCK_MS).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE taskliner_users
        SET workspace_id = ?1, key_id = ?2, e2ee_status = 'migrating', legacy_fingerprint = NULL,
            cutover_lock_token = ?3, cutover_lock_expires_at = ?4, cutover_verified_at = NULL, updated_at = ?5
      WHERE google_sub = ?6
        AND (e2ee_status IS NULL OR e2ee_status = 'legacy'
             OR (e2ee_status = 'migrating' AND (cutover_lock_expires_at IS NULL OR cutover_lock_expires_at <= ?5)))`,
  ).bind(workspaceId, keyId, lockToken, expiresAt, nowIso, user.google_sub).run();
  if (changes(claimed) !== 1) validationError("Another initialization is in progress", 409, "migration_locked");
  try {
    const inventory = await allDriveFiles(env, user);
    if (inventory.files.some(legacyFile)) validationError("Legacy state exists and must be migrated", 409, "legacy_exists");
  } catch (error) {
    await env.DB.prepare(
      `UPDATE taskliner_users SET workspace_id = NULL, key_id = NULL, e2ee_status = 'legacy',
              cutover_lock_token = NULL, cutover_lock_expires_at = NULL, updated_at = ?1
        WHERE google_sub = ?2 AND cutover_lock_token = ?3`,
    ).bind(new Date(now).toISOString(), user.google_sub, lockToken).run();
    throw error;
  }
  return { status: "migrating", workspaceId, keyId, lockToken, lockExpiresAt: expiresAt };
}

export async function finalizeE2eeWorkspaceInitialization(env, user, {
  lockToken, workspaceId, keyId, verifiedDeviceId, requirePasskey = false,
}, { now = Date.now() } = {}) {
  if (![lockToken, workspaceId, keyId, verifiedDeviceId].every((value) => typeof value === "string" && value)) {
    validationError("lockToken, workspaceId, keyId, and verifiedDeviceId are required");
  }
  const metadata = await readE2eeMetadata(env, user.google_sub);
  if (metadata?.e2ee_status === "encrypted-active" && metadata.workspace_id === workspaceId && metadata.key_id === keyId) {
    return { status: "encrypted-active", workspaceId, keyId };
  }
  if (metadata?.e2ee_status !== "migrating" || metadata.workspace_id !== workspaceId || metadata.key_id !== keyId
      || metadata.cutover_lock_token !== lockToken) {
    validationError("Initialization lock does not match", 409, "migration_lock_mismatch");
  }
  if (Date.parse(metadata.cutover_lock_expires_at || "") <= now) validationError("Initialization lock expired", 409, "migration_lock_expired");
  const snapshot = await getV3Snapshot(env, user, { kind: "key-wrapper", now });
  const wrappers = snapshot.artifacts || [];
  if (!wrappers.some(({ payload }) => payload?.workspaceId === workspaceId && payload?.keyId === keyId && payload?.kind === "recovery")) {
    validationError("Recovery wrapper is missing", 409, "initialization_artifact_missing");
  }
  if (requirePasskey && !wrappers.some(({ payload }) => payload?.workspaceId === workspaceId && payload?.keyId === keyId && payload?.kind === "passkey-prf")) {
    validationError("Passkey wrapper is missing", 409, "initialization_artifact_missing");
  }
  const devices = await getV3Snapshot(env, user, { kind: "device-envelope", artifactId: verifiedDeviceId, now });
  if (!devices.artifacts?.some(({ payload }) => payload?.workspaceId === workspaceId && payload?.keyId === keyId)) {
    validationError("Device envelope is missing", 409, "initialization_artifact_missing");
  }
  const activatedAt = new Date(now).toISOString();
  const activated = await env.DB.prepare(
    `UPDATE taskliner_users SET e2ee_status = 'encrypted-active', cutover_lock_token = NULL,
            cutover_lock_expires_at = NULL, cutover_verified_at = ?1, updated_at = ?1
      WHERE google_sub = ?2 AND e2ee_status = 'migrating' AND workspace_id = ?3 AND key_id = ?4 AND cutover_lock_token = ?5
        AND cutover_lock_expires_at > ?1`,
  ).bind(activatedAt, user.google_sub, workspaceId, keyId, lockToken).run();
  if (changes(activated) !== 1) validationError("Initialization lock changed", 409, "migration_lock_mismatch");
  return { status: "encrypted-active", workspaceId, keyId };
}

function publicArtifact(file, descriptor, payload) {
  return {
    fileId: file.id,
    kind: descriptor.kind,
    artifactId: descriptor.artifactId,
    modifiedTime: file.modifiedTime || null,
    version: file.version || null,
    payload,
  };
}

function artifactFiles(files, { kind = null, artifactId = null } = {}) {
  return files.flatMap((file) => {
    const descriptor = artifactFromFile(file);
    if (!descriptor || (kind && descriptor.kind !== kind) || (artifactId && descriptor.artifactId !== artifactId)) return [];
    return [{ file, descriptor }];
  });
}

export function isActiveV3ArtifactFile(file, descriptor, now = Date.now()) {
  if (descriptor?.kind !== "device-envelope" && descriptor?.kind !== "shared-setting") return true;
  return isActiveDeviceFile(file, now);
}

function assertWorkspace(metadata, payload) {
  if (!payload?.workspaceId || !payload?.keyId) return;
  if (metadata?.workspace_id && metadata.workspace_id !== payload.workspaceId) validationError("Workspace id mismatch", 409, "workspace_mismatch");
  if (metadata?.key_id && metadata.key_id !== payload.keyId) validationError("Key id mismatch", 409, "key_mismatch");
}

export async function getV3Snapshot(env, user, { kind = null, artifactId = null, ifNoneMatch = null, now = Date.now() } = {}) {
  const [{ accessToken, files }, metadata] = await Promise.all([allDriveFiles(env, user), readE2eeMetadata(env, user.google_sub)]);
  const selected = artifactFiles(files, { kind, artifactId })
    .filter(({ file, descriptor }) => isActiveV3ArtifactFile(file, descriptor, now));
  const fingerprint = fileFingerprint(selected.map(({ file }) => file));
  if (ifNoneMatch && unquoteEtag(ifNoneMatch) === fingerprint) return { notModified: true, fingerprint, e2ee: publicE2ee(metadata) };
  const artifacts = [];
  for (const { file, descriptor } of selected) {
    if (Number(file.size) > MAX_SYNC_ARTIFACT_BYTES) validationError("Sync artifact is too large", 400, "artifact_too_large");
    const payload = await downloadFile(accessToken, file.id);
    try {
      validateArtifactPayload(descriptor.kind, descriptor.artifactId, payload, { now });
    } catch (error) {
      if (error?.code === "invalid_expiry") {
        await deleteFile(accessToken, file.id);
        continue;
      }
      throw error;
    }
    assertWorkspace(metadata, payload);
    artifacts.push(publicArtifact(file, descriptor, payload));
  }
  return { artifacts, fingerprint, e2ee: publicE2ee(metadata) };
}

export async function putSyncArtifact(env, user, { kind, artifactId, payload }, { now = Date.now() } = {}) {
  validateArtifactPayload(kind, artifactId, payload, { now });
  const metadata = await readE2eeMetadata(env, user.google_sub);
  if (metadata?.e2ee_status !== "migrating" && metadata?.e2ee_status !== "encrypted-active") {
    validationError("E2EE initialization is required", 409, "e2ee_initialization_required");
  }
  assertWorkspace(metadata, payload);
  const { accessToken, files } = await allDriveFiles(env, user);
  const existing = artifactFiles(files, { kind, artifactId })[0]?.file;
  const file = await writeSyncArtifact(accessToken, { fileId: existing?.id || null, kind, artifactId, payload });
  return {
    artifact: publicArtifact(file, { kind, artifactId }, payload),
    fingerprint: fileFingerprint([...files.filter((candidate) => candidate.id !== existing?.id), file].filter((candidate) => artifactFromFile(candidate))),
    e2ee: publicE2ee(metadata),
  };
}

export async function deleteSyncArtifact(env, user, { kind, artifactId }) {
  const { accessToken, files } = await allDriveFiles(env, user);
  const matches = artifactFiles(files, { kind, artifactId });
  await Promise.all(matches.map(({ file }) => deleteFile(accessToken, file.id)));
  return { deleted: matches.length };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function migrationAad(fingerprint) {
  return textEncoder.encode(JSON.stringify({ format: "taskliner-v2-migration-bundle", version: 1, fingerprint }));
}

export async function encryptLegacyMigrationBundle(states, fingerprint, migrationPublicKey) {
  if (!migrationPublicKey || migrationPublicKey.kty !== "EC" || migrationPublicKey.crv !== "P-256" || migrationPublicKey.d) {
    validationError("Invalid migration public key", 400, "invalid_migration_key");
  }
  let clientPublicKey;
  try {
    clientPublicKey = await crypto.subtle.importKey("jwk", migrationPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    validationError("Invalid migration public key", 400, "invalid_migration_key");
  }
  const serverKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: clientPublicKey }, serverKeyPair.privateKey, 256);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: textEncoder.encode("taskliner-v2-migration-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const plaintext = textEncoder.encode(JSON.stringify({ states }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: migrationAad(fingerprint) }, key, plaintext);
  return {
    format: "taskliner-v2-migration-bundle",
    version: 1,
    fingerprint,
    serverPublicKey: await crypto.subtle.exportKey("jwk", serverKeyPair.publicKey),
    salt: base64Url(salt),
    nonce: base64Url(nonce),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
  };
}

function newLockToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(24)));
}

function changes(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

export async function beginE2eeMigration(env, user, {
  workspaceId,
  keyId,
  expectedFingerprint,
  migrationPublicKey,
}, { now = Date.now() } = {}) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof keyId !== "string" || !keyId) validationError("workspaceId and keyId are required");
  const current = await readE2eeMetadata(env, user.google_sub);
  if (current?.e2ee_status === "encrypted-active") validationError("E2EE is already active", 409, "already_encrypted");
  const currentExpiry = Date.parse(current?.cutover_lock_expires_at || "");
  if (current?.e2ee_status === "migrating" && currentExpiry > now) validationError("Another migration is in progress", 409, "migration_locked");

  const snapshot = await getSyncSnapshot(env, user);
  if (current?.e2ee_status === "migrating") {
    const sameKey = current.workspace_id === workspaceId && current.key_id === keyId;
    if (current.cutover_verified_at && !sameKey) validationError("Migration key changed", 409, "migration_key_changed");
    if (!current.cutover_verified_at && expectedFingerprint !== snapshot.fingerprint) {
      validationError("Legacy state changed", 409, "legacy_changed");
    }
    if (current.cutover_verified_at && (expectedFingerprint !== current.legacy_fingerprint || snapshot.fingerprint !== current.legacy_fingerprint)) {
      validationError("Legacy state changed", 409, "legacy_changed");
    }
  } else if (expectedFingerprint !== snapshot.fingerprint) {
    validationError("Legacy state changed", 409, "legacy_changed");
  }
  const lockToken = newLockToken();
  const expiresAt = new Date(now + MIGRATION_LOCK_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const deletionPending = Boolean(current?.cutover_verified_at);
  const legacyFingerprint = deletionPending ? current.legacy_fingerprint : snapshot.fingerprint;
  const legacyBundle = deletionPending
    ? null
    : await encryptLegacyMigrationBundle(snapshot.devices.map(({ state }) => state), legacyFingerprint, migrationPublicKey);
  const result = await env.DB.prepare(
    `UPDATE taskliner_users
        SET workspace_id = ?1, key_id = ?2, e2ee_status = 'migrating', legacy_fingerprint = ?3,
            cutover_lock_token = ?4, cutover_lock_expires_at = ?5, updated_at = ?6
      WHERE google_sub = ?7
        AND (e2ee_status IS NULL OR e2ee_status = 'legacy'
             OR (e2ee_status = 'migrating' AND (cutover_lock_expires_at IS NULL OR cutover_lock_expires_at <= ?6)))`,
  ).bind(workspaceId, keyId, legacyFingerprint, lockToken, expiresAt, nowIso, user.google_sub).run();
  if (changes(result) !== 1) validationError("Another migration is in progress", 409, "migration_locked");

  if (!deletionPending) {
    try {
      await Promise.all(snapshot.allFiles
        .filter((file) => artifactFromFile(file))
        .map((file) => deleteFile(snapshot.accessToken, file.id)));
    } catch (error) {
      await env.DB.prepare(
        `UPDATE taskliner_users SET workspace_id = NULL, key_id = NULL, e2ee_status = 'legacy',
                legacy_fingerprint = NULL, cutover_lock_token = NULL, cutover_lock_expires_at = NULL,
                cutover_verified_at = NULL, updated_at = ?1
          WHERE google_sub = ?2 AND cutover_lock_token = ?3`,
      ).bind(new Date().toISOString(), user.google_sub, lockToken).run();
      throw error;
    }
  }

  return {
    status: "migrating",
    workspaceId,
    keyId,
    lockToken,
    lockExpiresAt: expiresAt,
    legacyFingerprint,
    deletionPending,
    legacyBundle,
  };
}

export async function activateE2eeMigration(env, user, { lockToken, expectedFingerprint, verifiedV3Fingerprint }, { now = Date.now() } = {}) {
  const metadata = await readE2eeMetadata(env, user.google_sub);
  if (metadata?.e2ee_status !== "migrating" || !lockToken || metadata.cutover_lock_token !== lockToken) {
    validationError("Migration lock does not match", 409, "migration_lock_mismatch");
  }
  if (Date.parse(metadata.cutover_lock_expires_at || "") <= now) validationError("Migration lock expired", 409, "migration_lock_expired");
  if (expectedFingerprint !== metadata.legacy_fingerprint) validationError("Legacy fingerprint does not match", 409, "legacy_changed");

  let snapshot = await getSyncSnapshot(env, user);
  if (!metadata.cutover_verified_at) {
    if (snapshot.fingerprint !== metadata.legacy_fingerprint) validationError("Legacy state changed", 409, "legacy_changed");
    const v3 = await getV3Snapshot(env, user, { kind: "device-envelope", now });
    if (!v3.artifacts.length) validationError("No verified v3 device envelope exists", 409, "v3_missing");
    if (!verifiedV3Fingerprint || verifiedV3Fingerprint !== v3.fingerprint) validationError("Verified v3 fingerprint changed", 409, "v3_changed");
    await env.DB.prepare(
      "UPDATE taskliner_users SET cutover_verified_at = ?1, updated_at = ?1 WHERE google_sub = ?2 AND cutover_lock_token = ?3",
    ).bind(new Date(now).toISOString(), user.google_sub, lockToken).run();
  }

  const deletedLegacyFiles = snapshot.files.length;
  await Promise.all(snapshot.files.map((file) => deleteFile(snapshot.accessToken, file.id)));
  snapshot = await getSyncSnapshot(env, user);
  if (snapshot.files.length) validationError("Legacy files remain", 503, "legacy_delete_incomplete");
  const completedAt = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE taskliner_users
        SET e2ee_status = 'encrypted-active', cutover_lock_token = NULL,
            cutover_lock_expires_at = NULL, cutover_verified_at = ?1, updated_at = ?1
      WHERE google_sub = ?2 AND e2ee_status = 'migrating' AND cutover_lock_token = ?3`,
  ).bind(completedAt, user.google_sub, lockToken).run();
  if (changes(result) !== 1) validationError("Migration lock changed", 409, "migration_lock_mismatch");
  return { status: "encrypted-active", workspaceId: metadata.workspace_id, keyId: metadata.key_id, deletedLegacyFiles };
}

export async function deleteTasklinerData(env, user) {
  const snapshot = await allDriveFiles(env, user);
  await Promise.all(snapshot.files.map((file) => deleteFile(snapshot.accessToken, file.id)));
  await env.DB.prepare(
    `UPDATE taskliner_users
        SET workspace_id = NULL, key_id = NULL, e2ee_status = 'legacy', legacy_fingerprint = NULL,
            cutover_lock_token = NULL, cutover_lock_expires_at = NULL, cutover_verified_at = NULL
      WHERE google_sub = ?1`,
  ).bind(user.google_sub).run();
  return { deleted: snapshot.files.length };
}
