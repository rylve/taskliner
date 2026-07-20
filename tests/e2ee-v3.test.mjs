import assert from "node:assert/strict";
import test from "node:test";

import {
  deviceEnvelopeAad,
  decryptDeviceState,
  encryptDeviceState,
  generateWorkspaceDataKey,
  validateDeviceEnvelopeOuter,
} from "../src/crypto/device-envelope-v3.mjs";
import { base64urlEncode, importAesKey, jsonBytes, randomBytes } from "../src/crypto/e2ee-utils.mjs";

function changedBase64url(value) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

const context = { workspaceId: "workspace-1", keyId: "key-1", deviceId: "device-1" };
const state = (value = {}) => ({ workspaceId: context.workspaceId, deviceId: context.deviceId, ...value });

test("v3 device envelope round-trips and runs the decrypted state validator", async () => {
  const wdk = generateWorkspaceDataKey();
  const deviceState = state({ format: "taskliner-device-state", version: 1, nodes: { a: { title: "private" } } });
  let validated = false;
  const envelope = await encryptDeviceState(deviceState, { ...context, wdk });

  assert.equal(envelope.format, "taskliner-device-envelope");
  assert.equal(envelope.version, 3);
  assert.equal(envelope.cipher.algorithm, "AES-GCM-256");
  assert.equal(JSON.stringify(envelope).includes("private"), false);
  assert.deepEqual(await decryptDeviceState(envelope, wdk, {
    expectedWorkspaceId: context.workspaceId,
    expectedKeyId: context.keyId,
    expectedDeviceId: context.deviceId,
    validate(value) {
      validated = value.format === "taskliner-device-state";
      return validated;
    },
  }), deviceState);
  assert.equal(validated, true);
});

test("v3 device envelope uses a fresh nonce for every encryption", async () => {
  const wdk = generateWorkspaceDataKey();
  const forcedNonce = new Uint8Array(12);
  const first = await encryptDeviceState(state({ same: true }), { ...context, wdk, nonce: forcedNonce });
  const second = await encryptDeviceState(state({ same: true }), { ...context, wdk, nonce: forcedNonce });
  assert.notEqual(first.cipher.nonce, second.cipher.nonce);
  assert.notEqual(first.cipher.nonce, base64urlEncode(forcedNonce));
  assert.notEqual(first.cipher.ciphertext, second.cipher.ciphertext);
});

test("v3 device envelope rejects AAD, ciphertext, key, and expected keyId mismatches", async () => {
  const wdk = generateWorkspaceDataKey();
  const envelope = await encryptDeviceState(state({ ok: true }), { ...context, wdk });
  const validator = () => true;
  await assert.rejects(() => decryptDeviceState({ ...envelope, deviceId: "tampered" }, wdk, { validate: validator }), /authentication failed/);
  await assert.rejects(() => decryptDeviceState({
    ...envelope,
    cipher: { ...envelope.cipher, ciphertext: changedBase64url(envelope.cipher.ciphertext) },
  }, wdk, { validate: validator }), /authentication failed/);
  await assert.rejects(() => decryptDeviceState(envelope, generateWorkspaceDataKey(), { validate: validator }), /authentication failed/);
  await assert.rejects(() => decryptDeviceState(envelope, wdk, { expectedKeyId: "wrong", validate: validator }), /Unexpected keyId/);
  await assert.rejects(() => decryptDeviceState(envelope, wdk, { validate: () => false }), /failed validation/);
  await assert.rejects(() => decryptDeviceState(envelope, wdk), /validator is required/);
});

test("device envelope rejects inner identities that differ from authenticated headers", async () => {
  const wdk = generateWorkspaceDataKey();
  await assert.rejects(
    () => encryptDeviceState({ workspaceId: context.workspaceId, deviceId: "other" }, { ...context, wdk }),
    /identity does not match/
  );

  const nonce = randomBytes(12);
  const plaintext = state({ deviceId: "other", nodes: {} });
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: deviceEnvelopeAad(context) },
    await importAesKey(wdk),
    jsonBytes(plaintext)
  );
  const envelope = {
    format: "taskliner-device-envelope",
    version: 3,
    ...context,
    cipher: {
      algorithm: "AES-GCM-256",
      nonce: base64urlEncode(nonce),
      ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
    },
  };
  await assert.rejects(() => decryptDeviceState(envelope, wdk, { validate: () => true }), /identity does not match/);
});

test("outer device envelope validation rejects malformed nonces", async () => {
  const envelope = await encryptDeviceState(state({ ok: true }), { ...context, wdk: generateWorkspaceDataKey() });
  envelope.cipher.nonce = "AQ";
  assert.throws(() => validateDeviceEnvelopeOuter(envelope), /12 bytes/);
});
