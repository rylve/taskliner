const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Validate the persisted document shape without modifying it.
 * @param {any} doc
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTree(doc) {
  const errors = [];
  if (!isRecord(doc)) return { ok: false, errors: ["document must be an object"] };
  if (!isRecord(doc.nodes)) return { ok: false, errors: ["nodes must be an object"] };
  if (!Array.isArray(doc.rootIds)) errors.push("rootIds must be an array");

  const nodes = doc.nodes;
  const nodeIds = new Set(Object.keys(nodes));
  const rootIds = Array.isArray(doc.rootIds) ? doc.rootIds : [];
  const seenRoots = new Set();

  for (const rootId of rootIds) {
    if (typeof rootId !== "string") {
      errors.push("rootIds must contain strings");
      continue;
    }
    if (seenRoots.has(rootId)) errors.push(`duplicate root id: ${rootId}`);
    seenRoots.add(rootId);
    if (!nodeIds.has(rootId)) errors.push(`root points to missing node: ${rootId}`);
  }

  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node)) {
      errors.push(`node is not an object: ${id}`);
      continue;
    }
    if (node.id !== id) errors.push(`node id mismatch: ${id}`);
    if (typeof node.title !== "string") errors.push(`title must be a string: ${id}`);
    if (typeof node.note !== "string") errors.push(`note must be a string: ${id}`);
    if (typeof node.collapsed !== "boolean") errors.push(`collapsed must be boolean: ${id}`);
    if (!Number.isFinite(node.createdAt)) errors.push(`createdAt must be finite: ${id}`);
    if (node.completedAt !== null && !Number.isFinite(node.completedAt)) {
      errors.push(`completedAt must be null or finite: ${id}`);
    }
    if (node.dueAt !== null && !Number.isFinite(node.dueAt)) {
      errors.push(`dueAt must be null or finite: ${id}`);
    }
    if (node.parentId !== null && typeof node.parentId !== "string") {
      errors.push(`parentId must be null or string: ${id}`);
    } else if (typeof node.parentId === "string" && !nodeIds.has(node.parentId)) {
      errors.push(`parent points to missing node: ${id}`);
    }
    if (!Array.isArray(node.childIds)) {
      errors.push(`childIds must be an array: ${id}`);
      continue;
    }
    const childIds = new Set();
    for (const childId of node.childIds) {
      if (typeof childId !== "string") {
        errors.push(`childIds must contain strings: ${id}`);
        continue;
      }
      if (childIds.has(childId)) errors.push(`duplicate child id: ${id}/${childId}`);
      childIds.add(childId);
      if (!nodeIds.has(childId)) {
        errors.push(`child points to missing node: ${id}/${childId}`);
      } else if (nodes[childId]?.parentId !== id) {
        errors.push(`parent/child mismatch: ${id}/${childId}`);
      }
    }
  }

  const expectedRoots = new Set(
    Object.values(nodes)
      .filter((node) => isRecord(node) && node.parentId === null)
      .map((node) => node.id)
  );
  for (const id of expectedRoots) {
    if (!seenRoots.has(id)) errors.push(`root node is missing from rootIds: ${id}`);
  }
  for (const id of seenRoots) {
    if (!expectedRoots.has(id)) errors.push(`rootIds contains a child node: ${id}`);
  }

  const visited = new Set();
  const visiting = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      errors.push(`cycle detected at node: ${id}`);
      return;
    }
    if (visited.has(id)) return;
    const node = nodes[id];
    if (!node || !Array.isArray(node.childIds)) return;
    visiting.add(id);
    for (const childId of node.childIds) visit(childId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const rootId of rootIds) {
    if (typeof rootId === "string") visit(rootId);
  }
  for (const id of nodeIds) {
    if (!visited.has(id)) errors.push(`node is unreachable from rootIds: ${id}`);
  }

  return { ok: errors.length === 0, errors };
}
