import assert from "node:assert/strict";
import test from "node:test";

import { createSyncContentSnapshot, hasSyncContentChanged } from "../src/sync/content-snapshot.mjs";

function documentFixture() {
  return {
    nodes: {
      root: {
        id: "root",
        title: "Plan",
        note: "One note",
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: 1,
        completedAt: null,
        dueAt: null,
      },
    },
    rootIds: ["root"],
    selectedId: null,
    ui: { tab: "active", theme: "easygoing", activeQuery: "" },
  };
}

test("view-only changes do not alter the sync content snapshot", () => {
  const doc = documentFixture();
  const before = createSyncContentSnapshot(doc);
  doc.selectedId = "root";
  doc.nodes.root.collapsed = true;
  doc.ui = { tab: "archive", theme: "geek", activeQuery: "plan", zoomId: "root" };
  assert.equal(hasSyncContentChanged(before, doc), false);
});

test("task content and tree changes alter the sync content snapshot", () => {
  for (const mutate of [
    (doc) => { doc.nodes.root.title = "Changed"; },
    (doc) => { doc.nodes.root.note = "Changed"; },
    (doc) => { doc.nodes.root.dueAt = 5; },
    (doc) => { doc.nodes.root.completedAt = 6; },
    (doc) => {
      doc.nodes.child = { id: "child", title: "Child", note: "", parentId: "root", childIds: [], createdAt: 2, completedAt: null, dueAt: null };
      doc.nodes.root.childIds.push("child");
    },
  ]) {
    const doc = documentFixture();
    const before = createSyncContentSnapshot(doc);
    mutate(doc);
    assert.equal(hasSyncContentChanged(before, doc), true);
  }
});
