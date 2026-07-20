import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryTokenProvider, DRIVE_APPDATA_SCOPE } from "../src/google/google-identity.mjs";

test("memory token provider requests only drive.appdata and never persists the token", async () => {
  let now = 1_000;
  const requests = [];
  const provider = createMemoryTokenProvider({
    now: () => now,
    requestAccessToken: async (request) => {
      requests.push(request);
      return { access_token: "secret-token", expires_in: 60 };
    },
  });

  assert.equal(await provider.getToken(), "secret-token");
  assert.equal(await provider.getToken(), "secret-token");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { scope: DRIVE_APPDATA_SCOPE, interactive: false });
  assert.equal(provider.hasToken(), true);
  assert.equal(provider.scope, DRIVE_APPDATA_SCOPE);
  provider.clear();
  assert.equal(provider.hasToken(), false);
  now += 61_000;
  await provider.getToken({ interactive: true });
  assert.equal(requests.length, 2);
});

