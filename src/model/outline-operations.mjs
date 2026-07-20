import {
  canIndentNode,
  canMoveNode,
  canOutdentNode,
  getNode,
  isActive,
  siblingList,
} from "./outline-selectors.mjs";

const unchanged = (reason) => ({ changed: false, reason });

function normalizeIndex(index, length) {
  if (index === "end") return length;
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.trunc(index), length));
}

export function createNode(doc, {
  id,
  title,
  parentId = null,
  index = "end",
  createdAt,
}) {
  if (!doc?.nodes || !Array.isArray(doc.rootIds)) return unchanged("invalid-document");
  if (typeof id !== "string" || !id || doc.nodes[id]) return unchanged("invalid-id");
  if (typeof title !== "string" || !Number.isFinite(createdAt)) return unchanged("invalid-node");
  const parent = parentId == null ? null : getNode(doc, parentId);
  if (parentId != null && !isActive(parent)) return unchanged("invalid-parent");
  const list = parent ? parent.childIds : doc.rootIds;
  if (!Array.isArray(list)) return unchanged("invalid-parent-list");
  const insertAt = normalizeIndex(index, list.length);
  doc.nodes[id] = {
    id,
    title,
    parentId,
    childIds: [],
    collapsed: false,
    createdAt,
    completedAt: null,
    dueAt: null,
    note: "",
    completedChildCount: 0,
  };
  list.splice(insertAt, 0, id);
  if (parent) parent.collapsed = false;
  return { changed: true, value: { id, parentId, index: insertAt } };
}

export function renameNode(doc, { id, title }) {
  const node = getNode(doc, id);
  if (!isActive(node) || typeof title !== "string") return unchanged("invalid-node");
  if (node.title === title) return unchanged("same-title");
  const previousTitle = node.title;
  node.title = title;
  return { changed: true, value: { id, previousTitle, title } };
}

export function setNodeNote(doc, { id, note }) {
  const node = getNode(doc, id);
  if (!isActive(node) || typeof note !== "string") return unchanged("invalid-node");
  if (node.note === note) return unchanged("same-note");
  const previousNote = node.note;
  node.note = note;
  return { changed: true, value: { id, previousNote, note } };
}

export function setNodeDueAt(doc, { id, dueAt }) {
  const node = getNode(doc, id);
  if (!isActive(node) || (dueAt !== null && !Number.isFinite(dueAt))) return unchanged("invalid-node");
  if (node.dueAt === dueAt) return unchanged("same-due-at");
  const previousDueAt = node.dueAt;
  node.dueAt = dueAt;
  return { changed: true, value: { id, previousDueAt, dueAt } };
}

export function setNodeCollapsed(doc, { id, collapsed }) {
  const node = getNode(doc, id);
  if (!node || typeof collapsed !== "boolean") return unchanged("invalid-node");
  if (node.collapsed === collapsed) return unchanged("same-collapsed");
  node.collapsed = collapsed;
  return { changed: true, value: { id, collapsed } };
}

export function toggleNodeCollapsed(doc, { id }) {
  const node = getNode(doc, id);
  if (!node) return unchanged("invalid-node");
  node.collapsed = !node.collapsed;
  return { changed: true, value: { id, collapsed: node.collapsed } };
}

export function moveNode(doc, { id, parentId, index = "end" }) {
  if (!canMoveNode(doc, id, parentId)) return unchanged("invalid-destination");
  const node = getNode(doc, id);
  const fromParentId = node.parentId;
  const oldList = siblingList(doc, id);
  const fromIndex = oldList.indexOf(id);
  const parent = parentId == null ? null : getNode(doc, parentId);
  const newList = parent ? parent.childIds : doc.rootIds;
  let requestedIndex = normalizeIndex(index, newList.length);

  if (fromParentId === parentId) {
    if (requestedIndex === fromIndex || requestedIndex === fromIndex + 1) return unchanged("same-position");
  }

  oldList.splice(fromIndex, 1);
  if (oldList === newList && fromIndex < requestedIndex) requestedIndex -= 1;
  const toIndex = normalizeIndex(requestedIndex, newList.length);
  newList.splice(toIndex, 0, id);
  node.parentId = parentId;
  if (parent) parent.collapsed = false;
  return {
    changed: true,
    value: { id, fromParentId, fromIndex, toParentId: parentId, toIndex },
  };
}

export function reorderNode(doc, { id, toIndex }) {
  const node = getNode(doc, id);
  const siblings = siblingList(doc, id);
  if (!isActive(node) || !siblings || !Number.isFinite(toIndex)) return unchanged("invalid-node");
  const fromIndex = siblings.indexOf(id);
  const target = Math.trunc(toIndex);
  if (fromIndex < 0 || target < 0 || target >= siblings.length) return unchanged("out-of-range");
  if (fromIndex === target) return unchanged("same-position");
  siblings.splice(fromIndex, 1);
  siblings.splice(target, 0, id);
  return { changed: true, value: { id, parentId: node.parentId, fromIndex, toIndex: target } };
}

export function reorderNodeByDelta(doc, { id, delta }) {
  const siblings = siblingList(doc, id);
  if (!siblings || !Number.isFinite(delta)) return unchanged("invalid-node");
  const fromIndex = siblings.indexOf(id);
  if (fromIndex < 0) return unchanged("invalid-node");
  return reorderNode(doc, { id, toIndex: fromIndex + Math.trunc(delta) });
}

export function indentUnderPreviousSibling(doc, { id }) {
  if (!canIndentNode(doc, id)) return unchanged("cannot-indent");
  const node = getNode(doc, id);
  const siblings = siblingList(doc, id);
  const fromIndex = siblings.indexOf(id);
  const fromParentId = node.parentId;
  const parentId = siblings[fromIndex - 1];
  const parent = getNode(doc, parentId);
  siblings.splice(fromIndex, 1);
  node.parentId = parentId;
  parent.childIds.push(id);
  parent.collapsed = false;
  return {
    changed: true,
    value: { id, fromParentId, fromIndex, toParentId: parentId, toIndex: parent.childIds.length - 1 },
  };
}

export function outdentPreservingOutline(doc, { id }) {
  if (!canOutdentNode(doc, id)) return unchanged("cannot-outdent");
  const node = getNode(doc, id);
  const parent = getNode(doc, node.parentId);
  const oldParentId = parent.id;
  const fromIndex = parent.childIds.indexOf(id);
  parent.childIds.splice(fromIndex, 1);

  const following = parent.childIds.splice(fromIndex);
  node.childIds.push(...following);
  for (const followingId of following) getNode(doc, followingId).parentId = id;

  const grandParentId = parent.parentId;
  const destination = grandParentId ? getNode(doc, grandParentId).childIds : doc.rootIds;
  const parentIndex = destination.indexOf(parent.id);
  const toIndex = parentIndex + 1;
  destination.splice(toIndex, 0, id);
  node.parentId = grandParentId;
  return {
    changed: true,
    value: {
      id,
      fromParentId: oldParentId,
      fromIndex,
      toParentId: grandParentId,
      toIndex,
      adoptedIds: following,
    },
  };
}
