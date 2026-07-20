import assert from "node:assert/strict";
import test from "node:test";

import { generateWorkspaceDataKey } from "../src/crypto/device-envelope-v3.mjs";
import { decryptSharedSetting, encryptSharedSetting } from "../src/crypto/shared-setting-envelope-v1.mjs";

test("shared Discord settings and null tombstones round-trip under the WDK", async () => {
  const wdk = generateWorkspaceDataKey();
  const options = { workspaceId: "workspace-1", keyId: "key-1", settingId: "integrations.discord", wdk };
  for (const value of [{ webhookUrl: "https://discord.com/api/webhooks/1/token", enabled: true }, null]) {
    const payload = { settingId: options.settingId, stamp: { counter: 2, deviceId: "device-a" }, value };
    const envelope = await encryptSharedSetting(payload, options);
    const restored = await decryptSharedSetting(envelope, wdk, {
      expectedWorkspaceId: options.workspaceId,
      expectedKeyId: options.keyId,
      expectedSettingId: options.settingId,
      validateValue: () => true,
    });
    assert.deepEqual(restored, payload);
  }
});

test("shared setting rejects outer identity and ciphertext tampering", async () => {
  const wdk = generateWorkspaceDataKey();
  const options = { workspaceId: "workspace-1", keyId: "key-1", settingId: "integrations.discord", wdk };
  const envelope = await encryptSharedSetting({
    settingId: options.settingId,
    stamp: { counter: 1, deviceId: "device-a" },
    value: { enabled: false },
  }, options);
  await assert.rejects(() => decryptSharedSetting({ ...envelope, keyId: "key-2" }, wdk, {
    expectedWorkspaceId: options.workspaceId,
    expectedKeyId: options.keyId,
    expectedSettingId: options.settingId,
    validateValue: () => true,
  }));
  const tampered = structuredClone(envelope);
  tampered.cipher.ciphertext = `${tampered.cipher.ciphertext[0] === "A" ? "B" : "A"}${tampered.cipher.ciphertext.slice(1)}`;
  await assert.rejects(() => decryptSharedSetting(tampered, wdk, {
    expectedWorkspaceId: options.workspaceId,
    expectedKeyId: options.keyId,
    expectedSettingId: options.settingId,
    validateValue: () => true,
  }));
});
