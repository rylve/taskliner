export function getNode(doc, id) {
  return id && doc?.nodes ? doc.nodes[id] || null : null;
}

export function isActive(node) {
  return !!(node && node.completedAt == null);
}

export function isCompleted(node) {
  return !!(node && node.completedAt != null);
}

export function childrenOf(doc, id) {
  const node = getNode(doc, id);
  if (!node || !Array.isArray(node.childIds)) return [];
  return node.childIds.map((childId) => getNode(doc, childId)).filter(Boolean);
}

export function activeChildrenOf(doc, id) {
  return childrenOf(doc, id).filter(isActive);
}

export function siblingList(doc, id) {
  const node = getNode(doc, id);
  if (!node) return null;
  if (node.parentId == null) return Array.isArray(doc.rootIds) ? doc.rootIds : null;
  const parent = getNode(doc, node.parentId);
  return parent && Array.isArray(parent.childIds) ? parent.childIds : null;
}

export function depthOf(doc, id) {
  let depth = 0;
  let current = getNode(doc, id);
  const visited = new Set();
  while (current?.parentId) {
    if (visited.has(current.id)) return depth;
    visited.add(current.id);
    depth += 1;
    current = getNode(doc, current.parentId);
  }
  return depth;
}

export function isAncestor(doc, maybeAncestorId, nodeId) {
  let current = getNode(doc, nodeId);
  const visited = new Set();
  while (current) {
    if (current.id === maybeAncestorId) return true;
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    current = current.parentId ? getNode(doc, current.parentId) : null;
  }
  return false;
}

export function ancestorIds(doc, id) {
  const ids = [];
  let current = getNode(doc, id);
  const visited = new Set();
  while (current?.parentId) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    ids.unshift(current.parentId);
    current = getNode(doc, current.parentId);
  }
  return ids;
}

export function ancestorChain(doc, id) {
  return [...ancestorIds(doc, id), id].map((nodeId) => getNode(doc, nodeId)).filter(Boolean);
}

export function collectDescendantIds(doc, id) {
  const ids = [];
  const visited = new Set([id]);
  const walk = (nodeId) => {
    for (const child of childrenOf(doc, nodeId)) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      ids.push(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return ids;
}

export function categoryRootOf(doc, id, categoryMode = !!doc?.ui?.categoryMode) {
  if (!categoryMode) return null;
  let current = getNode(doc, id);
  if (!current || current.parentId == null) return null;
  const visited = new Set();
  while (current?.parentId) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);
    const parent = getNode(doc, current.parentId);
    if (!parent) return null;
    if (parent.parentId == null) return parent;
    current = parent;
  }
  return null;
}

export function canMoveNode(doc, id, parentId) {
  const node = getNode(doc, id);
  if (!isActive(node)) return false;
  const oldList = siblingList(doc, id);
  if (!oldList || !oldList.includes(id)) return false;
  if (parentId == null) return Array.isArray(doc.rootIds);
  const parent = getNode(doc, parentId);
  return isActive(parent) && parentId !== id && !isAncestor(doc, id, parentId);
}

export function canIndentNode(doc, id) {
  const node = getNode(doc, id);
  const siblings = siblingList(doc, id);
  if (!isActive(node) || !siblings) return false;
  const index = siblings.indexOf(id);
  return index > 0 && isActive(getNode(doc, siblings[index - 1]));
}

export function canOutdentNode(doc, id) {
  const node = getNode(doc, id);
  return isActive(node) && !!node.parentId && isActive(getNode(doc, node.parentId));
}

export function canReorderNode(doc, id, delta) {
  const node = getNode(doc, id);
  const siblings = siblingList(doc, id);
  if (!isActive(node) || !siblings) return false;
  const index = siblings.indexOf(id);
  const target = index + delta;
  return index >= 0 && target >= 0 && target < siblings.length;
}
