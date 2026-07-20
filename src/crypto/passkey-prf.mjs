import {
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  deriveHkdfAesKey,
  randomBytes,
  requireId,
  toBytes,
  utf8,
} from "./e2ee-utils.mjs";

export const PASSKEY_PRF_SALT_BYTES = 32;

export function generatePasskeyPrfSalt() {
  return randomBytes(PASSKEY_PRF_SALT_BYTES);
}

export function createPasskeyPrfExtension(prfSalt) {
  const salt = toBytes(prfSalt, "PRF salt");
  if (salt.length !== PASSKEY_PRF_SALT_BYTES) throw new Error("PRF salt must be 32 bytes");
  const first = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength);
  return { prf: { eval: { first } } };
}

export function extractPasskeyPrfResult(credentialOrExtensionResults) {
  const extensionResults = typeof credentialOrExtensionResults?.getClientExtensionResults === "function"
    ? credentialOrExtensionResults.getClientExtensionResults()
    : credentialOrExtensionResults;
  const first = extensionResults?.prf?.results?.first;
  if (!(first instanceof ArrayBuffer) && !ArrayBuffer.isView(first)) return null;
  const bytes = new Uint8Array(toBytes(first, "PRF result"));
  return bytes.length === 32 ? bytes : null;
}

export function passkeyPrfSucceeded(credentialOrExtensionResults) {
  return extractPasskeyPrfResult(credentialOrExtensionResults) !== null;
}

export async function derivePasskeyKek(prfResult, { prfSalt, workspaceId, keyId }) {
  const result = toBytes(prfResult, "PRF result");
  const salt = typeof prfSalt === "string" ? base64urlDecode(prfSalt, "PRF salt") : toBytes(prfSalt, "PRF salt");
  if (result.length !== 32) throw new Error("PRF result must be 32 bytes");
  if (salt.length !== PASSKEY_PRF_SALT_BYTES) throw new Error("PRF salt must be 32 bytes");
  const info = concatBytes(
    utf8("taskliner-passkey-kek-v1\0"),
    utf8(requireId(workspaceId, "workspaceId")),
    utf8("\0"),
    utf8(requireId(keyId, "keyId"))
  );
  return deriveHkdfAesKey(result, { salt, info });
}

export function serializePasskeyPrfSalt(prfSalt) {
  const salt = toBytes(prfSalt, "PRF salt");
  if (salt.length !== PASSKEY_PRF_SALT_BYTES) throw new Error("PRF salt must be 32 bytes");
  return base64urlEncode(salt);
}
