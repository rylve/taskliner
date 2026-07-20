import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkspaceDataKey } from "../src/crypto/device-envelope-v3.mjs";
import {
  createDeviceStorageKeyWrapper,
  createPasskeyKeyWrapper,
  createRecoveryFile,
  createRecoveryKeyWrapper,
  generateDeviceStorageKey,
  generateRecoveryKey,
  parseRecoveryFile,
  unwrapDeviceStorageKeyWrapper,
  unwrapPasskeyKeyWrapper,
  unwrapRecoveryKeyWrapper,
} from "../src/crypto/key-wrappers-v1.mjs";
import {
  createPasskeyPrfExtension,
  extractPasskeyPrfResult,
  generatePasskeyPrfSalt,
  passkeyPrfSucceeded,
} from "../src/crypto/passkey-prf.mjs";
import { importAesKey } from "../src/crypto/e2ee-utils.mjs";

const common = { workspaceId: "workspace-1", keyId: "key-1" };

test("non-extractable device storage key wraps the WDK for automatic revisits", async () => {
  const wdk = generateWorkspaceDataKey();
  const deviceStorageKey = await generateDeviceStorageKey();
  assert.equal(deviceStorageKey.extractable, false);
  const wrapper = await createDeviceStorageKeyWrapper({
    ...common,
    wrapperId: "local-device-1",
    deviceId: "device-1",
    wdk,
    deviceStorageKey,
  });
  assert.deepEqual(await unwrapDeviceStorageKeyWrapper(wrapper, deviceStorageKey, {
    expectedWorkspaceId: common.workspaceId,
    expectedKeyId: common.keyId,
  }), wdk);
  const wrongDeviceStorageKey = await generateDeviceStorageKey();
  await assert.rejects(() => unwrapDeviceStorageKeyWrapper(wrapper, wrongDeviceStorageKey), /authentication failed/);
});

test("AES key imports reject the wrong algorithm, length, and usages", async () => {
  const aes128 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
  const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const encryptOnly = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  await assert.rejects(() => importAesKey(aes128), /AES-GCM-256/);
  await assert.rejects(() => importAesKey(hmac), /AES-GCM-256/);
  await assert.rejects(() => importAesKey(encryptOnly), /required usages/);
});

test("passkey PRF is detected only from an actual 32-byte extension result", () => {
  const result = crypto.getRandomValues(new Uint8Array(32));
  assert.equal(extractPasskeyPrfResult(undefined), null);
  assert.equal(extractPasskeyPrfResult({ prf: { enabled: true } }), null);
  assert.equal(extractPasskeyPrfResult({ prf: { results: {} } }), null);
  assert.equal(extractPasskeyPrfResult({ prf: { results: { first: new Uint8Array(31) } } }), null);
  assert.deepEqual(extractPasskeyPrfResult({
    getClientExtensionResults: () => ({ prf: { results: { first: result.buffer } } }),
  }), result);
  assert.equal(passkeyPrfSucceeded({ prf: { results: { first: result } } }), true);
});

test("passkey PRF extension and wrapper allow another synced passkey use to unwrap", async () => {
  const wdk = generateWorkspaceDataKey();
  const prfSalt = generatePasskeyPrfSalt();
  const prfResult = crypto.getRandomValues(new Uint8Array(32));
  const extension = createPasskeyPrfExtension(prfSalt);
  assert.deepEqual(new Uint8Array(extension.prf.eval.first), prfSalt);
  const wrapper = await createPasskeyKeyWrapper({
    ...common,
    wrapperId: "passkey-1",
    credentialId: "credential-1",
    prfSalt,
    prfResult,
    wdk,
  });
  assert.deepEqual(await unwrapPasskeyKeyWrapper(wrapper, prfResult, { expectedKeyId: common.keyId }), wdk);
  await assert.rejects(
    () => unwrapPasskeyKeyWrapper(wrapper, crypto.getRandomValues(new Uint8Array(32))),
    /authentication failed/
  );
});

test("recovery key file and wrapper restore the WDK without a memorized passphrase", async () => {
  const wdk = generateWorkspaceDataKey();
  const recoveryKey = generateRecoveryKey();
  const file = createRecoveryFile({ ...common, recoveryKey });
  const expected = { expectedWorkspaceId: common.workspaceId, expectedKeyId: common.keyId };
  const parsed = parseRecoveryFile(JSON.parse(JSON.stringify(file)), expected);
  assert.deepEqual(parsed.recoveryKey, recoveryKey);
  const wrapper = await createRecoveryKeyWrapper({ ...common, wrapperId: "recovery-1", recoveryKey, wdk });
  assert.deepEqual(await unwrapRecoveryKeyWrapper(wrapper, parsed.recoveryKey, expected), wdk);
  const tampered = structuredClone(wrapper);
  tampered.metadata.salt = `${tampered.metadata.salt[0] === "A" ? "B" : "A"}${tampered.metadata.salt.slice(1)}`;
  await assert.rejects(() => unwrapRecoveryKeyWrapper(tampered, recoveryKey), /authentication failed/);
  assert.throws(() => parseRecoveryFile(file, { expectedWorkspaceId: "another" }), /Unexpected workspaceId/);
});
