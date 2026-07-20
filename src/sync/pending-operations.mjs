const PENDING_OPERATIONS_FORMAT = "taskliner-pending-operations";
const PENDING_OPERATIONS_VERSION = 1;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Pending operation values must be JSON serializable");
  return JSON.parse(serialized);
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = finiteNumber(value, fallback);
  return Math.max(0, Math.floor(number));
}

function resolveNow(now) {
  if (typeof now === "function") return finiteNumber(now(), Date.now());
  if (now !== undefined) return finiteNumber(now, Date.now());
  return Date.now();
}

function defaultOperationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function operationIdOf(value) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  if (typeof value.operationId === "string") return value.operationId;
  if (typeof value.id === "string") return value.id;
  return null;
}

function operationKey(operation) {
  return `${operation.nodeId}\u0000${operation.field}`;
}

function operationFingerprint(operation) {
  return JSON.stringify({
    nodeId: operation.nodeId,
    field: operation.field,
    value: operation.value,
    ...(hasOwn(operation, "stamp") ? { stamp: operation.stamp } : {}),
  });
}

function normalizeOperation(raw, { now, operationIdFactory = defaultOperationId } = {}) {
  if (!isRecord(raw)) throw new TypeError("A pending operation must be an object");

  const operationId = operationIdOf(raw) || operationIdFactory();
  if (typeof operationId !== "string" || !operationId) throw new TypeError("Pending operation requires an operationId");
  if (typeof raw.nodeId !== "string" || !raw.nodeId) throw new TypeError("Pending operation requires a nodeId");
  if (typeof raw.field !== "string" || !raw.field) throw new TypeError("Pending operation requires a field");
  if (!hasOwn(raw, "value")) throw new TypeError("Pending operation requires a value");

  const createdAt = finiteNumber(raw.createdAt, resolveNow(now));
  const operation = {
    operationId,
    nodeId: raw.nodeId,
    field: raw.field,
    value: cloneJson(raw.value),
    createdAt,
    attempts: nonNegativeInteger(raw.attempts ?? raw.attemptCount),
    nextAttemptAt: finiteNumber(raw.nextAttemptAt, createdAt),
  };

  if (hasOwn(raw, "stamp")) operation.stamp = cloneJson(raw.stamp);
  if (hasOwn(raw, "groupId")) operation.groupId = cloneJson(raw.groupId);
  if (hasOwn(raw, "type")) operation.type = cloneJson(raw.type);
  if (hasOwn(raw, "lastAttemptAt") && raw.lastAttemptAt != null) {
    operation.lastAttemptAt = finiteNumber(raw.lastAttemptAt, createdAt);
  }
  return operation;
}

function cloneOperation(operation) {
  return cloneJson(operation);
}

function resolveAlias(aliases, operationId) {
  let current = operationId;
  const visited = new Set();
  while (typeof aliases[current] === "string" && !visited.has(current)) {
    visited.add(current);
    current = aliases[current];
  }
  return current;
}

function optionsOnly(value) {
  if (!isRecord(value)) return false;
  if (hasOwn(value, "operations") || hasOwn(value, "format") || hasOwn(value, "version")) return false;
  return ["now", "operationIdFactory", "autoCoalesce", "retryDelayMs"].some((key) => hasOwn(value, key));
}

function normalizeState(input, options) {
  let source = input;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      throw new TypeError("Pending operation state must be valid JSON");
    }
  }

  const rawOperations = Array.isArray(source) ? source : source?.operations;
  const operations = [];
  const operationIds = new Set();
  for (const rawOperation of Array.isArray(rawOperations) ? rawOperations : []) {
    const operation = normalizeOperation(rawOperation, options);
    if (operationIds.has(operation.operationId)) continue;
    operationIds.add(operation.operationId);
    operations.push(operation);
  }

  const acknowledgedOperationIds = [];
  const acknowledgedSet = new Set();
  for (const operationId of Array.isArray(source?.acknowledgedOperationIds) ? source.acknowledgedOperationIds : []) {
    if (typeof operationId !== "string" || !operationId || acknowledgedSet.has(operationId)) continue;
    acknowledgedSet.add(operationId);
    acknowledgedOperationIds.push(operationId);
  }

  const coalescedOperationIds = {};
  const aliases = source?.coalescedOperationIds || source?.aliases;
  if (isRecord(aliases)) {
    for (const [operationId, canonicalId] of Object.entries(aliases)) {
      if (operationId && typeof canonicalId === "string" && canonicalId && operationId !== canonicalId) {
        coalescedOperationIds[operationId] = canonicalId;
      }
    }
  }

  return {
    format: PENDING_OPERATIONS_FORMAT,
    version: PENDING_OPERATIONS_VERSION,
    operations: operations.filter((operation) => !acknowledgedSet.has(operation.operationId)),
    acknowledgedOperationIds,
    coalescedOperationIds,
  };
}

/**
 * In-memory pending-operation queue. Its JSON representation contains no Map,
 * Set, function, or class instance, so it can be stored as an IndexedDB value later.
 */
export class PendingOperations {
  constructor(initialState, options = {}) {
    let source = initialState;
    let resolvedOptions = options;
    if (optionsOnly(source) && Object.keys(options).length === 0) {
      resolvedOptions = source;
      source = undefined;
    }

    this._now = resolvedOptions.now ?? Date.now;
    this._operationIdFactory = resolvedOptions.operationIdFactory || defaultOperationId;
    this._autoCoalesce = resolvedOptions.autoCoalesce !== false;
    this._retryDelayMs = Math.max(0, finiteNumber(resolvedOptions.retryDelayMs, 0));
    this._state = normalizeState(source, {
      now: this._now,
      operationIdFactory: this._operationIdFactory,
    });
  }

  get size() {
    return this._state.operations.length;
  }

  get isEmpty() {
    return this.size === 0;
  }

  operations() {
    return this._state.operations.map(cloneOperation);
  }

  add(rawOperation) {
    const operation = normalizeOperation(rawOperation, {
      now: this._now,
      operationIdFactory: this._operationIdFactory,
    });
    const operationId = operation.operationId;
    const canonicalId = resolveAlias(this._state.coalescedOperationIds, operationId);
    if (canonicalId !== operationId) {
      const existing = this._state.operations.find((candidate) => candidate.operationId === canonicalId);
      if (existing) return cloneOperation(existing);
      return cloneOperation(operation);
    }

    if (this._state.acknowledgedOperationIds.includes(operationId)) return cloneOperation(operation);
    const existing = this._state.operations.find((candidate) => candidate.operationId === operationId);
    if (existing) {
      if (operationFingerprint(existing) !== operationFingerprint(operation)) {
        throw new Error(`Operation ID collision: ${operationId}`);
      }
      return cloneOperation(existing);
    }

    this._state.operations.push(operation);
    if (this._autoCoalesce) this.coalesce();
    return cloneOperation(
      this._state.operations.find((candidate) => candidate.operationId === operationId) ||
        this._state.operations[this._state.operations.length - 1]
    );
  }

  ack(operationOrId) {
    const operationId = operationIdOf(operationOrId);
    if (!operationId) return false;
    const canonicalId = resolveAlias(this._state.coalescedOperationIds, operationId);
    const operation = this._state.operations.find((candidate) => candidate.operationId === canonicalId);
    if (!operation && !this._state.acknowledgedOperationIds.includes(canonicalId)) return false;

    const acknowledged = new Set(this._state.acknowledgedOperationIds);
    acknowledged.add(canonicalId);
    for (const alias of Object.keys(this._state.coalescedOperationIds)) {
      if (resolveAlias(this._state.coalescedOperationIds, alias) === canonicalId) acknowledged.add(alias);
    }
    this._state.acknowledgedOperationIds = [...acknowledged];
    this._state.operations = this._state.operations.filter((candidate) => candidate.operationId !== canonicalId);
    for (const alias of Object.keys(this._state.coalescedOperationIds)) {
      if (resolveAlias(this._state.coalescedOperationIds, alias) === canonicalId) {
        delete this._state.coalescedOperationIds[alias];
      }
    }
    return true;
  }

  getRetryCandidates({ now, limit } = {}) {
    const currentTime = resolveNow(now ?? this._now);
    const candidates = this._state.operations
      .filter((operation) => operation.nextAttemptAt <= currentTime)
      .map(cloneOperation);
    if (limit == null) return candidates;
    return candidates.slice(0, Math.max(0, nonNegativeInteger(limit)));
  }

  markAttempt(operationOrId, { now, retryDelayMs, nextAttemptAt } = {}) {
    const operationId = operationIdOf(operationOrId);
    if (!operationId) return null;
    const canonicalId = resolveAlias(this._state.coalescedOperationIds, operationId);
    const index = this._state.operations.findIndex((operation) => operation.operationId === canonicalId);
    if (index < 0) return null;

    const currentTime = resolveNow(now ?? this._now);
    const delay = Math.max(0, finiteNumber(retryDelayMs, this._retryDelayMs));
    const operation = this._state.operations[index];
    this._state.operations[index] = {
      ...operation,
      attempts: operation.attempts + 1,
      lastAttemptAt: currentTime,
      nextAttemptAt: nextAttemptAt == null ? currentTime + delay : finiteNumber(nextAttemptAt, currentTime + delay),
    };
    return cloneOperation(this._state.operations[index]);
  }

  isIdempotent(operationOrId) {
    const operationId = operationIdOf(operationOrId);
    if (!operationId) return false;
    if (this._state.acknowledgedOperationIds.includes(operationId)) return true;
    const canonicalId = resolveAlias(this._state.coalescedOperationIds, operationId);
    return this._state.operations.some((operation) => operation.operationId === canonicalId);
  }

  /**
   * Collapse adjacent, not-yet-attempted edits to the same node field.
   * The first operation ID remains canonical; later IDs are retained as aliases
   * so a replay of a coalesced operation is still recognized as a duplicate.
   */
  coalesce() {
    const coalesced = [];
    for (const operation of this._state.operations) {
      const previous = coalesced[coalesced.length - 1];
      if (
        previous &&
        operationKey(previous) === operationKey(operation) &&
        previous.attempts === 0 &&
        operation.attempts === 0
      ) {
        this._state.coalescedOperationIds[operation.operationId] = previous.operationId;
        const merged = {
          ...previous,
          value: cloneJson(operation.value),
          nextAttemptAt: Math.min(previous.nextAttemptAt, operation.nextAttemptAt),
        };
        if (hasOwn(operation, "stamp")) merged.stamp = cloneJson(operation.stamp);
        else delete merged.stamp;
        if (hasOwn(operation, "groupId")) merged.groupId = cloneJson(operation.groupId);
        else delete merged.groupId;
        if (hasOwn(operation, "type")) merged.type = cloneJson(operation.type);
        else delete merged.type;
        coalesced[coalesced.length - 1] = merged;
      } else {
        coalesced.push(operation);
      }
    }
    this._state.operations = coalesced;
    return this.operations();
  }

  toJSON() {
    const result = {
      format: this._state.format,
      version: this._state.version,
      operations: this.operations(),
      acknowledgedOperationIds: [...this._state.acknowledgedOperationIds],
    };
    if (Object.keys(this._state.coalescedOperationIds).length) {
      result.coalescedOperationIds = { ...this._state.coalescedOperationIds };
    }
    return result;
  }

  serialize(space) {
    return JSON.stringify(this.toJSON(), null, space);
  }
}

export function createPendingOperations(initialState, options) {
  return new PendingOperations(initialState, options);
}

export function createPendingOperation(operation, options) {
  return normalizeOperation(operation, options);
}

export function addPendingOperation(state, operation, options = {}) {
  const queue = new PendingOperations(state, options);
  queue.add(operation);
  return queue.toJSON();
}

export function ackPendingOperation(state, operationOrId, options = {}) {
  const queue = new PendingOperations(state, options);
  queue.ack(operationOrId);
  return queue.toJSON();
}

export function getRetryCandidates(state, options = {}) {
  const queue = new PendingOperations(state, options);
  return queue.getRetryCandidates(options);
}

export function isOperationIdempotent(state, operationOrId, options = {}) {
  return new PendingOperations(state, options).isIdempotent(operationOrId);
}

export function coalescePendingOperations(state, options = {}) {
  const queue = new PendingOperations(state, { ...options, autoCoalesce: false });
  queue.coalesce();
  return queue.toJSON();
}

export { PENDING_OPERATIONS_FORMAT, PENDING_OPERATIONS_VERSION };
