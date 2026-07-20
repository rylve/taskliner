import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDeviceState, validateDeviceState } from "../src/sync/device-state.mjs";
import { validateTree } from "../src/model/validate-tree.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/taskliner-v1.json", import.meta.url), "utf8"));

test("createDeviceState converts the local document into stamped sync fields", () => {
  const state = createDeviceState({
    doc: fixture,
    workspaceId: "workspace-1",
    deviceId: "device-pc",
    lamportCounter: 7,
    generatedAt: "2026-07-14T00:00:00.000Z",
  });
  assert.equal(validateTree(fixture).ok, true);
  assert.equal(state.format, "taskliner-device-state");
  assert.equal(state.nodes.root.title.value, "Plan release");
  assert.deepEqual(state.nodes.root.title.stamp, { counter: 7, deviceId: "device-pc" });
  assert.equal(state.nodes.child.orderKey.value, "000000000000:child");
  assert.equal(validateDeviceState(state).ok, true);
});

test("validateDeviceState rejects cycles and oversized text before merge", () => {
  const state = createDeviceState({ doc: fixture, workspaceId: "workspace-1", deviceId: "device-pc" });
  state.nodes.child.parentId.value = "child";
  assert.equal(validateDeviceState(state).ok, false);

  const oversized = createDeviceState({ doc: fixture, workspaceId: "workspace-1", deviceId: "device-pc" });
  oversized.nodes.root.title.value = "x".repeat(21);
  assert.equal(validateDeviceState(oversized, { maxTextLength: 20 }).ok, false);
});
