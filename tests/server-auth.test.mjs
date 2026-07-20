import assert from "node:assert/strict";
import test from "node:test";

import { createAccountId, createSessionCookie, getSessionUser, upsertUser } from "../functions/_lib/auth.mjs";

function createDb() {
  const rows = new Map();
  return {
    rows,
    prepare() {
      return {
        bind(...args) {
          return {
            first: async () => rows.get(args[0]) || null,
            run: async () => {
              rows.set(args[0], {
                google_sub: args[0],
                email: args[1],
                refresh_token_ciphertext: args[2],
              });
            },
          };
        },
      };
    },
  };
}

test("a later OAuth callback without a refresh token preserves the stored token", async () => {
  const env = { AUTH_SECRET: "test-secret", DB: createDb() };
  await upsertUser(env, { googleSub: "google-sub", email: "one@example.com", refreshToken: "refresh-token" });
  const original = env.DB.rows.get("google-sub").refresh_token_ciphertext;
  await upsertUser(env, { googleSub: "google-sub", email: "two@example.com" });
  assert.equal(env.DB.rows.get("google-sub").refresh_token_ciphertext, original);
  assert.equal(env.DB.rows.get("google-sub").email, "two@example.com");
});

test("account IDs are stable without exposing the Google subject", async () => {
  const first = await createAccountId("test-secret", "google-sub");
  const same = await createAccountId("test-secret", "google-sub");
  const other = await createAccountId("test-secret", "other-sub");
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.equal(first.includes("google-sub"), false);
});

test("session lookup does not require sync v3 migration columns", async () => {
  const session = await createSessionCookie("test-secret", "google-sub");
  const DB = {
    prepare(sql) {
      assert.doesNotMatch(sql, /workspace_id|e2ee_status|cutover_/);
      return {
        bind(value) {
          return {
            first: async () => ({
              google_sub: value,
              email: "one@example.com",
              refresh_token_ciphertext: "encrypted-refresh-token",
            }),
          };
        },
      };
    },
  };
  const request = new Request("https://example.com/api/auth/me", {
    headers: { Cookie: `taskliner_session=${encodeURIComponent(session)}` },
  });
  const user = await getSessionUser(request, { AUTH_SECRET: "test-secret", DB });
  assert.equal(user.google_sub, "google-sub");
});

test("malformed session cookies are ignored instead of throwing", async () => {
  const request = new Request("https://example.com/api/auth/me", {
    headers: { Cookie: "taskliner_session=not-a-valid-token.%%%" },
  });
  const user = await getSessionUser(request, { AUTH_SECRET: "test-secret", DB: createDb() });
  assert.equal(user, null);
});
