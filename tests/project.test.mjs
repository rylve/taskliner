import assert from "node:assert/strict";
import test from "node:test";
import { projectMergedState } from "../src/sync/project.mjs";

const stamp = (value, counter) => ({ value, stamp: { counter, deviceId: "device-a" } });

test("projectMergedState rebuilds parent links and hides tombstoned nodes", () => {
  const projected = projectMergedState({
    format: "taskliner-device-state",
    version: 1,
    nodes: {
      root: {
        id: "root",
        title: stamp("Root", 2),
        note: stamp("", 2),
        parentId: stamp(null, 2),
        orderKey: stamp("000000000000:root", 2),
        dueDate: stamp(null, 2),
        completedAt: stamp(null, 2),
        deletedAt: stamp(null, 2),
        createdAt: 1,
      },
      child: {
        id: "child",
        title: stamp("Child", 2),
        note: stamp("", 2),
        parentId: stamp("root", 2),
        orderKey: stamp("000000000000:child", 2),
        dueDate: stamp(null, 2),
        completedAt: stamp(null, 2),
        deletedAt: stamp(null, 2),
        createdAt: 2,
      },
      deleted: {
        id: "deleted",
        title: stamp("Gone", 3),
        note: stamp("", 3),
        parentId: stamp(null, 3),
        orderKey: stamp("000000000001:deleted", 3),
        dueDate: stamp(null, 3),
        completedAt: stamp(null, 3),
        deletedAt: stamp(4, 3),
        createdAt: 3,
      },
    },
    workspaceSettings: { titleWrap: stamp(true, 2) },
  }, { baseDoc: { ui: { titleWrap: false }, nodes: {} } });

  assert.deepEqual(projected.rootIds, ["root"]);
  assert.deepEqual(projected.nodes.root.childIds, ["child"]);
  assert.equal(projected.nodes.deleted, undefined);
  assert.equal(projected.ui.titleWrap, false);
});
