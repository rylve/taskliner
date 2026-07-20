const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function webCrypto() {
  const value = globalThis.crypto;
  if (!value?.subtle || !value.getRandomValues) throw new Error("Web Crypto API is unavailable");
  return value;
}

export function utf8(value) {
  return encoder.encode(String(value));
}

export function decodeUtf8(value) {
  return decoder.decode(value);
}

export function randomBytes(length) {
  if (!Number.isInteger(length) || length < 1) throw new TypeError("A positive byte length is required");
  return webCrypto().getRandomValues(new Uint8Array(length));
}

export function toBytes(value, name = "value") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${name} must be binary data`);
}

export function base64urlEncode(value) {
  const bytes = toBytes(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64urlDecode(value, name = "value") {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${name} must be base64url`);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error(`${name} must be base64url`);
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64urlEncode(bytes) !== value) throw new Error(`${name} is not canonical base64url`);
  return bytes;
}

export function concatBytes(...values) {
  const chunks = values.map((value) => toBytes(value));
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function sha256(value) {
  return new Uint8Array(await webCrypto().subtle.digest("SHA-256", toBytes(value)));
}

export function requireId(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) throw new Error(`${name} is invalid`);
  return value;
}

export function jsonBytes(value) {
  return utf8(JSON.stringify(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])])
    );
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return utf8(JSON.stringify(canonicalValue(value)));
}

export function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value;
}

export async function importAesKey(value, usages = ["encrypt", "decrypt"]) {
  const isCryptoKey = (typeof CryptoKey !== "undefined" && value instanceof CryptoKey)
    || value?.[Symbol.toStringTag] === "CryptoKey";
  if (isCryptoKey) {
    if (value.type !== "secret" || value.algorithm?.name !== "AES-GCM" || value.algorithm?.length !== 256) {
      throw new Error("An AES-GCM-256 CryptoKey is required");
    }
    if (!usages.every((usage) => value.usages.includes(usage))) {
      throw new Error(`AES key does not allow required usages: ${usages.join(", ")}`);
    }
    return value;
  }
  const bytes = toBytes(value, "key");
  if (bytes.length !== 32) throw new Error("AES-256 keys must be 32 bytes");
  return webCrypto().subtle.importKey("raw", bytes, { name: "AES-GCM", length: 256 }, false, usages);
}

export async function deriveHkdfAesKey(secret, { salt, info }) {
  const subtle = webCrypto().subtle;
  const material = await subtle.importKey("raw", toBytes(secret, "HKDF secret"), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toBytes(salt, "HKDF salt"), info: toBytes(info, "HKDF info") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
