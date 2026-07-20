import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  artifactAppProperties,
  artifactFileName,
  artifactFromFile,
  assertMutationOrigin,
  isV3SyncEnabled,
  validateArtifactPayload,
} from "../functions/_lib/sync-artifacts.mjs";
import { encryptSecret } from "../functions/_lib/auth.mjs";
import { activateE2eeMigration, beginE2eeMigration, encryptLegacyMigrationBundle, ensureSyncV3Schema, fileFingerprint, getV3Snapshot, initializeE2eeWorkspace, STALE_DEVICE_AFTER_MS } from "../functions/_lib/sync.mjs";
import { decryptLegacyMigrationBundle, generateMigrationClientKeyPair } from "../src/crypto/migration-bundle-v1.mjs";
import { approvePairingRequest, createPairingOffer, createPairingRequest, PairingUseRegistry } from "../src/pairing/pairing-protocol-v1.mjs";
import { createDeviceState } from "../src/sync/device-state.mjs";

const cipher = { algorithm: "AES-GCM-256", nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA" };

test("sync v3 metadata columns are added and verified through the runtime D1 binding", async () => {
  const columns = new Set(["google_sub", "email", "refresh_token_ciphertext"]);
  const database = {
    prepare(sql) {
      return {
        async all() {
          assert.equal(sql, "PRAGMA table_info(taskliner_users)");
          return { results: [...columns].map((name) => ({ name })) };
        },
        async run() {
          const match = /^ALTER TABLE taskliner_users ADD COLUMN ([a-z0-9_]+)/.exec(sql);
          assert.ok(match, `Unexpected migration statement: ${sql}`);
          columns.add(match[1]);
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  await ensureSyncV3Schema({ DB: database });
  for (const name of ["workspace_id", "key_id", "e2ee_status", "legacy_fingerprint", "cutover_lock_token", "cutover_lock_expires_at", "cutover_verified_at"]) {
    assert.equal(columns.has(name), true);
  }
});

test("v3 artifact names and metadata are derived from one kind definition", () => {
  assert.equal(artifactFileName("device-envelope", "device-a"), "taskliner-device-v3.device-a.json");
  assert.equal(artifactFileName("key-wrapper", "passkey.main"), "taskliner-key-wrapper-v1.passkey.main.json");
  assert.deepEqual(artifactAppProperties("shared-setting", "integrations.discord"), {
    taskliner: "sync",
    kind: "shared-setting",
    artifactId: "integrations.discord",
    version: "1",
  });
  assert.deepEqual(artifactFromFile({ name: "taskliner-pairing-request-v1.mailbox-1.json" }), {
    kind: "pairing-request",
    artifactId: "mailbox-1",
  });
});

test("device envelope validation accepts ciphertext and rejects identity mismatches", () => {
  const payload = {
    format: "taskliner-device-envelope",
    version: 3,
    workspaceId: "workspace-1",
    keyId: "key-1",
    deviceId: "device-a",
    cipher,
  };
  assert.equal(validateArtifactPayload("device-envelope", "device-a", payload), payload);
  assert.throws(() => validateArtifactPayload("device-envelope", "device-b", payload), /id mismatch/);
  assert.throws(() => validateArtifactPayload("device-envelope", "device-a", { ...payload, plaintext: { title: "secret" }, cipher: null }), /Unexpected|cipher/);
  assert.throws(() => validateArtifactPayload("device-envelope", "device-a", { ...payload, plaintext: { title: "secret" } }), /Unexpected/);
});

test("Drive key wrappers accept only passkey or recovery outer metadata", () => {
  const wrapper = {
    format: "taskliner-key-wrapper",
    version: 1,
    workspaceId: "workspace-1",
    keyId: "key-1",
    wrapperId: "passkey.main",
    kind: "passkey-prf",
    metadata: { credentialId: "AQID", kdf: "HKDF-SHA-256", prfSalt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    cipher,
  };
  assert.equal(validateArtifactPayload("key-wrapper", "passkey.main", wrapper), wrapper);
  assert.throws(() => validateArtifactPayload("key-wrapper", "passkey.main", { ...wrapper, kind: "device-storage" }), /kind/);
});

test("pairing artifacts expose only protocol metadata and expire within ten minutes", () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const payload = {
    format: "taskliner-pairing-artifact",
    version: 1,
    kind: "pairing-offer",
    offerId: "offer-1",
    pairingId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    workspaceId: "workspace-1",
    keyId: "key-1",
    accountIdHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    inviterDeviceId: "device-1",
    inviterDeviceName: "PC",
    inviterPublicKey: {
      kty: "EC", crv: "P-256",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      y: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ext: true, key_ops: [],
    },
    proof: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    createdAt: now,
    expiresAt: now + 9 * 60 * 1000,
  };
  assert.equal(validateArtifactPayload("pairing-offer", "offer-1", payload, { now }), payload);
  const { proof: _proof, ...withoutProof } = payload;
  assert.throws(() => validateArtifactPayload("pairing-offer", "offer-1", withoutProof, { now }), /proof/);
  assert.throws(() => validateArtifactPayload("pairing-offer", "offer-1", { ...payload, proof: "AAAAAAAAAAAAAAAAAAAAAA" }, { now }), /proof/);
  assert.throws(
    () => validateArtifactPayload("pairing-offer", "offer-1", { ...payload, expiresAt: now + 11 * 60 * 1000 }, { now }),
    /expiry/,
  );
});

test("Function outer validation accepts the browser pairing offer, request, and encrypted response", async () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const registry = new PairingUseRegistry();
  const created = await createPairingOffer({
    workspaceId: "workspace-1", keyId: "key-1", inviterDeviceId: "device-a",
    inviterDeviceName: "PC", accountId: "account-1", now, registry,
  });
  validateArtifactPayload("pairing-offer", created.offer.offerId, created.offer, { now: now + 1 });
  const requested = await createPairingRequest({
    offer: created.offer, inviteSecret: created.inviteSecret, requesterDeviceId: "device-b",
    requesterDeviceName: "Phone", accountId: "account-1", now: now + 1000, registry,
  });
  validateArtifactPayload("pairing-request", requested.request.requestId, requested.request, { now: now + 1001 });
  const approved = await approvePairingRequest({
    offer: created.offer, request: requested.request, inviterPrivateKey: created.inviterPrivateKey,
    inviteSecret: created.inviteSecret, accountId: "account-1", wdk: new Uint8Array(32), now: now + 2000, registry,
  });
  validateArtifactPayload("pairing-response", approved.response.responseId, approved.response, { now: now + 2001 });
});

test("v3 preview flag is restricted to preview hosts", () => {
  assert.equal(isV3SyncEnabled({ TASKLINER_SYNC_V3: "preview" }, "https://branch.taskliner.pages.dev/api/sync"), true);
  assert.equal(isV3SyncEnabled({ TASKLINER_SYNC_V3: "preview" }, "https://taskliner.app/api/sync"), false);
  assert.equal(isV3SyncEnabled({ TASKLINER_SYNC_V3: "enabled" }, "https://taskliner.app/api/sync"), true);
});

test("getV3Snapshot excludes stale device and shared-setting files before download and fingerprinting", async () => {
  const now = Date.parse("2026-07-16T00:00:00.000Z");
  const activeTime = new Date(now - STALE_DEVICE_AFTER_MS + 1).toISOString();
  const staleTime = new Date(now - STALE_DEVICE_AFTER_MS - 1).toISOString();
  const files = [
    {
      id: "active-device-file", name: "taskliner-device-v3.device-active.json", modifiedTime: activeTime, version: "3", size: "256",
      appProperties: { taskliner: "sync", kind: "device-envelope", artifactId: "device-active", version: "3" },
    },
    {
      id: "stale-device-file", name: "taskliner-device-v3.device-stale.json", modifiedTime: staleTime, version: "7", size: "256",
      appProperties: { taskliner: "sync", kind: "device-envelope", artifactId: "device-stale", version: "3" },
    },
    {
      id: "stale-setting-file", name: "taskliner-shared-setting-v1.integrations.discord.device-stale.json", modifiedTime: staleTime, version: "5", size: "256",
      appProperties: { taskliner: "sync", kind: "shared-setting", artifactId: "integrations.discord.device-stale", version: "1" },
    },
  ];
  const activeEnvelope = {
    format: "taskliner-device-envelope", version: 3, workspaceId: "workspace-1", keyId: "key-1", deviceId: "device-active", cipher,
  };
  const env = {
    AUTH_SECRET: "test-auth-secret-that-is-long-enough",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    DB: { prepare() { return { bind() { return { async first() { return { workspace_id: "workspace-1", key_id: "key-1", e2ee_status: "encrypted-active" }; } }; } }; } },
  };
  const user = {
    google_sub: "google-1",
    refresh_token_ciphertext: await encryptSecret(env.AUTH_SECRET, "refresh-token"),
  };
  const downloaded = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "drive-token" });
    if (url.includes("/drive/v3/files?")) return Response.json({ files });
    if (url.includes("alt=media")) {
      downloaded.push(url);
      if (url.includes("active-device-file")) return Response.json(activeEnvelope);
      throw new Error(`A stale artifact was downloaded: ${url}`);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const snapshot = await getV3Snapshot(env, user, { now });
    assert.deepEqual(snapshot.artifacts.map((entry) => entry.artifactId), ["device-active"]);
    assert.equal(downloaded.length, 1);
    assert.match(snapshot.fingerprint, /active-device-file/);
    assert.doesNotMatch(snapshot.fingerprint, /stale/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sync mutations require an allowed same-origin Origin header", () => {
  const valid = new Request("https://taskliner.app/api/sync", { method: "PUT", headers: { Origin: "https://taskliner.app" } });
  assert.doesNotThrow(() => assertMutationOrigin(valid, {}));
  const missing = new Request("https://taskliner.app/api/sync", { method: "PUT" });
  assert.throws(() => assertMutationOrigin(missing, {}), /required/);
  const foreign = new Request("https://taskliner.app/api/sync", { method: "PUT", headers: { Origin: "https://evil.example" } });
  assert.throws(() => assertMutationOrigin(foreign, {}), /not allowed/);
});

test("D1 schema stores only non-secret E2EE cutover metadata", () => {
  const schema = readFileSync(new URL("../functions/schema.sql", import.meta.url), "utf8");
  for (const column of ["workspace_id", "key_id", "e2ee_status", "legacy_fingerprint", "cutover_lock_token", "cutover_lock_expires_at"]) {
    assert.match(schema, new RegExp(`\\b${column}\\b`));
  }
  assert.doesNotMatch(schema, /webhook|workspace_data_key|task_body/i);
});

test("Function migration response encrypts legacy states for the client's ephemeral P-256 key", async () => {
  const client = await generateMigrationClientKeyPair();
  const states = [{ format: "opaque-test-state", title: "not present outside ciphertext" }];
  const bundle = await encryptLegacyMigrationBundle(states, "legacy-fingerprint-1", client.migrationPublicKey);
  assert.equal(JSON.stringify(bundle).includes("not present outside ciphertext"), false);
  assert.deepEqual(
    await decryptLegacyMigrationBundle(bundle, client.privateKey, {
      expectedFingerprint: "legacy-fingerprint-1",
      validateState: () => true,
    }),
    { states },
  );
});

test("a new workspace is atomically claimed before encrypted artifact uploads", async () => {
  const row = {
    google_sub: "google-1",
    workspace_id: null,
    key_id: null,
    e2ee_status: "legacy",
    legacy_fingerprint: null,
    cutover_lock_token: null,
    cutover_lock_expires_at: null,
    cutover_verified_at: null,
  };
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return { ...row }; },
            async run() {
              if (sql.includes("SET workspace_id = ?1")) {
                if (row.e2ee_status !== "legacy") return { meta: { changes: 0 } };
                Object.assign(row, {
                  workspace_id: args[0], key_id: args[1], e2ee_status: "migrating",
                  cutover_lock_token: args[2], cutover_lock_expires_at: args[3],
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("e2ee_status = 'encrypted-active'")) {
                row.e2ee_status = "encrypted-active";
                row.cutover_lock_token = null;
                row.cutover_lock_expires_at = null;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
  const env = {
    AUTH_SECRET: "test-auth-secret-that-is-long-enough",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    DB,
  };
  const user = {
    google_sub: row.google_sub,
    refresh_token_ciphertext: await encryptSecret(env.AUTH_SECRET, "refresh-token"),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("oauth2.googleapis.com")
    ? Response.json({ access_token: "drive-token" })
    : Response.json({ files: [] });
  try {
    assert.deepEqual(await initializeE2eeWorkspace(env, user, { workspaceId: "workspace-1", keyId: "key-1" }), {
      status: "encrypted-active",
      workspaceId: "workspace-1",
      keyId: "key-1",
    });
    assert.equal(row.e2ee_status, "encrypted-active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired unverified migration can restart with a new key and removes abandoned v3 artifacts", async () => {
  const now = Date.parse("2026-07-17T00:20:00.000Z");
  const legacyFile = {
    id: "legacy-file-1",
    name: "taskliner-device-v2.device-a.json",
    modifiedTime: "2026-07-16T00:00:00.000Z",
    version: "8",
    appProperties: { taskliner: "sync", format: "taskliner-device-state", version: "1", deviceId: "device-a" },
  };
  const abandonedArtifact = {
    id: "abandoned-v3-file",
    name: artifactFileName("device-envelope", "device-old"),
    modifiedTime: "2026-07-16T00:01:00.000Z",
    version: "2",
    appProperties: artifactAppProperties("device-envelope", "device-old"),
  };
  const fixture = JSON.parse(await readFile(new URL("./fixtures/taskliner-v1.json", import.meta.url), "utf8"));
  const legacyState = createDeviceState({
    doc: fixture,
    workspaceId: "taskliner-google-account-v1",
    deviceId: "device-a",
    generatedAt: legacyFile.modifiedTime,
  });
  const expectedFingerprint = fileFingerprint([legacyFile]);
  const row = {
    google_sub: "google-1",
    workspace_id: "abandoned-workspace",
    key_id: "abandoned-key",
    e2ee_status: "migrating",
    legacy_fingerprint: expectedFingerprint,
    cutover_lock_token: "expired-lock",
    cutover_lock_expires_at: new Date(now - 1000).toISOString(),
    cutover_verified_at: null,
  };
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return { ...row }; },
            async run() {
              if (sql.includes("SET workspace_id = ?1")) {
                Object.assign(row, {
                  workspace_id: args[0], key_id: args[1], e2ee_status: "migrating",
                  legacy_fingerprint: args[2], cutover_lock_token: args[3], cutover_lock_expires_at: args[4],
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    AUTH_SECRET: "test-auth-secret-that-is-long-enough",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    DB,
  };
  const user = {
    google_sub: row.google_sub,
    refresh_token_ciphertext: await encryptSecret(env.AUTH_SECRET, "refresh-token"),
  };
  const client = await generateMigrationClientKeyPair();
  const deleted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "drive-token" });
    if (url.includes("/drive/v3/files?")) return Response.json({ files: [legacyFile, abandonedArtifact] });
    if (url.includes("legacy-file-1?alt=media")) return Response.json(legacyState);
    if (options.method === "DELETE" && url.includes("abandoned-v3-file")) {
      deleted.push(abandonedArtifact.id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const result = await beginE2eeMigration(env, user, {
      workspaceId: "workspace-new",
      keyId: "key-new",
      expectedFingerprint,
      migrationPublicKey: client.migrationPublicKey,
    }, { now });
    assert.equal(result.workspaceId, "workspace-new");
    assert.equal(result.keyId, "key-new");
    assert.equal(row.workspace_id, "workspace-new");
    assert.equal(row.key_id, "key-new");
    assert.deepEqual(deleted, [abandonedArtifact.id]);
    assert.deepEqual(
      await decryptLegacyMigrationBundle(result.legacyBundle, client.privateKey, {
        expectedFingerprint,
        validateState: () => true,
      }),
      { states: [legacyState] },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed legacy delete stays migrating and the same cutover can be retried", async () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const legacyFile = {
    id: "legacy-file-1",
    name: "taskliner-device-v2.device-a.json",
    modifiedTime: "2026-07-14T00:00:00.000Z",
    version: "7",
    appProperties: { taskliner: "sync", format: "taskliner-device-state", version: "1", deviceId: "device-a" },
  };
  const expectedFingerprint = fileFingerprint([legacyFile]);
  const fixture = JSON.parse(await readFile(new URL("./fixtures/taskliner-v1.json", import.meta.url), "utf8"));
  const legacyState = createDeviceState({
    doc: fixture,
    workspaceId: "taskliner-google-account-v1",
    deviceId: "device-a",
    generatedAt: "2026-07-14T00:00:00.000Z",
  });
  const row = {
    workspace_id: "workspace-1",
    key_id: "key-1",
    e2ee_status: "migrating",
    legacy_fingerprint: expectedFingerprint,
    cutover_lock_token: "lock-1",
    cutover_lock_expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    cutover_verified_at: new Date(now - 1000).toISOString(),
  };
  const DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() { return { ...row }; },
            async run() {
              if (sql.includes("e2ee_status = 'encrypted-active'")) {
                row.e2ee_status = "encrypted-active";
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    AUTH_SECRET: "test-auth-secret-that-is-long-enough",
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    DB,
  };
  const user = {
    google_sub: "google-1",
    refresh_token_ciphertext: await encryptSecret(env.AUTH_SECRET, "refresh-token"),
  };
  let deleted = false;
  let failDelete = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "drive-token" });
    if (url.includes("alt=media")) return Response.json(legacyState);
    if (options.method === "DELETE") {
      if (failDelete) return new Response("delete failed", { status: 500 });
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.includes("/drive/v3/files?")) return Response.json({ files: deleted ? [] : [legacyFile] });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await assert.rejects(
      activateE2eeMigration(env, user, { lockToken: "lock-1", expectedFingerprint }, { now }),
      /delete returned 500/,
    );
    assert.equal(row.e2ee_status, "migrating");
    failDelete = false;
    assert.deepEqual(
      await activateE2eeMigration(env, user, { lockToken: "lock-1", expectedFingerprint }, { now }),
      { status: "encrypted-active", workspaceId: "workspace-1", keyId: "key-1", deletedLegacyFiles: 1 },
    );
    assert.equal(row.e2ee_status, "encrypted-active");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cutover returns a 409 conflict when the v2 fingerprint changed", async () => {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const row = {
    workspace_id: "workspace-1", key_id: "key-1", e2ee_status: "migrating",
    legacy_fingerprint: "original-fingerprint", cutover_lock_token: "lock-1",
    cutover_lock_expires_at: new Date(now + 600_000).toISOString(), cutover_verified_at: null,
  };
  const file = {
    id: "changed-file", name: "taskliner-device-v2.device-a.json", modifiedTime: "2026-07-15T00:00:00.000Z", version: "2",
    appProperties: { taskliner: "sync", format: "taskliner-device-state", deviceId: "device-a" },
  };
  const DB = {
    prepare() {
      return { bind() { return { async first() { return { ...row }; }, async run() { return { meta: { changes: 1 } }; } }; } };
    },
  };
  const env = { AUTH_SECRET: "test-auth-secret-that-is-long-enough", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", DB };
  const user = { google_sub: "google-1", refresh_token_ciphertext: await encryptSecret(env.AUTH_SECRET, "refresh-token") };
  const state = {
    format: "taskliner-device-state", version: 1, workspaceId: "taskliner-google-account-v1", deviceId: "device-a",
    generatedAt: "2026-07-15T00:00:00.000Z", lamportCounter: 0, nodes: {}, tombstones: {}, conflicts: [], workspaceSettings: {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "drive-token" });
    if (url.includes("alt=media")) return Response.json(state);
    return Response.json({ files: [file] });
  };
  try {
    await assert.rejects(
      activateE2eeMigration(env, user, { lockToken: "lock-1", expectedFingerprint: "original-fingerprint", verifiedV3Fingerprint: "v3" }, { now }),
      (error) => error?.status === 409 && error?.code === "legacy_changed",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
