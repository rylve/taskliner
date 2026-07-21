import assert from "node:assert/strict";
import test from "node:test";

import { createSyncContentSnapshot } from "../src/sync/content-snapshot.mjs";
import { activeProjectionIsCurrent, createSyncApplyGuard } from "../src/sync/document-guard.mjs";

function node(id, { parentId = null, childIds = [], completedAt = null } = {}) {
  return { id, title: id, note: "", parentId, childIds, collapsed: false, createdAt: 1, completedAt, dueAt: null };
}

test("sync apply guard compares full documents while watching the active projection", async () => {
  const activeDoc = {
    rootIds: ["root"],
    nodes: {
      root: node("root", { childIds: ["archived"] }),
    },
  };
  const archived = node("archived", { parentId: "root", completedAt: 2 });
  const fullDoc = { ...activeDoc, nodes: { ...activeDoc.nodes, archived } };
  const storage = {
    async exportDocument(doc) {
      return { ...doc, nodes: { ...doc.nodes, archived } };
    },
  };

  assert.notEqual(createSyncContentSnapshot(activeDoc), createSyncContentSnapshot(fullDoc));
  const guard = await createSyncApplyGuard({
    storage,
    activeDoc,
    expectedFullSnapshot: createSyncContentSnapshot(fullDoc),
  });
  assert.equal(guard.matchesExpectedFullDocument, true);
  assert.equal(activeProjectionIsCurrent(guard.activeSnapshot, activeDoc), true);

  activeDoc.nodes.root.title = "edited during apply";
  assert.equal(activeProjectionIsCurrent(guard.activeSnapshot, activeDoc), false);
});
