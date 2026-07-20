const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const DEFAULT_PBKDF2_ITERATIONS = 210_000;
const ENVELOPE_FORMAT = "taskliner-encrypted-v1";

function getWebCrypto() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) throw new Error("Web Crypto API is unavailable");
  return cryptoApi;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !value) throw new Error("Invalid base64 payload");
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function additionalDataBytes(value) {
  if (value == null) return null;
  return typeof value === "string" ? textEncoder.encode(value) : textEncoder.encode(JSON.stringify(value));
}

function validateKey(key) {
  if (!key || typeof key !== "object" || key.type !== "secret") throw new TypeError("An AES-GCM CryptoKey is required");
}

export async function generateWorkspaceKey() {
  const { subtle } = getWebCrypto();
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function deriveWorkspaceKey(passphrase, { salt, iterations = DEFAULT_PBKDF2_ITERATIONS } = {}) {
  if (typeof passphrase !== "string" || passphrase.length < 12) throw new Error("Passphrase must be at least 12 characters");
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("PBKDF2 iterations must be a positive integer");
  const cryptoApi = getWebCrypto();
  const saltBytes = salt ? (typeof salt === "string" ? base64ToBytes(salt) : new Uint8Array(salt)) : cryptoApi.getRandomValues(new Uint8Array(16));
  const material = await cryptoApi.subtle.importKey("raw", textEncoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  return {
    key,
    kdf: "PBKDF2-SHA-256",
    salt: bytesToBase64(saltBytes),
    iterations,
  };
}

export async function encryptJson(value, key, { associatedData } = {}) {
  validateKey(key);
  const cryptoApi = getWebCrypto();
  const nonce = cryptoApi.getRandomValues(new Uint8Array(12));
  const aad = additionalDataBytes(associatedData);
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, ...(aad ? { additionalData: aad } : {}) },
    key,
    textEncoder.encode(JSON.stringify(value))
  );
  return {
    format: ENVELOPE_FORMAT,
    version: 1,
    algorithm: "AES-GCM-256",
    nonce: bytesToBase64(nonce),
    ...(associatedData != null ? { associatedData: bytesToBase64(aad) } : {}),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptJson(envelope, key, { associatedData } = {}) {
  validateKey(key);
  if (!envelope || envelope.format !== ENVELOPE_FORMAT || envelope.version !== 1 || envelope.algorithm !== "AES-GCM-256") {
    throw new Error("Unsupported Taskliner encryption envelope");
  }
  const cryptoApi = getWebCrypto();
  const nonce = base64ToBytes(envelope.nonce);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const storedAad = envelope.associatedData ? base64ToBytes(envelope.associatedData) : null;
  const aad = additionalDataBytes(associatedData);
  if (storedAad && (!aad || bytesToBase64(aad) !== bytesToBase64(storedAad))) throw new Error("Encryption context does not match");
  const plaintext = await cryptoApi.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, ...(storedAad ? { additionalData: storedAad } : {}) },
    key,
    ciphertext
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

export { DEFAULT_PBKDF2_ITERATIONS, ENVELOPE_FORMAT };

