import { base64urlDecode, base64urlEncode, randomBytes } from "./e2ee-utils.mjs";
import {
  createPasskeyPrfExtension,
  extractPasskeyPrfResult,
  generatePasskeyPrfSalt,
} from "./passkey-prf.mjs";

function credentialsApi(value) {
  const api = value || globalThis.navigator?.credentials;
  if (!api || typeof api.create !== "function" || typeof api.get !== "function") {
    throw new Error("Passkeys are not available in this browser");
  }
  return api;
}

function buffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function createTasklinerPasskey({
  workspaceId,
  keyId,
  credentials,
  rpName = "Taskliner",
} = {}) {
  const api = credentialsApi(credentials);
  const prfSalt = generatePasskeyPrfSalt();
  const credential = await api.create({
    publicKey: {
      challenge: buffer(randomBytes(32)),
      rp: { name: rpName },
      user: {
        id: buffer(randomBytes(32)),
        name: `taskliner-${workspaceId}`,
        displayName: "Taskliner sync",
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: 120_000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      extensions: createPasskeyPrfExtension(prfSalt),
    },
  });
  if (!credential) throw new Error("Passkey creation was cancelled");
  const rawId = credential.rawId instanceof ArrayBuffer
    ? new Uint8Array(credential.rawId)
    : new Uint8Array(credential.rawId || []);
  if (!rawId.length) throw new Error("Passkey credential ID is missing");
  const prfResult = extractPasskeyPrfResult(credential);
  return {
    workspaceId,
    keyId,
    credentialId: base64urlEncode(rawId),
    prfSalt,
    prfResult,
    prfSupported: prfResult !== null,
  };
}

export async function getTasklinerPasskeyPrf(wrapper, { credentials } = {}) {
  const api = credentialsApi(credentials);
  const credentialId = wrapper?.metadata?.credentialId;
  const prfSalt = wrapper?.metadata?.prfSalt;
  if (typeof credentialId !== "string" || typeof prfSalt !== "string") {
    throw new Error("Passkey wrapper metadata is invalid");
  }
  const credential = await api.get({
    publicKey: {
      challenge: buffer(randomBytes(32)),
      allowCredentials: [{
        type: "public-key",
        id: buffer(base64urlDecode(credentialId, "credentialId")),
      }],
      timeout: 120_000,
      userVerification: "required",
      extensions: createPasskeyPrfExtension(base64urlDecode(prfSalt, "PRF salt")),
    },
  });
  if (!credential) throw new Error("Passkey authentication was cancelled");
  const prfResult = extractPasskeyPrfResult(credential);
  if (!prfResult) throw new Error("This passkey did not return a PRF result");
  return prfResult;
}
