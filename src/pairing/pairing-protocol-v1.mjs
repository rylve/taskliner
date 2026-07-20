import {
  assertPlainObject,
  base64urlDecode,
  base64urlEncode,
  canonicalJsonBytes,
  concatBytes,
  deriveHkdfAesKey,
  randomBytes,
  requireId,
  sha256,
  toBytes,
  utf8,
  webCrypto,
} from "../crypto/e2ee-utils.mjs";

export const PAIRING_ARTIFACT_FORMAT = "taskliner-pairing-artifact";
export const PAIRING_ARTIFACT_VERSION = 1;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function confirmationCodePart(byte) {
  return String((byte & 63) + 1).padStart(2, "0");
}

function normalizeCode(code) {
  return String(code).toUpperCase().replace(/[\s-]/gu, "").replaceAll("O", "0").replace(/[IL]/gu, "1");
}

export function encodeCrockfordBase32(value) {
  const bytes = toBytes(value, "invite secret");
  if (bytes.length !== 16) throw new Error("Invite secret must be 128 bits");
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(number & 31n)] + encoded;
    number >>= 5n;
  }
  return encoded.replace(/^(.{5})(.{5})(.{5})(.{5})(.{6})$/u, "$1-$2-$3-$4-$5");
}

export function decodeCrockfordBase32(code) {
  const normalized = normalizeCode(code);
  if (normalized.length !== 26) throw new Error("Invite code is invalid");
  let number = 0n;
  for (const character of normalized) {
    const digit = CROCKFORD.indexOf(character);
    if (digit < 0) throw new Error("Invite code is invalid");
    number = (number << 5n) | BigInt(digit);
  }
  if (number >= (1n << 128n)) throw new Error("Invite code is invalid");
  const bytes = new Uint8Array(16);
  for (let index = 15; index >= 0; index -= 1) {
    bytes[index] = Number(number & 255n);
    number >>= 8n;
  }
  return bytes;
}

function readInviteSecret({ inviteSecret, inviteCode }) {
  if (inviteCode != null) return decodeCrockfordBase32(inviteCode);
  const value = typeof inviteSecret === "string" ? base64urlDecode(inviteSecret, "invite secret") : toBytes(inviteSecret, "invite secret");
  if (value.length !== 16) throw new Error("Invite secret must be 128 bits");
  return value;
}

async function accountIdHash(accountId) {
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("Google account id is required");
  return base64urlEncode(await sha256(utf8(`taskliner-google-account-v1\0${accountId.trim()}`)));
}

async function pairingIdFor(secret) {
  return base64urlEncode(await sha256(concatBytes(utf8("taskliner-pairing-id-v1\0"), secret)));
}

async function generateEcdhKeyPair() {
  return webCrypto().subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

async function exportPublicKey(key) {
  const jwk = await webCrypto().subtle.exportKey("jwk", key);
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true, key_ops: [] };
}

async function importPublicKey(jwk) {
  assertPlainObject(jwk, "pairing public key");
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("Pairing public key is invalid");
  }
  return webCrypto().subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function deriveShared(privateKey, publicJwk) {
  const publicKey = await importPublicKey(publicJwk);
  return new Uint8Array(await webCrypto().subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
}

function requireArtifact(value, kind) {
  assertPlainObject(value, kind);
  if (value.format !== PAIRING_ARTIFACT_FORMAT || value.version !== PAIRING_ARTIFACT_VERSION || value.kind !== kind) {
    throw new Error(`Invalid ${kind}`);
  }
  return value;
}

function requireRegistry(registry) {
  if (typeof registry?.assertUnused !== "function" || typeof registry?.consume !== "function") {
    throw new Error("A persistent pairing use registry is required");
  }
  return registry;
}

function assertTime(offer, now) {
  if (!Number.isSafeInteger(offer.createdAt) || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= offer.createdAt) {
    throw new Error("Pairing offer time is invalid");
  }
  if (offer.expiresAt - offer.createdAt > PAIRING_TTL_MS) throw new Error("Pairing offer expiry exceeds ten minutes");
  if (now > offer.expiresAt) throw new Error("Pairing offer has expired");
  if (now + PAIRING_TTL_MS < offer.createdAt) throw new Error("Pairing offer is not active yet");
}

function requestProofInput(request) {
  const { proof: _proof, ...core } = request;
  return canonicalJsonBytes(core);
}

function offerProofInput(offer) {
  const { proof: _proof, ...core } = offer;
  return canonicalJsonBytes(core);
}

async function hmac(secret, value) {
  const key = await webCrypto().subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await webCrypto().subtle.sign("HMAC", key, value));
}

function equalBytes(first, second) {
  if (first.length !== second.length) return false;
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) mismatch |= first[index] ^ second[index];
  return mismatch === 0;
}

async function validateOffer(offer, { accountId, inviteSecret, now = Date.now(), registry } = {}) {
  requireArtifact(offer, "pairing-offer");
  requireId(offer.offerId, "offerId");
  requireId(offer.workspaceId, "workspaceId");
  requireId(offer.keyId, "keyId");
  requireId(offer.pairingId, "pairingId");
  requireId(offer.inviterDeviceId, "inviterDeviceId");
  assertTime(offer, now);
  requireRegistry(registry).assertUnused("offer", offer.offerId);
  if (offer.accountIdHash !== await accountIdHash(accountId)) throw new Error("Pairing offer belongs to another Google account");
  const secret = readInviteSecret({ inviteSecret });
  if (await pairingIdFor(secret) !== offer.pairingId) throw new Error("Invite code is incorrect");
  const proof = base64urlDecode(offer.proof, "pairing offer proof");
  const expectedProof = await hmac(secret, offerProofInput(offer));
  if (!equalBytes(proof, expectedProof)) throw new Error("Pairing offer authentication failed");
  await importPublicKey(offer.inviterPublicKey);
}

export class PairingUseRegistry {
  #used = new Set();

  assertUnused(kind, id) {
    if (this.#used.has(`${kind}:${id}`)) throw new Error(`Pairing ${kind} has already been used`);
  }

  consume(kind, id) {
    this.assertUnused(kind, id);
    this.#used.add(`${kind}:${id}`);
  }

  cancelOffer(offerId) {
    this.consume("offer", offerId);
  }
}

export function createPairingQrFragment(offer, inviteSecret) {
  const secret = readInviteSecret({ inviteSecret });
  requireArtifact(offer, "pairing-offer");
  return `#taskliner-pair=${encodeURIComponent(offer.offerId)}.${base64urlEncode(secret)}`;
}

export function parsePairingQrFragment(fragment) {
  const match = /^#taskliner-pair=([^.]*)\.([A-Za-z0-9_-]+)$/u.exec(String(fragment));
  if (!match) throw new Error("Pairing QR fragment is invalid");
  const offerId = decodeURIComponent(match[1]);
  requireId(offerId, "offerId");
  const inviteSecret = base64urlDecode(match[2], "invite secret");
  if (inviteSecret.length !== 16) throw new Error("Invite secret must be 128 bits");
  return { offerId, inviteSecret };
}

export async function createPairingOffer({ workspaceId, keyId, inviterDeviceId, inviterDeviceName, accountId, now = Date.now(), registry }) {
  if (!Number.isSafeInteger(now)) throw new Error("Pairing time is invalid");
  const useRegistry = requireRegistry(registry);
  const inviteSecret = randomBytes(16);
  const keyPair = await generateEcdhKeyPair();
  const offer = {
    format: PAIRING_ARTIFACT_FORMAT,
    version: PAIRING_ARTIFACT_VERSION,
    kind: "pairing-offer",
    offerId: base64urlEncode(randomBytes(16)),
    pairingId: await pairingIdFor(inviteSecret),
    workspaceId: requireId(workspaceId, "workspaceId"),
    keyId: requireId(keyId, "keyId"),
    accountIdHash: await accountIdHash(accountId),
    inviterDeviceId: requireId(inviterDeviceId, "inviterDeviceId"),
    inviterDeviceName: requireId(inviterDeviceName, "inviterDeviceName"),
    inviterPublicKey: await exportPublicKey(keyPair.publicKey),
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
  };
  offer.proof = base64urlEncode(await hmac(inviteSecret, offerProofInput(offer)));
  useRegistry.assertUnused("offer", offer.offerId);
  return {
    offer,
    inviterPrivateKey: keyPair.privateKey,
    inviteSecret,
    inviteCode: encodeCrockfordBase32(inviteSecret),
    qrFragment: createPairingQrFragment(offer, inviteSecret),
  };
}

export async function createPairingRequest({
  offer,
  inviteSecret,
  inviteCode,
  requesterDeviceId,
  requesterDeviceName,
  accountId,
  now = Date.now(),
  registry,
}) {
  const secret = readInviteSecret({ inviteSecret, inviteCode });
  await validateOffer(offer, { accountId, inviteSecret: secret, now, registry });
  const keyPair = await generateEcdhKeyPair();
  const request = {
    format: PAIRING_ARTIFACT_FORMAT,
    version: PAIRING_ARTIFACT_VERSION,
    kind: "pairing-request",
    requestId: base64urlEncode(randomBytes(16)),
    offerId: offer.offerId,
    pairingId: offer.pairingId,
    workspaceId: offer.workspaceId,
    keyId: offer.keyId,
    accountIdHash: offer.accountIdHash,
    requesterDeviceId: requireId(requesterDeviceId, "requesterDeviceId"),
    requesterDeviceName: requireId(requesterDeviceName, "requesterDeviceName"),
    requesterPublicKey: await exportPublicKey(keyPair.publicKey),
    createdAt: now,
    expiresAt: offer.expiresAt,
  };
  request.proof = base64urlEncode(await hmac(secret, requestProofInput(request)));
  return { request, requesterPrivateKey: keyPair.privateKey, inviteSecret: secret };
}

async function validateRequest(offer, request, secret, options) {
  await validateOffer(offer, { ...options, inviteSecret: secret });
  requireArtifact(request, "pairing-request");
  requireId(request.requestId, "requestId");
  requireId(request.requesterDeviceId, "requesterDeviceId");
  requireId(request.requesterDeviceName, "requesterDeviceName");
  requireRegistry(options.registry).assertUnused("request", request.requestId);
  for (const key of ["offerId", "pairingId", "workspaceId", "keyId", "accountIdHash", "expiresAt"]) {
    if (request[key] !== offer[key]) throw new Error("Pairing request does not match offer");
  }
  if (request.createdAt < offer.createdAt || request.createdAt > offer.expiresAt) throw new Error("Pairing request time is invalid");
  await importPublicKey(request.requesterPublicKey);
  const proof = base64urlDecode(request.proof, "pairing request proof");
  const expected = await hmac(secret, requestProofInput(request));
  if (!equalBytes(proof, expected)) throw new Error("Pairing request authentication failed");
}

async function transferMaterial(offer, request, privateKey, otherPublicKey, secret) {
  const shared = await deriveShared(privateKey, otherPublicKey);
  const info = canonicalJsonBytes({
    format: "taskliner-pairing-transfer",
    version: 1,
    workspaceId: offer.workspaceId,
    keyId: offer.keyId,
    offerId: offer.offerId,
    requestId: request.requestId,
  });
  const key = await deriveHkdfAesKey(shared, { salt: secret, info });
  const digest = await sha256(concatBytes(utf8("taskliner-pairing-confirm-v1\0"), shared, secret, info));
  // Four base-64 groups preserve the previous 24-bit comparison strength while
  // staying readable and identical across Japanese and English devices.
  const confirmationWords = Array.from(digest.subarray(0, 4), confirmationCodePart);
  return { key, confirmationWords };
}

export async function inspectPairingRequest({ offer, request, inviterPrivateKey, inviteSecret, inviteCode, accountId, now = Date.now(), registry }) {
  const secret = readInviteSecret({ inviteSecret, inviteCode });
  if (await pairingIdFor(secret) !== offer.pairingId) throw new Error("Invite code is incorrect");
  await validateRequest(offer, request, secret, { accountId, now, registry });
  const { confirmationWords } = await transferMaterial(offer, request, inviterPrivateKey, request.requesterPublicKey, secret);
  return {
    confirmationWords,
    requesterDeviceId: request.requesterDeviceId,
    requesterDeviceName: request.requesterDeviceName,
  };
}

function responseHeader(response) {
  return {
    format: PAIRING_ARTIFACT_FORMAT,
    version: PAIRING_ARTIFACT_VERSION,
    kind: "pairing-response",
    responseId: response.responseId,
    requestId: response.requestId,
    offerId: response.offerId,
    pairingId: response.pairingId,
    workspaceId: response.workspaceId,
    keyId: response.keyId,
    accountIdHash: response.accountIdHash,
    approvedAt: response.approvedAt,
    expiresAt: response.expiresAt,
  };
}

export async function approvePairingRequest({
  offer,
  request,
  inviterPrivateKey,
  inviteSecret,
  inviteCode,
  accountId,
  wdk,
  now = Date.now(),
  registry,
}) {
  const secret = readInviteSecret({ inviteSecret, inviteCode });
  if (await pairingIdFor(secret) !== offer.pairingId) throw new Error("Invite code is incorrect");
  await validateRequest(offer, request, secret, { accountId, now, registry });
  const keyMaterial = toBytes(wdk, "WDK");
  if (keyMaterial.length !== 32) throw new Error("WDK must be 32 bytes");
  const { key, confirmationWords } = await transferMaterial(offer, request, inviterPrivateKey, request.requesterPublicKey, secret);
  const response = responseHeader({
    responseId: base64urlEncode(randomBytes(16)),
    requestId: request.requestId,
    offerId: offer.offerId,
    pairingId: offer.pairingId,
    workspaceId: offer.workspaceId,
    keyId: offer.keyId,
    accountIdHash: offer.accountIdHash,
    approvedAt: now,
    expiresAt: offer.expiresAt,
  });
  const nonce = randomBytes(12);
  const ciphertext = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: canonicalJsonBytes(response) },
    key,
    keyMaterial
  );
  response.cipher = {
    algorithm: "AES-GCM-256",
    nonce: base64urlEncode(nonce),
    ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
  };
  registry.consume("request", request.requestId);
  registry.consume("offer", offer.offerId);
  return { response, confirmationWords };
}

export async function acceptPairingResponse({
  offer,
  request,
  response,
  requesterPrivateKey,
  inviteSecret,
  inviteCode,
  accountId,
  now = Date.now(),
  registry,
}) {
  const secret = readInviteSecret({ inviteSecret, inviteCode });
  await validateRequest(offer, request, secret, { accountId, now, registry });
  requireArtifact(response, "pairing-response");
  requireRegistry(registry).assertUnused("response", response.responseId);
  const expected = responseHeader(response);
  for (const key of ["requestId", "offerId", "pairingId", "workspaceId", "keyId", "accountIdHash", "expiresAt"]) {
    const source = key === "requestId" ? request : offer;
    if (expected[key] !== source[key]) throw new Error("Pairing response does not match request");
  }
  if (!Number.isSafeInteger(response.approvedAt) || response.approvedAt < request.createdAt || response.approvedAt > response.expiresAt) {
    throw new Error("Pairing approval time is invalid");
  }
  assertPlainObject(response.cipher, "pairing response cipher");
  if (response.cipher.algorithm !== "AES-GCM-256") throw new Error("Unsupported pairing response cipher");
  const nonce = base64urlDecode(response.cipher.nonce, "pairing response nonce");
  const ciphertext = base64urlDecode(response.cipher.ciphertext, "pairing response ciphertext");
  if (nonce.length !== 12 || ciphertext.length !== 48) throw new Error("Invalid pairing response cipher payload");
  const { key, confirmationWords } = await transferMaterial(offer, request, requesterPrivateKey, offer.inviterPublicKey, secret);
  let wdk;
  try {
    wdk = new Uint8Array(await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: canonicalJsonBytes(expected) },
      key,
      ciphertext
    ));
  } catch {
    throw new Error("Pairing response authentication failed");
  }
  registry.consume("response", response.responseId);
  return { wdk, confirmationWords };
}
