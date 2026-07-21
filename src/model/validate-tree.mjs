const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function cloneJson(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Repair only the structural links of an active document projection.
 *
 * Split storage intentionally retains IDs for archived children so they can
 * return to their previous sibling position. Those external IDs may be kept
 * for local persistence, but must be removed from the projection used by sync.
 * parentId is the source of truth for active nodes.
 */
export function repairTreeLinks(doc, { preserveExternalIds = true } = {}) {
  if (!isRecord(doc) || !isRecord(doc.nodes)) return { changed: false };

  const nodes = doc.nodes;
  const ids = Object.keys(nodes).filter((id) => isRecord(nodes[id]));
  const nodeIds = new Set(ids);
  let changed = false;

  for (const id of ids) {
    const node = nodes[id];
    if (node.parentId === id || (node.parentId != null && !nodeIds.has(node.parentId))) {
      node.parentId = null;
      changed = true;
    }
  }

  // Break any remaining parent cycle deterministically by promoting the
  // lexicographically first node in that cycle to a root.
  for (const startId of [...ids].sort()) {
    const chain = [];
    const seenAt = new Map();
    let currentId = startId;
    while (currentId && nodeIds.has(currentId)) {
      if (seenAt.has(currentId)) {
        const cycle = chain.slice(seenAt.get(currentId));
        const breakId = [...cycle].sort()[0];
        if (nodes[breakId].parentId !== null) {
          nodes[breakId].parentId = null;
          changed = true;
        }
        break;
      }
      seenAt.set(currentId, chain.length);
      chain.push(currentId);
      currentId = nodes[currentId].parentId;
    }
  }

  const childrenByParent = new Map(ids.map((id) => [id, []]));
  for (const id of ids) {
    const parentId = nodes[id].parentId;
    if (parentId && childrenByParent.has(parentId)) childrenByParent.get(parentId).push(id);
  }

  for (const id of ids) {
    const node = nodes[id];
    const repaired = [];
    const seen = new Set();
    for (const childId of Array.isArray(node.childIds) ? node.childIds : []) {
      if (typeof childId !== "string" || seen.has(childId)) {
        changed = true;
        continue;
      }
      if (nodeIds.has(childId)) {
        if (nodes[childId].parentId !== id) {
          changed = true;
          continue;
        }
      } else if (!preserveExternalIds) {
        changed = true;
        continue;
      }
      seen.add(childId);
      repaired.push(childId);
    }
    for (const childId of childrenByParent.get(id) || []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      repaired.push(childId);
      changed = true;
    }
    if (!Array.isArray(node.childIds) || repaired.length !== node.childIds.length
        || repaired.some((childId, index) => childId !== node.childIds[index])) {
      node.childIds = repaired;
      changed = true;
    }
  }

  const repairedRoots = [];
  const seenRoots = new Set();
  for (const rootId of Array.isArray(doc.rootIds) ? doc.rootIds : []) {
    if (typeof rootId !== "string" || seenRoots.has(rootId)) {
      changed = true;
      continue;
    }
    if (nodeIds.has(rootId)) {
      if (nodes[rootId].parentId !== null) {
        changed = true;
        continue;
      }
    } else if (!preserveExternalIds) {
      changed = true;
      continue;
    }
    seenRoots.add(rootId);
    repairedRoots.push(rootId);
  }
  for (const id of ids) {
    if (nodes[id].parentId !== null || seenRoots.has(id)) continue;
    seenRoots.add(id);
    repairedRoots.push(id);
    changed = true;
  }
  if (!Array.isArray(doc.rootIds) || repairedRoots.length !== doc.rootIds.length
      || repairedRoots.some((rootId, index) => rootId !== doc.rootIds[index])) {
    doc.rootIds = repairedRoots;
    changed = true;
  }

  return { changed };
}

export function createActiveTreeProjection(doc) {
  const projected = cloneJson(doc);
  repairTreeLinks(projected, { preserveExternalIds: false });
  return projected;
}

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
