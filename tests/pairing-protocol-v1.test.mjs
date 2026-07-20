import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkspaceDataKey } from "../src/crypto/device-envelope-v3.mjs";
import {
  PairingUseRegistry,
  acceptPairingResponse,
  approvePairingRequest,
  createPairingOffer,
  createPairingRequest,
  decodeCrockfordBase32,
  encodeCrockfordBase32,
  inspectPairingRequest,
  parsePairingQrFragment,
} from "../src/pairing/pairing-protocol-v1.mjs";

const now = 1_800_000_000_000;
const accountId = "google-subject-1";

async function setup() {
  const sourceRegistry = new PairingUseRegistry();
  const targetRegistry = new PairingUseRegistry();
  const source = await createPairingOffer({
    workspaceId: "workspace-1",
    keyId: "key-1",
    inviterDeviceId: "desktop-1",
    inviterDeviceName: "Desktop",
    accountId,
    now,
    registry: sourceRegistry,
  });
  const target = await createPairingRequest({
    offer: source.offer,
    inviteCode: source.inviteCode,
    requesterDeviceId: "laptop-2",
    requesterDeviceName: "Laptop",
    accountId,
    now: now + 100,
    registry: targetRegistry,
  });
  return { source, target, sourceRegistry, targetRegistry };
}

test("QR fragment and Crockford code carry the same 128-bit invite secret", async () => {
  const { source } = await setup();
  assert.deepEqual(decodeCrockfordBase32(source.inviteCode), source.inviteSecret);
  assert.equal(encodeCrockfordBase32(source.inviteSecret), source.inviteCode);
  const qr = parsePairingQrFragment(source.qrFragment);
  assert.equal(qr.offerId, source.offer.offerId);
  assert.deepEqual(qr.inviteSecret, source.inviteSecret);
  assert.equal(source.qrFragment.startsWith("#"), true);
  assert.equal(JSON.stringify(source.offer).includes(source.inviteCode), false);
});

test("pairing requires inspection then explicit approval before transferring WDK", async () => {
  const { source, target, sourceRegistry, targetRegistry } = await setup();
  const beforeApproval = await inspectPairingRequest({
    offer: source.offer,
    request: target.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    now: now + 200,
    registry: sourceRegistry,
  });
  assert.equal(Object.hasOwn(beforeApproval, "wdk"), false);
  assert.equal(beforeApproval.requesterDeviceName, "Laptop");

  const wdk = generateWorkspaceDataKey();
  const approved = await approvePairingRequest({
    offer: source.offer,
    request: target.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    wdk,
    now: now + 300,
    registry: sourceRegistry,
  });
  const accepted = await acceptPairingResponse({
    offer: source.offer,
    request: target.request,
    response: approved.response,
    requesterPrivateKey: target.requesterPrivateKey,
    inviteSecret: target.inviteSecret,
    accountId,
    now: now + 400,
    registry: targetRegistry,
  });
  assert.deepEqual(accepted.wdk, wdk);
  assert.deepEqual(accepted.confirmationWords, approved.confirmationWords);
  assert.equal(accepted.confirmationWords.length, 4);
  assert.ok(accepted.confirmationWords.every((part) => /^(?:0[1-9]|[1-5][0-9]|6[0-4])$/u.test(part)));
  assert.equal(JSON.stringify(approved.response).includes(JSON.stringify([...wdk])), false);
});

test("pairing rejects a wrong code and another Google account", async () => {
  const { source } = await setup();
  const wrongLast = source.inviteCode.endsWith("0") ? "1" : "0";
  const wrongCode = `${source.inviteCode.slice(0, -1)}${wrongLast}`;
  await assert.rejects(() => createPairingRequest({
    offer: source.offer,
    inviteCode: wrongCode,
    requesterDeviceId: "other",
    requesterDeviceName: "Other",
    accountId,
    now: now + 1,
    registry: new PairingUseRegistry(),
  }), /incorrect|invalid/);
  await assert.rejects(() => createPairingRequest({
    offer: source.offer,
    inviteCode: source.inviteCode,
    requesterDeviceId: "other",
    requesterDeviceName: "Other",
    accountId: "another-google-subject",
    now: now + 1,
    registry: new PairingUseRegistry(),
  }), /another Google account/);
});

test("pairing rejects expiration, request tampering, and response tampering", async () => {
  const { source, target, sourceRegistry, targetRegistry } = await setup();
  await assert.rejects(() => inspectPairingRequest({
    offer: source.offer,
    request: target.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    now: source.offer.expiresAt + 1,
    registry: sourceRegistry,
  }), /expired/);

  const changedRequest = structuredClone(target.request);
  changedRequest.requesterDeviceName = "Mallory";
  await assert.rejects(() => inspectPairingRequest({
    offer: source.offer,
    request: changedRequest,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    now: now + 200,
    registry: sourceRegistry,
  }), /authentication failed/);

  const approved = await approvePairingRequest({
    offer: source.offer,
    request: target.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    wdk: generateWorkspaceDataKey(),
    now: now + 300,
    registry: sourceRegistry,
  });
  const changedResponse = structuredClone(approved.response);
  changedResponse.cipher.ciphertext = `${changedResponse.cipher.ciphertext[0] === "A" ? "B" : "A"}${changedResponse.cipher.ciphertext.slice(1)}`;
  await assert.rejects(() => acceptPairingResponse({
    offer: source.offer,
    request: target.request,
    response: changedResponse,
    requesterPrivateKey: target.requesterPrivateKey,
    inviteSecret: target.inviteSecret,
    accountId,
    now: now + 400,
    registry: targetRegistry,
  }), /authentication failed/);
});

test("pairing registry prevents approval, response, and cancelled-offer reuse", async () => {
  const { source, target } = await setup();
  const sourceRegistry = new PairingUseRegistry();
  const wdk = generateWorkspaceDataKey();
  const approved = await approvePairingRequest({
    offer: source.offer,
    request: target.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    wdk,
    now: now + 300,
    registry: sourceRegistry,
  });
  await assert.rejects(() => approvePairingRequest({
    offer: source.offer,
    request: target.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    wdk,
    now: now + 301,
    registry: sourceRegistry,
  }), /already been used/);

  const anotherTarget = await createPairingRequest({
    offer: source.offer,
    inviteCode: source.inviteCode,
    requesterDeviceId: "phone-3",
    requesterDeviceName: "Phone",
    accountId,
    now: now + 302,
    registry: new PairingUseRegistry(),
  });
  await assert.rejects(() => approvePairingRequest({
    offer: source.offer,
    request: anotherTarget.request,
    inviterPrivateKey: source.inviterPrivateKey,
    inviteSecret: source.inviteSecret,
    accountId,
    wdk,
    now: now + 303,
    registry: sourceRegistry,
  }), /already been used/);

  const targetRegistry = new PairingUseRegistry();
  const accept = () => acceptPairingResponse({
    offer: source.offer,
    request: target.request,
    response: approved.response,
    requesterPrivateKey: target.requesterPrivateKey,
    inviteSecret: target.inviteSecret,
    accountId,
    now: now + 400,
    registry: targetRegistry,
  });
  await accept();
  await assert.rejects(accept, /already been used/);

  const cancelled = new PairingUseRegistry();
  cancelled.cancelOffer(source.offer.offerId);
  await assert.rejects(() => createPairingRequest({
    offer: source.offer,
    inviteCode: source.inviteCode,
    requesterDeviceId: "new",
    requesterDeviceName: "New",
    accountId,
    now: now + 1,
    registry: cancelled,
  }), /already been used/);
});

test("pairing offer proof rejects field additions, field changes, proof changes, and excessive TTL", async () => {
  const { source } = await setup();
  const changes = [
    (offer) => { offer.workspaceId = "tampered-workspace"; },
    (offer) => { offer.inviterDeviceName = "Tampered device"; },
    (offer) => { offer.createdAt += 1; },
    (offer) => { offer.unexpected = true; },
    (offer) => { offer.proof = `${offer.proof[0] === "A" ? "B" : "A"}${offer.proof.slice(1)}`; },
  ];
  for (const change of changes) {
    const offer = structuredClone(source.offer);
    change(offer);
    await assert.rejects(() => createPairingRequest({
      offer,
      inviteSecret: source.inviteSecret,
      requesterDeviceId: "new-device",
      requesterDeviceName: "New device",
      accountId,
      now: now + 100,
      registry: new PairingUseRegistry(),
    }));
  }

  const excessive = structuredClone(source.offer);
  excessive.expiresAt = excessive.createdAt + 10 * 60 * 1000 + 1;
  await assert.rejects(() => createPairingRequest({
    offer: excessive,
    inviteSecret: source.inviteSecret,
    requesterDeviceId: "new-device",
    requesterDeviceName: "New device",
    accountId,
    now: now + 100,
    registry: new PairingUseRegistry(),
  }), /exceeds ten minutes/);
});

test("pairing refuses to operate without account identity and a use registry", async () => {
  const registry = new PairingUseRegistry();
  await assert.rejects(() => createPairingOffer({
    workspaceId: "workspace-1",
    keyId: "key-1",
    inviterDeviceId: "desktop-1",
    inviterDeviceName: "Desktop",
    now,
    registry,
  }), /Google account id is required/);
  const { source } = await setup();
  await assert.rejects(() => createPairingRequest({
    offer: source.offer,
    inviteSecret: source.inviteSecret,
    requesterDeviceId: "new-device",
    requesterDeviceName: "New device",
    accountId,
    now: now + 100,
  }), /registry is required/);
});
