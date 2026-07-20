export const SYNC_V3_VERSION = 3;
export const MAX_SYNC_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_PAIRING_LIFETIME_MS = 10 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const SYNC_ARTIFACT_KINDS = Object.freeze([
  "device-envelope",
  "key-wrapper",
  "shared-setting",
  "pairing-offer",
  "pairing-request",
  "pairing-response",
]);

const DEFINITIONS = Object.freeze({
  "device-envelope": { prefix: "taskliner-device-v3.", suffix: ".json", version: "3" },
  "key-wrapper": { prefix: "taskliner-key-wrapper-v1.", suffix: ".json", version: "1" },
  "shared-setting": { prefix: "taskliner-shared-setting-v1.", suffix: ".json", version: "1" },
  "pairing-offer": { prefix: "taskliner-pairing-offer-v1.", suffix: ".json", version: "1" },
  "pairing-request": { prefix: "taskliner-pairing-request-v1.", suffix: ".json", version: "1" },
  "pairing-response": { prefix: "taskliner-pairing-response-v1.", suffix: ".json", version: "1" },
});

function invalid(message, code = "invalid_artifact") {
  throw Object.assign(new Error(message), { status: 400, code });
}

function requireString(value, name, { max = 256, pattern = null } = {}) {
  if (typeof value !== "string" || !value || value.length > max || (pattern && !pattern.test(value))) {
    invalid(`Invalid ${name}`);
  }
  return value;
}

function base64urlByteLength(value, name) {
  requireString(value, name, { max: MAX_SYNC_ARTIFACT_BYTES * 2, pattern: BASE64URL_PATTERN });
  if (value.length % 4 === 1) invalid(`Invalid ${name}`);
  return Math.floor((value.length * 6) / 8);
}

function requireBase64urlBytes(value, name, { exact = null, min = 0, max = MAX_SYNC_ARTIFACT_BYTES } = {}) {
  const length = base64urlByteLength(value, name);
  if ((exact != null && length !== exact) || length < min || length > max) invalid(`Invalid ${name}`);
}

function requireExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`Unexpected ${name} field: ${key}`);
  }
}

function requireCipher(cipher) {
  if (!cipher || typeof cipher !== "object" || Array.isArray(cipher)) invalid("Invalid cipher");
  requireExactKeys(cipher, ["algorithm", "nonce", "ciphertext"], "cipher");
  if (cipher.algorithm !== "AES-GCM-256") invalid("Unsupported cipher algorithm");
  requireBase64urlBytes(cipher.nonce, "cipher nonce", { exact: 12 });
  requireBase64urlBytes(cipher.ciphertext, "ciphertext", { min: 16 });
}

function validateDeviceEnvelope(payload, artifactId) {
  requireExactKeys(payload, ["format", "version", "workspaceId", "keyId", "deviceId", "cipher"], "device envelope");
  if (payload.format !== "taskliner-device-envelope" || payload.version !== SYNC_V3_VERSION) invalid("Invalid device envelope format");
  requireString(payload.workspaceId, "workspaceId", { max: 128, pattern: ID_PATTERN });
  requireString(payload.keyId, "keyId", { max: 128, pattern: ID_PATTERN });
  requireString(payload.deviceId, "deviceId", { max: 128, pattern: ID_PATTERN });
  if (payload.deviceId !== artifactId) invalid("Device envelope id mismatch");
  requireCipher(payload.cipher);
}

function validateEncryptedArtifact(payload, artifactId, expectedFormat) {
  if (payload.format !== expectedFormat || payload.version !== 1) invalid(`Invalid ${expectedFormat} format`);
  requireString(payload.workspaceId, "workspaceId", { max: 128, pattern: ID_PATTERN });
  requireString(payload.keyId, "keyId", { max: 128, pattern: ID_PATTERN });
  const payloadId = payload.wrapperId || payload.settingId || payload.artifactId;
  if (payloadId != null && payloadId !== artifactId) invalid("Artifact id mismatch");
  requireCipher(payload.cipher);
}

function validateKeyWrapper(payload, artifactId) {
  requireExactKeys(payload, ["format", "version", "workspaceId", "keyId", "wrapperId", "kind", "metadata", "cipher"], "key wrapper");
  validateEncryptedArtifact(payload, artifactId, "taskliner-key-wrapper");
  if (payload.wrapperId !== artifactId) invalid("Key wrapper id mismatch");
  if (!["passkey-prf", "recovery"].includes(payload.kind)) invalid("Invalid key wrapper kind");
  if (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata)) invalid("Invalid key wrapper metadata");
  if (payload.metadata.kdf !== "HKDF-SHA-256") invalid("Invalid key wrapper KDF");
  if (payload.kind === "passkey-prf") {
    requireExactKeys(payload.metadata, ["credentialId", "kdf", "prfSalt"], "passkey metadata");
    requireString(payload.metadata.credentialId, "credentialId", { max: 1024, pattern: BASE64URL_PATTERN });
    requireBase64urlBytes(payload.metadata.prfSalt, "PRF salt", { exact: 32 });
  } else {
    requireExactKeys(payload.metadata, ["kdf", "salt"], "recovery metadata");
    requireBase64urlBytes(payload.metadata.salt, "recovery salt", { exact: 32 });
  }
}

function validatePairingArtifact(payload, artifactId, now) {
  if (payload.format !== "taskliner-pairing-artifact" || payload.version !== 1) invalid("Invalid pairing artifact format");
  if (payload.kind !== payload.__expectedKind) invalid("Pairing kind mismatch");
  const common = ["format", "version", "kind", "pairingId", "workspaceId", "keyId", "accountIdHash", "expiresAt", "__expectedKind"];
  requireBase64urlBytes(payload.pairingId, "pairingId", { exact: 32 });
  requireString(payload.workspaceId, "workspaceId", { max: 128, pattern: ID_PATTERN });
  requireString(payload.keyId, "keyId", { max: 128, pattern: ID_PATTERN });
  requireBase64urlBytes(payload.accountIdHash, "accountIdHash", { exact: 32 });
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + MAX_PAIRING_LIFETIME_MS) {
    invalid("Invalid pairing expiry", "invalid_expiry");
  }
  if (payload.kind === "pairing-offer") {
    requireExactKeys(payload, [...common, "offerId", "inviterDeviceId", "inviterDeviceName", "inviterPublicKey", "createdAt", "proof"], "pairing offer");
    if (payload.offerId !== artifactId) invalid("Pairing offer id mismatch");
    requireString(payload.inviterDeviceId, "inviterDeviceId", { max: 128, pattern: ID_PATTERN });
    requireString(payload.inviterDeviceName, "inviterDeviceName", { max: 128 });
    validatePairingPublicKey(payload.inviterPublicKey);
    requireBase64urlBytes(payload.proof, "pairing offer proof", { exact: 32 });
    if (!Number.isSafeInteger(payload.createdAt) || payload.createdAt > payload.expiresAt
        || payload.expiresAt - payload.createdAt > MAX_PAIRING_LIFETIME_MS) invalid("Invalid pairing creation time");
  } else if (payload.kind === "pairing-request") {
    requireExactKeys(payload, [...common, "requestId", "offerId", "requesterDeviceId", "requesterDeviceName", "requesterPublicKey", "createdAt", "proof"], "pairing request");
    if (payload.requestId !== artifactId) invalid("Pairing request id mismatch");
    requireString(payload.offerId, "offerId", { max: 128, pattern: ID_PATTERN });
    requireString(payload.requesterDeviceId, "requesterDeviceId", { max: 128, pattern: ID_PATTERN });
    requireString(payload.requesterDeviceName, "requesterDeviceName", { max: 128 });
    validatePairingPublicKey(payload.requesterPublicKey);
    requireBase64urlBytes(payload.proof, "pairing proof", { exact: 32 });
    if (!Number.isSafeInteger(payload.createdAt) || payload.createdAt > payload.expiresAt) invalid("Invalid pairing creation time");
  } else {
    requireExactKeys(payload, [...common, "responseId", "requestId", "offerId", "approvedAt", "cipher"], "pairing response");
    if (payload.responseId !== artifactId) invalid("Pairing response id mismatch");
    requireString(payload.requestId, "requestId", { max: 128, pattern: ID_PATTERN });
    requireString(payload.offerId, "offerId", { max: 128, pattern: ID_PATTERN });
    if (!Number.isSafeInteger(payload.approvedAt) || payload.approvedAt > payload.expiresAt) invalid("Invalid pairing approval time");
    requireCipher(payload.cipher);
    if (base64urlByteLength(payload.cipher.ciphertext, "pairing ciphertext") !== 48) invalid("Invalid pairing ciphertext");
  }
}

function validatePairingPublicKey(key) {
  if (!key || typeof key !== "object" || Array.isArray(key)) invalid("Invalid pairing public key");
  requireExactKeys(key, ["kty", "crv", "x", "y", "ext", "key_ops"], "pairing public key");
  if (key.kty !== "EC" || key.crv !== "P-256" || key.ext !== true || !Array.isArray(key.key_ops) || key.key_ops.length) {
    invalid("Invalid pairing public key");
  }
  requireBase64urlBytes(key.x, "pairing public key x", { exact: 32 });
  requireBase64urlBytes(key.y, "pairing public key y", { exact: 32 });
}

export function isSyncArtifactKind(kind) {
  return Object.hasOwn(DEFINITIONS, kind);
}

export function assertArtifactId(artifactId) {
  return requireString(artifactId, "artifactId", { max: 128, pattern: ID_PATTERN });
}

export function artifactFileName(kind, artifactId) {
  if (!isSyncArtifactKind(kind)) invalid("Unsupported sync artifact kind", "invalid_kind");
  assertArtifactId(artifactId);
  const definition = DEFINITIONS[kind];
  return `${definition.prefix}${artifactId}${definition.suffix}`;
}

export function artifactFromFile(file) {
  const propertyKind = file?.appProperties?.kind;
  const propertyId = file?.appProperties?.artifactId;
  if (isSyncArtifactKind(propertyKind) && ID_PATTERN.test(propertyId || "")) return { kind: propertyKind, artifactId: propertyId };
  for (const [kind, definition] of Object.entries(DEFINITIONS)) {
    const name = file?.name || "";
    if (!name.startsWith(definition.prefix) || !name.endsWith(definition.suffix)) continue;
    const artifactId = name.slice(definition.prefix.length, -definition.suffix.length);
    if (ID_PATTERN.test(artifactId)) return { kind, artifactId };
  }
  return null;
}

export function artifactAppProperties(kind, artifactId) {
  const definition = DEFINITIONS[kind];
  if (!definition) invalid("Unsupported sync artifact kind", "invalid_kind");
  return { taskliner: "sync", kind, artifactId: assertArtifactId(artifactId), version: definition.version };
}

export function validateArtifactPayload(kind, artifactId, payload, { now = Date.now() } = {}) {
  if (!isSyncArtifactKind(kind)) invalid("Unsupported sync artifact kind", "invalid_kind");
  assertArtifactId(artifactId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid("Invalid artifact payload");
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SYNC_ARTIFACT_BYTES) invalid("Sync artifact is too large", "artifact_too_large");
  if (kind === "device-envelope") validateDeviceEnvelope(payload, artifactId);
  else if (kind === "key-wrapper") validateKeyWrapper(payload, artifactId);
  else if (kind === "shared-setting") {
    requireExactKeys(payload, ["format", "version", "workspaceId", "keyId", "settingId", "cipher"], "shared setting");
    validateEncryptedArtifact(payload, artifactId, "taskliner-shared-setting");
    if (payload.settingId !== artifactId) invalid("Shared setting id mismatch");
  }
  else validatePairingArtifact({ ...payload, __expectedKind: kind }, artifactId, now);
  return payload;
}

export function isV3SyncEnabled(env, requestUrl = "https://taskliner.app/") {
  const flag = String(env?.TASKLINER_SYNC_V3 || "").toLowerCase();
  if (["1", "true", "enabled"].includes(flag)) return true;
  if (flag !== "preview") return false;
  const host = new URL(requestUrl).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".pages.dev");
}

export function assertMutationOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) throw Object.assign(new Error("Origin header is required"), { status: 403, code: "origin_required" });
  const allowed = new Set([new URL(request.url).origin]);
  for (const value of String(env?.SYNC_ALLOWED_ORIGINS || "").split(",")) {
    const trimmed = value.trim();
    if (trimmed) allowed.add(trimmed);
  }
  if (!allowed.has(origin)) throw Object.assign(new Error("Origin is not allowed"), { status: 403, code: "origin_denied" });
}
