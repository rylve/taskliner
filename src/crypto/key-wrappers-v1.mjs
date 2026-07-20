import {
  assertPlainObject,
  base64urlDecode,
  base64urlEncode,
  canonicalJsonBytes,
  deriveHkdfAesKey,
  importAesKey,
  randomBytes,
  requireId,
  toBytes,
  utf8,
  webCrypto,
} from "./e2ee-utils.mjs";
import { derivePasskeyKek, serializePasskeyPrfSalt } from "./passkey-prf.mjs";

export const KEY_WRAPPER_FORMAT = "taskliner-key-wrapper";
export const KEY_WRAPPER_VERSION = 1;
export const KEY_WRAPPER_CIPHER = "AES-GCM-256";
export const RECOVERY_FILE_FORMAT = "taskliner-recovery-key";
export const RECOVERY_FILE_VERSION = 1;
const WRAPPER_KINDS = new Set(["device-storage", "passkey-prf", "recovery"]);

export function generateRecoveryKey() {
  return randomBytes(32);
}

export async function generateDeviceStorageKey() {
  return webCrypto().subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function wrapperHeader({ workspaceId, keyId, wrapperId, kind, metadata = {} }) {
  if (!WRAPPER_KINDS.has(kind)) throw new Error("Unsupported key wrapper kind");
  assertPlainObject(metadata, "key wrapper metadata");
  return {
    format: KEY_WRAPPER_FORMAT,
    version: KEY_WRAPPER_VERSION,
    workspaceId: requireId(workspaceId, "workspaceId"),
    keyId: requireId(keyId, "keyId"),
    wrapperId: requireId(wrapperId, "wrapperId"),
    kind,
    metadata,
  };
}

export function keyWrapperAad(value) {
  return canonicalJsonBytes(wrapperHeader(value));
}

export function validateKeyWrapperOuter(wrapper) {
  assertPlainObject(wrapper, "key wrapper");
  if (wrapper.format !== KEY_WRAPPER_FORMAT || wrapper.version !== KEY_WRAPPER_VERSION) {
    throw new Error("Unsupported Taskliner key wrapper");
  }
  const header = wrapperHeader(wrapper);
  assertPlainObject(wrapper.cipher, "key wrapper cipher");
  if (wrapper.cipher.algorithm !== KEY_WRAPPER_CIPHER) throw new Error("Unsupported key wrapper cipher");
  const nonce = base64urlDecode(wrapper.cipher.nonce, "key wrapper nonce");
  const ciphertext = base64urlDecode(wrapper.cipher.ciphertext, "key wrapper ciphertext");
  if (nonce.length !== 12 || ciphertext.length !== 48) throw new Error("Invalid key wrapper cipher payload");
  return { header, nonce, ciphertext };
}

async function wrapWdk(wdk, kek, header) {
  const bytes = toBytes(wdk, "WDK");
  if (bytes.length !== 32) throw new Error("WDK must be 32 bytes");
  const key = await importAesKey(kek);
  const nonce = randomBytes(12);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: keyWrapperAad(header) },
    key,
    bytes
  );
  return {
    ...header,
    cipher: {
      algorithm: KEY_WRAPPER_CIPHER,
      nonce: base64urlEncode(nonce),
      ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
    },
  };
}

async function unwrapWdk(wrapper, kek, { expectedWorkspaceId, expectedKeyId, expectedKind } = {}) {
  const { header, nonce, ciphertext } = validateKeyWrapperOuter(wrapper);
  if (expectedWorkspaceId != null && header.workspaceId !== expectedWorkspaceId) throw new Error("Unexpected workspaceId");
  if (expectedKeyId != null && header.keyId !== expectedKeyId) throw new Error("Unexpected keyId");
  if (expectedKind != null && header.kind !== expectedKind) throw new Error("Unexpected key wrapper kind");
  try {
    return new Uint8Array(await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: keyWrapperAad(header) },
      await importAesKey(kek),
      ciphertext
    ));
  } catch {
    throw new Error("Key wrapper authentication failed");
  }
}

export function createDeviceStorageKeyWrapper({ workspaceId, keyId, wrapperId, deviceId, wdk, deviceStorageKey }) {
  return wrapWdk(wdk, deviceStorageKey, wrapperHeader({
    workspaceId,
    keyId,
    wrapperId,
    kind: "device-storage",
    metadata: { deviceId: requireId(deviceId, "deviceId") },
  }));
}

export function unwrapDeviceStorageKeyWrapper(wrapper, deviceStorageKey, expected = {}) {
  return unwrapWdk(wrapper, deviceStorageKey, { ...expected, expectedKind: "device-storage" });
}

export async function createPasskeyKeyWrapper({ workspaceId, keyId, wrapperId, credentialId, prfSalt, prfResult, wdk }) {
  const metadata = {
    credentialId: requireId(credentialId, "credentialId"),
    kdf: "HKDF-SHA-256",
    prfSalt: serializePasskeyPrfSalt(prfSalt),
  };
  const kek = await derivePasskeyKek(prfResult, { prfSalt, workspaceId, keyId });
  return wrapWdk(wdk, kek, wrapperHeader({ workspaceId, keyId, wrapperId, kind: "passkey-prf", metadata }));
}

export async function unwrapPasskeyKeyWrapper(wrapper, prfResult, expected = {}) {
  const { header } = validateKeyWrapperOuter(wrapper);
  if (header.kind !== "passkey-prf" || header.metadata.kdf !== "HKDF-SHA-256") throw new Error("Invalid passkey key wrapper");
  const kek = await derivePasskeyKek(prfResult, {
    prfSalt: header.metadata.prfSalt,
    workspaceId: header.workspaceId,
    keyId: header.keyId,
  });
  return unwrapWdk(wrapper, kek, { ...expected, expectedKind: "passkey-prf" });
}

async function deriveRecoveryKek(recoveryKey, workspaceId, keyId, salt) {
  const key = toBytes(recoveryKey, "recovery key");
  if (key.length !== 32) throw new Error("Recovery key must be 32 bytes");
  return deriveHkdfAesKey(key, {
    salt,
    info: utf8(`taskliner-recovery-kek-v1\0${requireId(workspaceId, "workspaceId")}\0${requireId(keyId, "keyId")}`),
  });
}

export async function createRecoveryKeyWrapper({ workspaceId, keyId, wrapperId, recoveryKey, wdk }) {
  const salt = randomBytes(32);
  const metadata = { kdf: "HKDF-SHA-256", salt: base64urlEncode(salt) };
  const kek = await deriveRecoveryKek(recoveryKey, workspaceId, keyId, salt);
  return wrapWdk(wdk, kek, wrapperHeader({ workspaceId, keyId, wrapperId, kind: "recovery", metadata }));
}

export async function unwrapRecoveryKeyWrapper(wrapper, recoveryKey, expected = {}) {
  const { header } = validateKeyWrapperOuter(wrapper);
  if (header.kind !== "recovery" || header.metadata.kdf !== "HKDF-SHA-256") throw new Error("Invalid recovery key wrapper");
  const salt = base64urlDecode(header.metadata.salt, "recovery wrapper salt");
  if (salt.length !== 32) throw new Error("Invalid recovery wrapper salt");
  const kek = await deriveRecoveryKek(recoveryKey, header.workspaceId, header.keyId, salt);
  return unwrapWdk(wrapper, kek, { ...expected, expectedKind: "recovery" });
}

export function createRecoveryFile({ workspaceId, keyId, recoveryKey }) {
  const key = toBytes(recoveryKey, "recovery key");
  if (key.length !== 32) throw new Error("Recovery key must be 32 bytes");
  return {
    format: RECOVERY_FILE_FORMAT,
    version: RECOVERY_FILE_VERSION,
    workspaceId: requireId(workspaceId, "workspaceId"),
    keyId: requireId(keyId, "keyId"),
    recoveryKey: base64urlEncode(key),
  };
}

export function parseRecoveryFile(file, { expectedWorkspaceId, expectedKeyId } = {}) {
  assertPlainObject(file, "recovery file");
  if (file.format !== RECOVERY_FILE_FORMAT || file.version !== RECOVERY_FILE_VERSION) throw new Error("Unsupported recovery file");
  const workspaceId = requireId(file.workspaceId, "workspaceId");
  const keyId = requireId(file.keyId, "keyId");
  if (expectedWorkspaceId != null && workspaceId !== expectedWorkspaceId) throw new Error("Unexpected workspaceId");
  if (expectedKeyId != null && keyId !== expectedKeyId) throw new Error("Unexpected keyId");
  const recoveryKey = base64urlDecode(file.recoveryKey, "recovery key");
  if (recoveryKey.length !== 32) throw new Error("Recovery key must be 32 bytes");
  return { workspaceId, keyId, recoveryKey };
}
