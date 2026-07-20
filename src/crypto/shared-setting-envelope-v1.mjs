import {
  assertPlainObject,
  base64urlDecode,
  base64urlEncode,
  canonicalJsonBytes,
  decodeUtf8,
  importAesKey,
  randomBytes,
  requireId,
  webCrypto,
} from "./e2ee-utils.mjs";

export const SHARED_SETTING_FORMAT = "taskliner-shared-setting";
export const SHARED_SETTING_VERSION = 1;

function header({ workspaceId, keyId, settingId }) {
  return {
    format: SHARED_SETTING_FORMAT,
    version: SHARED_SETTING_VERSION,
    workspaceId: requireId(workspaceId, "workspaceId"),
    keyId: requireId(keyId, "keyId"),
    settingId: requireId(settingId, "settingId"),
  };
}

export function sharedSettingAad(value) {
  return canonicalJsonBytes(header(value));
}

export async function encryptSharedSetting(payload, { workspaceId, keyId, settingId, wdk } = {}) {
  assertPlainObject(payload, "shared setting payload");
  if (payload.settingId !== settingId) throw new Error("Shared setting payload id mismatch");
  const aadHeader = header({ workspaceId, keyId, settingId });
  const nonce = randomBytes(12);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: sharedSettingAad(aadHeader) },
    await importAesKey(wdk),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    ...aadHeader,
    cipher: {
      algorithm: "AES-GCM-256",
      nonce: base64urlEncode(nonce),
      ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
    },
  };
}

export async function decryptSharedSetting(envelope, wdk, {
  expectedWorkspaceId,
  expectedKeyId,
  expectedSettingId,
  validateValue,
} = {}) {
  assertPlainObject(envelope, "shared setting envelope");
  const aadHeader = header(envelope);
  if (envelope.format !== SHARED_SETTING_FORMAT || envelope.version !== SHARED_SETTING_VERSION) throw new Error("Unsupported shared setting envelope");
  if (aadHeader.workspaceId !== expectedWorkspaceId || aadHeader.keyId !== expectedKeyId || aadHeader.settingId !== expectedSettingId) {
    throw new Error("Unexpected shared setting identity");
  }
  assertPlainObject(envelope.cipher, "shared setting cipher");
  if (envelope.cipher.algorithm !== "AES-GCM-256") throw new Error("Unsupported shared setting cipher");
  const nonce = base64urlDecode(envelope.cipher.nonce, "shared setting nonce");
  const ciphertext = base64urlDecode(envelope.cipher.ciphertext, "shared setting ciphertext");
  if (nonce.length !== 12 || ciphertext.length < 17) throw new Error("Invalid shared setting cipher payload");
  let plaintext;
  try {
    plaintext = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: sharedSettingAad(aadHeader) },
      await importAesKey(wdk),
      ciphertext,
    );
  } catch {
    throw new Error("Shared setting authentication failed");
  }
  let payload;
  try { payload = JSON.parse(decodeUtf8(plaintext)); } catch { throw new Error("Shared setting plaintext is invalid"); }
  if (!payload || payload.settingId !== aadHeader.settingId || !Number.isInteger(payload.stamp?.counter) || payload.stamp.counter < 0 || typeof payload.stamp?.deviceId !== "string") {
    throw new Error("Shared setting payload is invalid");
  }
  if (payload.value !== null && (typeof validateValue !== "function" || validateValue(payload.value) !== true)) {
    throw new Error("Shared setting value failed validation");
  }
  return payload;
}
