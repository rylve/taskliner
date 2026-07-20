import assert from "node:assert/strict";
import test from "node:test";

import { base64urlEncode, deriveHkdfAesKey, randomBytes, utf8, webCrypto } from "../src/crypto/e2ee-utils.mjs";
import {
  MIGRATION_BUNDLE_FORMAT,
  MIGRATION_MAX_STATE_BYTES,
  MIGRATION_MAX_STATES,
  MIGRATION_BUNDLE_VERSION,
  decryptLegacyMigrationBundle,
  generateMigrationClientKeyPair,
  migrationBundleAad,
} from "../src/crypto/migration-bundle-v1.mjs";

const validateState = (state) => state?.format === "taskliner-device-state";

async function makeBundle(migrationPublicKey, payload, fingerprint = "fingerprint-1") {
  const subtle = webCrypto().subtle;
  const clientPublicKey = await subtle.importKey(
    "jwk",
    migrationPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const server = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const serverJwk = await subtle.exportKey("jwk", server.publicKey);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: clientPublicKey }, server.privateKey, 256));
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const key = await deriveHkdfAesKey(shared, { salt, info: utf8("taskliner-v2-migration-v1") });
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: migrationBundleAad(fingerprint) },
    key,
    utf8(JSON.stringify(payload))
  );
  return {
    format: MIGRATION_BUNDLE_FORMAT,
    version: MIGRATION_BUNDLE_VERSION,
    fingerprint,
    serverPublicKey: { kty: "EC", crv: "P-256", x: serverJwk.x, y: serverJwk.y, ext: true, key_ops: [] },
    salt: base64urlEncode(salt),
    nonce: base64urlEncode(nonce),
    ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
  };
}

test("migration client decrypts the Function P-256/HKDF/AES-GCM legacy bundle contract", async () => {
  const client = await generateMigrationClientKeyPair();
  const payload = { states: [{ format: "taskliner-device-state", deviceId: "old-pc", nodes: {} }] };
  const bundle = await makeBundle(client.migrationPublicKey, payload);
  assert.deepEqual(await decryptLegacyMigrationBundle(bundle, client.privateKey, {
    expectedFingerprint: "fingerprint-1",
    validateState,
  }), payload);
});

test("migration bundle rejects fingerprint, ciphertext, and wrong private key", async () => {
  const client = await generateMigrationClientKeyPair();
  const bundle = await makeBundle(client.migrationPublicKey, { states: [] });
  await assert.rejects(
    () => decryptLegacyMigrationBundle(bundle, client.privateKey, { expectedFingerprint: "wrong", validateState }),
    /Unexpected legacy fingerprint/
  );
  const tampered = structuredClone(bundle);
  tampered.ciphertext = `${tampered.ciphertext[0] === "A" ? "B" : "A"}${tampered.ciphertext.slice(1)}`;
  await assert.rejects(() => decryptLegacyMigrationBundle(tampered, client.privateKey, {
    expectedFingerprint: "fingerprint-1",
    validateState,
  }), /authentication failed/);
  const anotherClient = await generateMigrationClientKeyPair();
  await assert.rejects(() => decryptLegacyMigrationBundle(bundle, anotherClient.privateKey, {
    expectedFingerprint: "fingerprint-1",
    validateState,
  }), /authentication failed/);
});

test("migration bundle requires an expected fingerprint and a fail-closed state validator", async () => {
  const client = await generateMigrationClientKeyPair();
  const bundle = await makeBundle(client.migrationPublicKey, { states: [] });
  await assert.rejects(
    () => decryptLegacyMigrationBundle(bundle, client.privateKey, { validateState }),
    /expectedFingerprint is invalid/
  );
  await assert.rejects(
    () => decryptLegacyMigrationBundle(bundle, client.privateKey, { expectedFingerprint: "fingerprint-1" }),
    /validator is required/
  );
});

test("migration bundle rejects excessive state counts, excessive state size, and any invalid state", async () => {
  const client = await generateMigrationClientKeyPair();
  const tooMany = await makeBundle(client.migrationPublicKey, {
    states: Array.from({ length: MIGRATION_MAX_STATES + 1 }, () => ({ format: "taskliner-device-state" })),
  });
  await assert.rejects(() => decryptLegacyMigrationBundle(tooMany, client.privateKey, {
    expectedFingerprint: "fingerprint-1",
    validateState,
  }), /too many device states/);

  const tooLarge = await makeBundle(client.migrationPublicKey, {
    states: [{ format: "taskliner-device-state", text: "x".repeat(MIGRATION_MAX_STATE_BYTES + 1) }],
  });
  await assert.rejects(() => decryptLegacyMigrationBundle(tooLarge, client.privateKey, {
    expectedFingerprint: "fingerprint-1",
    validateState,
  }), /size limit/);

  const invalid = await makeBundle(client.migrationPublicKey, {
    states: [{ format: "taskliner-device-state" }, { format: "invalid-state" }],
  });
  let validations = 0;
  await assert.rejects(() => decryptLegacyMigrationBundle(invalid, client.privateKey, {
    expectedFingerprint: "fingerprint-1",
    validateState(state) {
      validations += 1;
      return state.format === "taskliner-device-state";
    },
  }), /failed validation/);
  assert.equal(validations, 2);
});
