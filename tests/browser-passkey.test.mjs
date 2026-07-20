import assert from "node:assert/strict";
import test from "node:test";

import { createTasklinerPasskey, getTasklinerPasskeyPrf } from "../src/crypto/browser-passkey.mjs";
import { base64urlEncode } from "../src/crypto/e2ee-utils.mjs";

function credential({ prf = true } = {}) {
  return {
    rawId: new Uint8Array([1, 2, 3]).buffer,
    getClientExtensionResults() {
      return prf ? { prf: { results: { first: new Uint8Array(32).fill(7).buffer } } } : {};
    },
  };
}

test("passkey creation detects PRF from the actual extension result", async () => {
  let options;
  const result = await createTasklinerPasskey({
    workspaceId: "workspace-1",
    keyId: "key-1",
    credentials: {
      async create(value) { options = value; return credential(); },
      async get() {},
    },
  });
  assert.equal(result.prfSupported, true);
  assert.equal(result.credentialId, "AQID");
  assert.equal(options.publicKey.extensions.prf.eval.first.byteLength, 32);
  assert.equal(options.publicKey.authenticatorSelection.residentKey, "required");
});

test("an ignored PRF extension is reported as unsupported", async () => {
  const result = await createTasklinerPasskey({
    workspaceId: "workspace-1",
    keyId: "key-1",
    credentials: {
      async create() { return credential({ prf: false }); },
      async get() {},
    },
  });
  assert.equal(result.prfSupported, false);
  assert.equal(result.prfResult, null);
});

test("passkey unlock requests the synced credential and requires a PRF result", async () => {
  let options;
  const result = await getTasklinerPasskeyPrf({
    metadata: {
      credentialId: base64urlEncode(new Uint8Array([1, 2, 3])),
      prfSalt: base64urlEncode(new Uint8Array(32).fill(4)),
    },
  }, {
    credentials: {
      async create() {},
      async get(value) { options = value; return credential(); },
    },
  });
  assert.equal(result.length, 32);
  assert.deepEqual(new Uint8Array(options.publicKey.allowCredentials[0].id), new Uint8Array([1, 2, 3]));
  assert.equal(options.publicKey.userVerification, "required");
});
