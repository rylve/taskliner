import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleBrowserAuth } from "../src/google/google-auth.mjs";
import { DRIVE_APPDATA_SCOPE } from "../src/google/google-identity.mjs";

test("browser auth requests only drive.appdata and keeps the token in memory", async () => {
  let requestOptions;
  let requestArgs;
  const auth = createGoogleBrowserAuth({
    clientId: "client-id",
    getOauthApi: () => ({
      initTokenClient(options) {
        requestOptions = options;
        return {
          requestAccessToken(args) {
            requestArgs = args;
            options.callback({ access_token: "token", expires_in: 3600 });
          },
        };
      },
    }),
  });

  assert.equal(await auth.connect(), "token");
  assert.equal(requestOptions.scope, DRIVE_APPDATA_SCOPE);
  assert.equal(requestOptions.client_id, "client-id");
  assert.deepEqual(requestArgs, { prompt: "consent" });
  assert.equal(auth.hasToken(), true);
  auth.clear();
  assert.equal(auth.hasToken(), false);
  assert.equal(await auth.restore(), true);
  assert.deepEqual(requestArgs, { prompt: "" });
});

test("browser auth surfaces GIS errors without persisting a token", async () => {
  const auth = createGoogleBrowserAuth({
    clientId: "client-id",
    getOauthApi: () => ({
      initTokenClient(options) {
        return { requestAccessToken: () => options.callback({ error: "access_denied" }) };
      },
    }),
  });

  await assert.rejects(auth.connect(), /access_denied/);
  assert.equal(auth.hasToken(), false);
});
