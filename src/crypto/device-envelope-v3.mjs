import {
  assertPlainObject,
  base64urlDecode,
  base64urlEncode,
  decodeUtf8,
  importAesKey,
  jsonBytes,
  randomBytes,
  requireId,
  webCrypto,
} from "./e2ee-utils.mjs";

export const DEVICE_ENVELOPE_FORMAT = "taskliner-device-envelope";
export const DEVICE_ENVELOPE_VERSION = 3;
export const DEVICE_CIPHER_ALGORITHM = "AES-GCM-256";

export function generateWorkspaceDataKey() {
  return randomBytes(32);
}

export function canonicalDeviceEnvelopeHeader({ workspaceId, keyId, deviceId }) {
  return {
    format: DEVICE_ENVELOPE_FORMAT,
    version: DEVICE_ENVELOPE_VERSION,
    workspaceId: requireId(workspaceId, "workspaceId"),
    keyId: requireId(keyId, "keyId"),
    deviceId: requireId(deviceId, "deviceId"),
  };
}

export function deviceEnvelopeAad(header) {
  return jsonBytes(canonicalDeviceEnvelopeHeader(header));
}

export function validateDeviceEnvelopeOuter(envelope) {
  assertPlainObject(envelope, "device envelope");
  const header = canonicalDeviceEnvelopeHeader(envelope);
  if (envelope.format !== DEVICE_ENVELOPE_FORMAT || envelope.version !== DEVICE_ENVELOPE_VERSION) {
    throw new Error("Unsupported Taskliner device envelope");
  }
  assertPlainObject(envelope.cipher, "device envelope cipher");
  if (envelope.cipher.algorithm !== DEVICE_CIPHER_ALGORITHM) throw new Error("Unsupported device envelope cipher");
  const nonce = base64urlDecode(envelope.cipher.nonce, "device envelope nonce");
  if (nonce.length !== 12) throw new Error("Device envelope nonce must be 12 bytes");
  const ciphertext = base64urlDecode(envelope.cipher.ciphertext, "device envelope ciphertext");
  if (ciphertext.length < 17) throw new Error("Device envelope ciphertext is too short");
  return { header, nonce, ciphertext };
}

export async function encryptDeviceState(deviceState, { workspaceId, keyId, deviceId, wdk } = {}) {
  const header = canonicalDeviceEnvelopeHeader({ workspaceId, keyId, deviceId });
  assertPlainObject(deviceState, "device state");
  if (deviceState.workspaceId !== header.workspaceId || deviceState.deviceId !== header.deviceId) {
    throw new Error("Device state identity does not match envelope header");
  }
  const iv = randomBytes(12);
  const key = await importAesKey(wdk);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: deviceEnvelopeAad(header) },
    key,
    jsonBytes(deviceState)
  );
  return {
    ...header,
    cipher: {
      algorithm: DEVICE_CIPHER_ALGORITHM,
      nonce: base64urlEncode(iv),
      ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
    },
  };
}

export async function decryptDeviceState(
  envelope,
  wdk,
  { expectedWorkspaceId, expectedKeyId, expectedDeviceId, validate } = {}
) {
  if (typeof validate !== "function") throw new Error("A decrypted device state validator is required");
  const { header, nonce, ciphertext } = validateDeviceEnvelopeOuter(envelope);
  if (expectedWorkspaceId != null && header.workspaceId !== expectedWorkspaceId) throw new Error("Unexpected workspaceId");
  if (expectedKeyId != null && header.keyId !== expectedKeyId) throw new Error("Unexpected keyId");
  if (expectedDeviceId != null && header.deviceId !== expectedDeviceId) throw new Error("Unexpected deviceId");
  const key = await importAesKey(wdk);
  let plaintext;
  try {
    plaintext = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: deviceEnvelopeAad(header) },
      key,
      ciphertext
    );
  } catch {
    throw new Error("Device envelope authentication failed");
  }
  let state;
  try {
    state = JSON.parse(decodeUtf8(plaintext));
  } catch {
    throw new Error("Decrypted device state is not valid JSON");
  }
  assertPlainObject(state, "decrypted device state");
  if (state.workspaceId !== header.workspaceId || state.deviceId !== header.deviceId) {
    throw new Error("Decrypted device state identity does not match envelope header");
  }
  const result = validate(state);
  if (result !== true && result?.ok !== true) throw new Error("Decrypted device state failed validation");
  return state;
}
