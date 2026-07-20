import {
  assertPlainObject,
  base64urlDecode,
  decodeUtf8,
  deriveHkdfAesKey,
  jsonBytes,
  requireId,
  utf8,
  webCrypto,
} from "./e2ee-utils.mjs";

export const MIGRATION_BUNDLE_FORMAT = "taskliner-v2-migration-bundle";
export const MIGRATION_BUNDLE_VERSION = 1;
export const MIGRATION_MAX_STATES = 64;
export const MIGRATION_MAX_STATE_BYTES = 2 * 1024 * 1024;
export const MIGRATION_MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;

async function exportPublicKey(key) {
  const jwk = await webCrypto().subtle.exportKey("jwk", key);
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true, key_ops: [] };
}

async function importServerPublicKey(jwk) {
  assertPlainObject(jwk, "migration server public key");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("Migration server public key is invalid");
  }
  return webCrypto().subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

export async function generateMigrationClientKeyPair() {
  const keyPair = await webCrypto().subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: keyPair.privateKey, migrationPublicKey: await exportPublicKey(keyPair.publicKey) };
}

export function migrationBundleAad(fingerprint) {
  return jsonBytes({
    format: MIGRATION_BUNDLE_FORMAT,
    version: MIGRATION_BUNDLE_VERSION,
    fingerprint: requireId(fingerprint, "fingerprint"),
  });
}

export async function decryptLegacyMigrationBundle(bundle, clientPrivateKey, { expectedFingerprint, validateState } = {}) {
  assertPlainObject(bundle, "legacy migration bundle");
  requireId(expectedFingerprint, "expectedFingerprint");
  if (typeof validateState !== "function") throw new Error("A legacy device state validator is required");
  if (bundle.format !== MIGRATION_BUNDLE_FORMAT || bundle.version !== MIGRATION_BUNDLE_VERSION) {
    throw new Error("Unsupported migration bundle");
  }
  const fingerprint = requireId(bundle.fingerprint, "fingerprint");
  if (fingerprint !== expectedFingerprint) throw new Error("Unexpected legacy fingerprint");
  const salt = base64urlDecode(bundle.salt, "migration salt");
  const nonce = base64urlDecode(bundle.nonce, "migration nonce");
  const ciphertext = base64urlDecode(bundle.ciphertext, "migration ciphertext");
  if (
    salt.length !== 32
    || nonce.length !== 12
    || ciphertext.length < 17
    || ciphertext.length > MIGRATION_MAX_PLAINTEXT_BYTES + 16
  ) throw new Error("Invalid migration bundle cipher payload");
  const serverPublicKey = await importServerPublicKey(bundle.serverPublicKey);
  const shared = new Uint8Array(await webCrypto().subtle.deriveBits(
    { name: "ECDH", public: serverPublicKey },
    clientPrivateKey,
    256
  ));
  const key = await deriveHkdfAesKey(shared, { salt, info: utf8("taskliner-v2-migration-v1") });
  let plaintext;
  try {
    plaintext = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: migrationBundleAad(fingerprint) },
      key,
      ciphertext
    );
  } catch {
    throw new Error("Migration bundle authentication failed");
  }
  let payload;
  try {
    payload = JSON.parse(decodeUtf8(plaintext));
  } catch {
    throw new Error("Migration bundle plaintext is invalid");
  }
  if (!payload || !Array.isArray(payload.states)) throw new Error("Migration bundle states are invalid");
  if (payload.states.length > MIGRATION_MAX_STATES) throw new Error("Migration bundle has too many device states");
  for (const state of payload.states) {
    let stateBytes;
    try {
      stateBytes = utf8(JSON.stringify(state)).byteLength;
    } catch {
      throw new Error("Migration device state is not JSON-serializable");
    }
    if (stateBytes > MIGRATION_MAX_STATE_BYTES) throw new Error("Migration device state exceeds the size limit");
    const validation = validateState(state);
    if (validation !== true && validation?.ok !== true) throw new Error("Migration device state failed validation");
  }
  return payload;
}
