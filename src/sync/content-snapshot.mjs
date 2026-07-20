function compareIds(left, right) {
  return left.localeCompare(right);
}

/**
 * Canonical snapshot of user content that is shared between devices.
 * Browser-only view state is intentionally excluded.
 */
export function createSyncContentSnapshot(doc) {
  const sourceNodes = doc?.nodes && typeof doc.nodes === "object" ? doc.nodes : {};
  const nodes = Object.keys(sourceNodes).sort(compareIds).map((id) => {
    const node = sourceNodes[id] || {};
    return {
      id,
      title: typeof node.title === "string" ? node.title : "",
      note: typeof node.note === "string" ? node.note : "",
      parentId: typeof node.parentId === "string" ? node.parentId : null,
      childIds: Array.isArray(node.childIds) ? node.childIds.filter((childId) => typeof childId === "string") : [],
      createdAt: Number.isFinite(node.createdAt) ? node.createdAt : null,
      completedAt: Number.isFinite(node.completedAt) ? node.completedAt : null,
      dueAt: Number.isFinite(node.dueAt) ? node.dueAt : null,
    };
  });
  const rootIds = Array.isArray(doc?.rootIds)
    ? doc.rootIds.filter((id) => typeof id === "string")
    : [];
  return JSON.stringify({ nodes, rootIds });
}

export function hasSyncContentChanged(previousSnapshot, doc) {
  return previousSnapshot !== createSyncContentSnapshot(doc);
}
