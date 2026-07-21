import { createActiveTreeProjection, validateTree } from "../model/validate-tree.mjs";

const DEVICE_STATE_FORMAT = "taskliner-device-state";
const DEVICE_STATE_VERSION = 1;
const SYNC_FIELDS = ["title", "note", "parentId", "orderKey", "dueDate", "completedAt", "deletedAt"];
const DEFAULT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxNodes: 10_000,
  maxDepth: 100,
  maxTextLength: 20_000,
};

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeCounter(value) {
  const counter = Number(value);
  return Number.isInteger(counter) && counter >= 0 ? counter : 0;
}

function makeStamp(counter, deviceId) {
  return { counter: normalizeCounter(counter), deviceId };
}

function stamped(value, stamp) {
  return { value, stamp: { ...stamp } };
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON for the scalar sync fields.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stampField(value, previousField, stamp) {
  if (
    isRecord(previousField)
    && "value" in previousField
    && isRecord(previousField.stamp)
    && Number.isInteger(previousField.stamp.counter)
    && previousField.stamp.counter >= 0
    && typeof previousField.stamp.deviceId === "string"
    && previousField.stamp.deviceId
    && stableValue(previousField.value) === stableValue(value)
  ) {
    return {
      value: cloneValue(previousField.value),
      stamp: { ...previousField.stamp },
    };
  }
  return stamped(value, stamp);
}

function siblingOrder(doc) {
  const order = new Map();
  const visit = (ids) => {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      order.set(id, `${String(index).padStart(12, "0")}:${id}`);
      const childIds = doc.nodes[id]?.childIds;
      if (Array.isArray(childIds)) visit(childIds);
    }
  };
  visit(doc.rootIds);
  return order;
}

/** Build the first sync snapshot from the current local document. */
export function createDeviceState({
  doc,
  workspaceId,
  deviceId,
  lamportCounter = 0,
  generatedAt = new Date().toISOString(),
  previousState = null,
} = {}) {
  if (!isRecord(doc) || !isRecord(doc.nodes)) throw new Error("A valid local document is required");
  if (typeof workspaceId !== "string" || !workspaceId) throw new Error("workspaceId is required");
  if (typeof deviceId !== "string" || !deviceId) throw new Error("deviceId is required");
  const syncDoc = createActiveTreeProjection(doc);
  const tree = validateTree(syncDoc);
  if (!tree.ok) throw new Error(`Cannot create device state from invalid tree: ${tree.errors.join("; ")}`);

  const stamp = makeStamp(lamportCounter, deviceId);
  const order = siblingOrder(syncDoc);
  const nodes = {};
  for (const id of Object.keys(syncDoc.nodes).sort()) {
    const node = syncDoc.nodes[id];
    const previousNode = isRecord(previousState?.nodes) && isRecord(previousState.nodes[id])
      ? previousState.nodes[id]
      : null;
    nodes[id] = {
      id,
      title: stampField(node.title || "", previousNode?.title, stamp),
      note: stampField(node.note || "", previousNode?.note, stamp),
      parentId: stampField(node.parentId ?? null, previousNode?.parentId, stamp),
      orderKey: stampField(order.get(id) || `999999999999:${id}`, previousNode?.orderKey, stamp),
      dueDate: stampField(node.dueAt ?? null, previousNode?.dueDate, stamp),
      completedAt: stampField(node.completedAt ?? null, previousNode?.completedAt, stamp),
      deletedAt: stampField(null, previousNode?.deletedAt, stamp),
      createdAt: node.createdAt,
    };
  }

  return {
    format: DEVICE_STATE_FORMAT,
    version: DEVICE_STATE_VERSION,
    workspaceId,
    deviceId,
    generatedAt,
    lamportCounter: normalizeCounter(lamportCounter),
    nodes,
    tombstones: {},
    conflicts: [],
    workspaceSettings: {},
  };
}

function validateStamp(stamp, path, errors) {
  if (!isRecord(stamp)) {
    errors.push(`${path}.stamp must be an object`);
    return;
  }
  if (!Number.isInteger(stamp.counter) || stamp.counter < 0) errors.push(`${path}.stamp.counter must be a non-negative integer`);
  if (typeof stamp.deviceId !== "string" || !stamp.deviceId) errors.push(`${path}.stamp.deviceId must be a non-empty string`);
}

/** Validate decrypted device data before it can enter the merge pipeline. */
export function validateDeviceState(state, limits = {}) {
  const config = { ...DEFAULT_LIMITS, ...limits };
  const errors = [];
  if (!isRecord(state)) return { ok: false, errors: ["device state must be an object"] };
  if (state.format !== DEVICE_STATE_FORMAT) errors.push("unsupported device state format");
  if (state.version !== DEVICE_STATE_VERSION) errors.push("unsupported device state version");
  if (typeof state.workspaceId !== "string" || !state.workspaceId) errors.push("workspaceId must be a non-empty string");
  if (typeof state.deviceId !== "string" || !state.deviceId) errors.push("deviceId must be a non-empty string");
  if (!Number.isInteger(state.lamportCounter) || state.lamportCounter < 0) errors.push("lamportCounter must be a non-negative integer");

  let serialized = "";
  try {
    serialized = JSON.stringify(state);
  } catch {
    errors.push("device state must be JSON-serializable");
  }
  if (serialized && new TextEncoder().encode(serialized).byteLength > config.maxBytes) errors.push("device state exceeds the size limit");

  if (!isRecord(state.nodes)) {
    errors.push("nodes must be an object");
  } else {
    const ids = Object.keys(state.nodes);
    if (ids.length > config.maxNodes) errors.push("device state exceeds the node limit");
    const parents = new Map();
    for (const id of ids) {
      const node = state.nodes[id];
      if (!isRecord(node)) {
        errors.push(`node must be an object: ${id}`);
        continue;
      }
      if (node.id !== id) errors.push(`node id mismatch: ${id}`);
      for (const field of SYNC_FIELDS) {
        if (!isRecord(node[field]) || !("value" in node[field])) {
          errors.push(`${id}.${field} must be a stamped value`);
          continue;
        }
        validateStamp(node[field].stamp, `${id}.${field}`, errors);
        if (["title", "note"].includes(field) && typeof node[field].value !== "string") errors.push(`${id}.${field} must be a string`);
        if (["title", "note"].includes(field) && typeof node[field].value === "string" && node[field].value.length > config.maxTextLength) {
          errors.push(`${id}.${field} exceeds the text limit`);
        }
        if (field === "parentId") {
          const parentId = node[field].value;
          if (parentId !== null && typeof parentId !== "string") errors.push(`${id}.parentId must be null or a string`);
          parents.set(id, parentId);
        }
      }
      if (typeof node.createdAt !== "number" || !Number.isFinite(node.createdAt)) errors.push(`${id}.createdAt must be finite`);
    }

    for (const [id, parentId] of parents) {
      if (parentId && !state.nodes[parentId]) errors.push(`${id}.parentId points to a missing node`);
      const seen = new Set([id]);
      let current = parentId;
      let depth = 0;
      while (current) {
        depth += 1;
        if (depth > config.maxDepth) {
          errors.push(`${id}.parentId exceeds the depth limit`);
          break;
        }
        if (seen.has(current)) {
          errors.push(`parent cycle detected at node: ${current}`);
          break;
        }
        seen.add(current);
        current = parents.get(current) || null;
      }
    }
  }

  if (!isRecord(state.tombstones)) errors.push("tombstones must be an object");
  if (!Array.isArray(state.conflicts)) errors.push("conflicts must be an array");
  return { ok: errors.length === 0, errors };
}

export { DEFAULT_LIMITS, DEVICE_STATE_FORMAT, DEVICE_STATE_VERSION, SYNC_FIELDS };

