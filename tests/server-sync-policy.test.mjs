import assert from "node:assert/strict";
import test from "node:test";

import { STALE_DEVICE_AFTER_MS, deviceIdFromFile, isActiveDeviceFile, isActiveV3ArtifactFile } from "../functions/_lib/sync.mjs";

test("inactive device files are excluded after the documented retention window", () => {
  const now = Date.parse("2026-07-14T00:00:00.000Z");
  assert.equal(isActiveDeviceFile({ modifiedTime: new Date(now - STALE_DEVICE_AFTER_MS + 1).toISOString() }, now), true);
  assert.equal(isActiveDeviceFile({ modifiedTime: new Date(now - STALE_DEVICE_AFTER_MS - 1).toISOString() }, now), false);
});

test("legacy file names still provide a device identifier for stale-file recovery", () => {
  assert.equal(deviceIdFromFile({ name: "taskliner-device-v2.device-a.json" }), "device-a");
  assert.equal(deviceIdFromFile({ appProperties: { deviceId: "device-b" }, name: "other.json" }), "device-b");
});

test("v3 excludes stale device and shared-setting candidates but keeps key and pairing artifacts", () => {
  const now = Date.parse("2026-07-16T00:00:00.000Z");
  const stale = { modifiedTime: new Date(now - STALE_DEVICE_AFTER_MS - 1).toISOString() };
  const active = { modifiedTime: new Date(now - STALE_DEVICE_AFTER_MS + 1).toISOString() };
  assert.equal(isActiveV3ArtifactFile(stale, { kind: "device-envelope" }, now), false);
  assert.equal(isActiveV3ArtifactFile(stale, { kind: "shared-setting" }, now), false);
  assert.equal(isActiveV3ArtifactFile(active, { kind: "device-envelope" }, now), true);
  for (const kind of ["key-wrapper", "pairing-offer", "pairing-request", "pairing-response"]) {
    assert.equal(isActiveV3ArtifactFile(stale, { kind }, now), true);
  }
});
