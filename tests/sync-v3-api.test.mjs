import assert from "node:assert/strict";
import test from "node:test";

import { createSyncV3Api, SyncV3ConflictError } from "../src/google/sync-v3-api.mjs";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("sync v3 API relays encrypted artifacts without inspecting their payload", async () => {
  const calls = [];
  const api = createSyncV3Api({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true });
    },
  });
  const payload = { cipher: { nonce: "nonce", ciphertext: "opaque" } };
  await api.put("device-envelope", "device-1", payload);
  await api.list("key-wrapper");
  await api.delete("pairing-offer", "offer-1");
  await api.deleteAll();

  assert.equal(calls[0].url, "/api/sync?version=3");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    kind: "device-envelope",
    artifactId: "device-1",
    payload,
  });
  assert.match(calls[1].url, /version=3&kind=key-wrapper/);
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(calls[3].url, "/api/sync");
  assert.equal(calls[3].options.method, "DELETE");
  assert.equal(calls.every((call) => call.options.credentials === "include"), true);
});

test("sync v3 API exposes migration conflicts as a typed error", async () => {
  const api = createSyncV3Api({
    fetchImpl: async () => response({ code: "legacy_changed", message: "Legacy state changed" }, 409),
  });
  await assert.rejects(
    api.beginMigration({
      workspaceId: "workspace-1",
      keyId: "key-1",
      expectedFingerprint: "fingerprint-1",
      migrationPublicKey: { kty: "EC" },
    }),
    (error) => error instanceof SyncV3ConflictError && error.code === "legacy_changed",
  );
});

test("sync v3 API rejects unknown artifact kinds before making a request", async () => {
  let called = false;
  const api = createSyncV3Api({ fetchImpl: async () => { called = true; return response({}); } });
  assert.throws(() => api.put("plaintext-task", "task-1", {}), /Unsupported/);
  assert.equal(called, false);
});
