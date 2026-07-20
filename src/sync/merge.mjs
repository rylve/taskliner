import { cloneStamp, compareStamps } from "./stamps.mjs";

const NODE_FIELDS = ["title", "note", "parentId", "orderKey", "dueDate", "completedAt", "deletedAt"];
const CONFLICT_FIELDS = new Set(["title", "note"]);

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through for the small scalar values used by the sync schema.
    }
  }
  return value;
}

function defaultStamp(deviceId) {
  return { counter: 0, deviceId: typeof deviceId === "string" ? deviceId : "" };
}

function nodeEntries(state) {
  if (Array.isArray(state?.nodes)) return state.nodes;
  if (isRecord(state?.nodes)) return Object.values(state.nodes);
  return [];
}

function asCandidate(rawValue, deviceId) {
  if (isRecord(rawValue) && isRecord(rawValue.stamp) && "value" in rawValue) {
    return { value: cloneValue(rawValue.value), stamp: cloneStamp(rawValue.stamp) };
  }
  return { value: cloneValue(rawValue), stamp: defaultStamp(deviceId) };
}

function compareCandidates(left, right) {
  const stampOrder = compareStamps(left.stamp, right.stamp);
  if (stampOrder !== 0) return stampOrder;
  const leftValue = stableValue(left.value);
  const rightValue = stableValue(right.value);
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function mergeField(candidates) {
  const usable = candidates.filter((candidate) => candidate && candidate.stamp);
  if (!usable.length) return null;
  return usable.reduce((winner, candidate) => (compareCandidates(candidate, winner) > 0 ? candidate : winner));
}

function addConflict(conflicts, seen, nodeId, field, candidate) {
  const key = `${nodeId}\u0000${field}\u0000${stableValue(candidate.value)}\u0000${candidate.stamp.counter}\u0000${candidate.stamp.deviceId}`;
  if (seen.has(key)) return;
  seen.add(key);
  conflicts.push({
    id: `${nodeId}:${field}:${candidate.stamp.counter}:${candidate.stamp.deviceId}`,
    nodeId,
    field,
    value: cloneValue(candidate.value),
    stamp: cloneStamp(candidate.stamp),
  });
}

function recoverInvalidParents(nodes) {
  const recovery = [];
  const invalid = new Set();
  const ids = Object.keys(nodes).sort();

  for (const startId of ids) {
    const path = [];
    const positions = new Map();
    let currentId = startId;

    while (currentId) {
      if (!nodes[currentId]) {
        const childId = path[path.length - 1];
        if (childId) {
          invalid.add(childId);
          recovery.push({ nodeId: childId, reason: "missing-parent", parentId: currentId });
        }
        break;
      }
      if (positions.has(currentId)) {
        const cycle = path.slice(positions.get(currentId));
        for (const nodeId of cycle) {
          invalid.add(nodeId);
          recovery.push({ nodeId, reason: "parent-cycle", parentId: nodes[nodeId].parentId.value });
        }
        break;
      }
      positions.set(currentId, path.length);
      path.push(currentId);
      currentId = nodes[currentId].parentId?.value || null;
    }
  }

  for (const nodeId of invalid) {
    const node = nodes[nodeId];
    node.parentId = {
      value: null,
      stamp: cloneStamp(node.parentId.stamp),
    };
  }

  const uniqueRecovery = [...new Map(recovery.map((entry) => [`${entry.nodeId}:${entry.reason}`, entry])).values()];
  uniqueRecovery.sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.reason.localeCompare(right.reason));
  return uniqueRecovery;
}

function mergeSettings(states) {
  const fieldNames = new Set();
  for (const state of states) {
    if (isRecord(state.workspaceSettings)) {
      for (const fieldName of Object.keys(state.workspaceSettings)) fieldNames.add(fieldName);
    }
  }

  const result = {};
  for (const fieldName of [...fieldNames].sort()) {
    const candidates = states
      .filter((state) => isRecord(state.workspaceSettings) && fieldName in state.workspaceSettings)
      .map((state) => asCandidate(state.workspaceSettings[fieldName], state.deviceId));
    const winner = mergeField(candidates);
    if (winner) result[fieldName] = winner;
  }
  return result;
}

/**
 * Merge encrypted-device payloads after they have been decrypted and validated.
 * Every sync field stays wrapped with its value stamp so a later push can retain
 * the same deterministic ordering information.
 */
export function mergeDeviceStates(states) {
  const usableStates = (Array.isArray(states) ? states : []).filter(isRecord);
  const lamportCounter = usableStates.reduce(
    (maximum, state) => Math.max(maximum, Number.isInteger(state.lamportCounter) ? state.lamportCounter : 0),
    0,
  );
  if (!usableStates.length) {
    return {
      format: "taskliner-device-state",
      version: 1,
      workspaceId: null,
      deviceId: "merged",
      lamportCounter: 0,
      sourceDeviceIds: [],
      nodes: {},
      tombstones: {},
      conflicts: [],
      recovery: [],
      workspaceSettings: {},
    };
  }

  const workspaceIds = [...new Set(usableStates.map((state) => state.workspaceId).filter(Boolean))];
  if (workspaceIds.length > 1) throw new Error("Cannot merge states from different workspaces");

  const byNode = new Map();
  for (const state of usableStates) {
    for (const rawNode of nodeEntries(state)) {
      if (!isRecord(rawNode) || typeof rawNode.id !== "string" || !rawNode.id) continue;
      if (!byNode.has(rawNode.id)) byNode.set(rawNode.id, []);
      byNode.get(rawNode.id).push({ node: rawNode, deviceId: state.deviceId });
    }
  }

  const nodes = {};
  const conflicts = [];
  const conflictKeys = new Set();

  for (const nodeId of [...byNode.keys()].sort()) {
    const candidates = byNode.get(nodeId);
    const node = { id: nodeId };
    for (const field of NODE_FIELDS) {
      const fieldCandidates = candidates
        .filter(({ node: candidateNode }) => field in candidateNode)
        .map(({ node: candidateNode, deviceId }) => asCandidate(candidateNode[field], deviceId));
      const winner = mergeField(fieldCandidates);
      if (!winner) continue;
      node[field] = {
        value: cloneValue(winner.value),
        stamp: cloneStamp(winner.stamp),
      };
      if (CONFLICT_FIELDS.has(field)) {
        for (const candidate of fieldCandidates) {
          if (stableValue(candidate.value) !== stableValue(winner.value)) addConflict(conflicts, conflictKeys, nodeId, field, candidate);
        }
      }
    }
    const createdAt = candidates
      .map(({ node: candidateNode }) => candidateNode.createdAt)
      .filter((value) => value != null)
      .sort()[0];
    if (createdAt != null) node.createdAt = createdAt;
    nodes[nodeId] = node;
  }

  for (const state of usableStates) {
    for (const conflict of Array.isArray(state.conflicts) ? state.conflicts : []) {
      if (!isRecord(conflict) || typeof conflict.nodeId !== "string" || !CONFLICT_FIELDS.has(conflict.field)) continue;
      if (!isRecord(conflict.stamp)) continue;
      addConflict(conflicts, conflictKeys, conflict.nodeId, conflict.field, {
        value: conflict.value,
        stamp: conflict.stamp,
      });
    }
  }

  const recovery = recoverInvalidParents(nodes);
  conflicts.sort((left, right) => left.id.localeCompare(right.id));
  const tombstones = {};
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.deletedAt?.value != null) tombstones[nodeId] = node.deletedAt;
  }

  return {
    format: "taskliner-device-state",
    version: 1,
    workspaceId: workspaceIds[0] || null,
    deviceId: [...new Set(usableStates.map((state) => state.deviceId).filter(Boolean))].sort().join("+") || "merged",
    lamportCounter,
    sourceDeviceIds: [...new Set(usableStates.map((state) => state.deviceId).filter(Boolean))].sort(),
    nodes,
    tombstones,
    conflicts,
    recovery,
    workspaceSettings: mergeSettings(usableStates),
  };
}
