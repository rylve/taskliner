import { validateTree } from "../model/validate-tree.mjs";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fieldValue(node, field, fallback = null) {
  const value = node?.[field];
  return isRecord(value) && "value" in value ? value.value : (value ?? fallback);
}

function compareOrder(left, right) {
  return String(fieldValue(left, "orderKey", ""))
    .localeCompare(String(fieldValue(right, "orderKey", ""))) || left.id.localeCompare(right.id);
}

/**
 * Convert the deterministic merged state into the legacy local projection.
 * This is kept separate from merge so the UI can adopt it transactionally.
 */
export function projectMergedState(state, { baseDoc = {}, schemaVersion = 3 } = {}) {
  if (!isRecord(state) || !isRecord(state.nodes)) throw new TypeError("A merged device state is required");
  const sourceNodes = Object.values(state.nodes).filter((node) => isRecord(node) && typeof node.id === "string");
  const active = new Map(sourceNodes
    .filter((node) => fieldValue(node, "deletedAt") == null)
    .map((node) => [node.id, node]));
  const nodes = {};

  for (const source of active.values()) {
    const parentId = fieldValue(source, "parentId");
    nodes[source.id] = {
      id: source.id,
      title: String(fieldValue(source, "title", "")),
      parentId: parentId && active.has(parentId) ? parentId : null,
      childIds: [],
      collapsed: !!baseDoc.nodes?.[source.id]?.collapsed,
      createdAt: Number.isFinite(source.createdAt) ? source.createdAt : Date.now(),
      completedAt: fieldValue(source, "completedAt"),
      dueAt: fieldValue(source, "dueDate"),
      note: String(fieldValue(source, "note", "")),
      completedChildCount: 0,
    };
  }

  const children = new Map();
  for (const source of active.values()) {
    const parentId = nodes[source.id].parentId;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(source);
  }
  for (const [parentId, sources] of children) {
    sources.sort(compareOrder);
    const childIds = sources.map((source) => source.id);
    if (parentId === null) continue;
    if (nodes[parentId]) nodes[parentId].childIds = childIds;
  }

  const rootIds = (children.get(null) || []).sort(compareOrder).map((source) => source.id);
  for (const node of Object.values(nodes)) {
    node.completedChildCount = node.childIds.reduce(
      (count, childId) => count + (nodes[childId]?.completedAt != null ? 1 : 0),
      0,
    );
  }

  const rawUi = isRecord(baseDoc.ui) ? baseDoc.ui : {};
  const ui = { ...rawUi };

  const selectedId = typeof baseDoc.selectedId === "string" && nodes[baseDoc.selectedId]
    ? baseDoc.selectedId
    : null;
  const projected = {
    ...baseDoc,
    schemaVersion,
    nodes,
    rootIds,
    selectedId,
    ui,
  };
  const validation = validateTree(projected);
  if (!validation.ok) throw new Error(`Merged state cannot be projected: ${validation.errors.join("; ")}`);
  return projected;
}
