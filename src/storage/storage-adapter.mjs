const DEFAULT_DB_NAME = "taskliner-local-first";
const CURRENT_RECORD_ID = "current";
const ARCHIVE_STORE_NAME = "archiveNodes";
const PENDING_OPERATIONS_STORE_NAME = "pendingOperations";
const SYNC_METADATA_STORE_NAME = "syncMetadata";
const SYNC_SECRET_STORE_NAME = "syncSecrets";
const INTEGRATION_SETTINGS_STORE_NAME = "integrationSettings";
const COMPLETION_OUTBOX_STORE_NAME = "completionOutbox";
const STORAGE_SCHEMA_VERSION = 5;
const SPLIT_FORMAT = "taskliner-split-v1";

function getLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function canUseIndexedDB() {
  return typeof globalThis.indexedDB !== "undefined";
}

function getSourceId() {
  try {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Storage values must be JSON serializable");
  return JSON.parse(serialized);
}

function archiveRecord(node) {
  return {
    ...node,
    searchText: `${node.title || ""}\n${node.note || ""}`.toLocaleLowerCase(),
  };
}

function nodeFromArchiveRecord(record) {
  if (!record || typeof record !== "object") return null;
  const { searchText: _searchText, ...node } = record;
  return node;
}

function archiveSummary(record) {
  const node = nodeFromArchiveRecord(record);
  if (!node) return null;
  return {
    ...node,
    note: "",
    childIds: Array.isArray(node.childIds) ? [...node.childIds] : [],
    archivePayloadLoaded: false,
  };
}

function isCompletedNode(node) {
  return !!(node && node.completedAt != null);
}

/**
 * Convert the legacy full document into the active projection and archive records.
 * Child/root ID arrays intentionally retain IDs whose payload moved to the archive;
 * this preserves sibling order when a node is restored later.
 */
function splitDocument(fullDoc) {
  const source = fullDoc && typeof fullDoc === "object" ? fullDoc : {};
  const sourceNodes = source.nodes && typeof source.nodes === "object" ? source.nodes : {};
  const archiveNodes = [];
  const activeNodes = {};

  for (const node of Object.values(sourceNodes)) {
    if (!node || typeof node !== "object" || typeof node.id !== "string") continue;
    if (isCompletedNode(node)) {
      archiveNodes.push(archiveRecord(node));
      continue;
    }
    const completedChildCount = Array.isArray(node.childIds)
      ? node.childIds.reduce((count, childId) => count + (isCompletedNode(sourceNodes[childId]) ? 1 : 0), 0)
      : 0;
    activeNodes[node.id] = {
      ...node,
      childIds: Array.isArray(node.childIds) ? [...node.childIds] : [],
      completedChildCount,
    };
  }

  const rootIds = Array.isArray(source.rootIds) ? [...source.rootIds] : Object.keys(activeNodes);
  const selectedId = typeof source.selectedId === "string" && activeNodes[source.selectedId] ? source.selectedId : null;
  return {
    doc: {
      ...source,
      storageFormat: SPLIT_FORMAT,
      nodes: activeNodes,
      rootIds,
      selectedId,
    },
    archiveNodes,
  };
}

function isSplitDocumentRecord(record) {
  return record?.format === SPLIT_FORMAT && record.doc && record.doc.nodes;
}

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(name, STORAGE_SCHEMA_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("documents")) {
        db.createObjectStore("documents", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("backups")) {
        db.createObjectStore("backups", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(ARCHIVE_STORE_NAME)) {
        const store = db.createObjectStore(ARCHIVE_STORE_NAME, { keyPath: "id" });
        store.createIndex("completedAt", "completedAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("title", "title", { unique: false });
        store.createIndex("parentId", "parentId", { unique: false });
      }
      if (!db.objectStoreNames.contains(PENDING_OPERATIONS_STORE_NAME)) {
        db.createObjectStore(PENDING_OPERATIONS_STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SYNC_METADATA_STORE_NAME)) {
        db.createObjectStore(SYNC_METADATA_STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SYNC_SECRET_STORE_NAME)) {
        db.createObjectStore(SYNC_SECRET_STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(INTEGRATION_SETTINGS_STORE_NAME)) {
        db.createObjectStore(INTEGRATION_SETTINGS_STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(COMPLETION_OUTBOX_STORE_NAME)) {
        db.createObjectStore(COMPLETION_OUTBOX_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function normalizeRange(from, to) {
  if (from == null && to == null) return null;
  return globalThis.IDBKeyRange.bound(from ?? -Infinity, to ?? Infinity);
}

function matchesArchiveRecord(record, query, from, to) {
  if (!record || !isCompletedNode(record)) return false;
  if (from != null && record.completedAt < from) return false;
  if (to != null && record.completedAt > to) return false;
  if (query && !(record.searchText || `${record.title || ""}\n${record.note || ""}`).includes(query)) return false;
  return true;
}

/**
 * IndexedDB-first persistence with an active projection and lazy archive records.
 * Legacy full documents are migrated on first hydration.
 */
export function createStorageAdapter({
  key,
  dbName = DEFAULT_DB_NAME,
  lockName = `${key}:write`,
}) {
  const listeners = new Set();
  const legacy = getLocalStorage();
  const sourceId = getSourceId();
  const channel = typeof globalThis.BroadcastChannel === "function"
    ? new globalThis.BroadcastChannel(`${key}:changes`)
    : null;
  let dbPromise = null;
  let hydrationPromise = null;
  let writeChain = Promise.resolve();
  let memoryArchive = new Map();
  let archiveStats = { count: 0 };
  let pendingOperationsState = null;
  let syncMetadataState = null;
  let syncSecretState = null;
  let integrationSettingsState = new Map();
  let completionOutboxState = new Map();

  const notify = (doc, archiveChanged = false) => {
    channel?.postMessage({ type: "document-updated", sourceId, doc, archiveChanged });
  };

  if (channel) {
    channel.onmessage = (event) => {
      const message = event.data;
      if (!message || message.type !== "document-updated" || message.sourceId === sourceId) return;
      for (const listener of listeners) listener(message.doc, { archiveChanged: !!message.archiveChanged });
    };
  }

  const getDb = () => {
    if (!canUseIndexedDB()) return Promise.resolve(null);
    if (!dbPromise) dbPromise = openDatabase(dbName).catch(() => null);
    return dbPromise;
  };

  const withWriteLock = async (callback) => {
    const locks = globalThis.navigator?.locks;
    if (locks?.request) return locks.request(lockName, { mode: "exclusive" }, callback);
    return callback();
  };

  const readCurrent = async () => {
    const db = await getDb();
    if (!db) return null;
    const transaction = db.transaction("documents", "readonly");
    const record = await requestValue(transaction.objectStore("documents").get(CURRENT_RECORD_ID));
    await transactionDone(transaction);
    return record || null;
  };

  const readSyncRecord = async (storeName) => {
    const db = await getDb();
    if (!db) return null;
    const transaction = db.transaction(storeName, "readonly");
    const record = await requestValue(transaction.objectStore(storeName).get(CURRENT_RECORD_ID));
    await transactionDone(transaction);
    return record || null;
  };

  const readPendingOperations = async () => {
    const record = await readSyncRecord(PENDING_OPERATIONS_STORE_NAME);
    if (record && Object.prototype.hasOwnProperty.call(record, "state")) {
      pendingOperationsState = cloneJson(record.state);
    }
    return cloneJson(pendingOperationsState);
  };

  const readSyncMetadata = async () => {
    const record = await readSyncRecord(SYNC_METADATA_STORE_NAME);
    if (record && Object.prototype.hasOwnProperty.call(record, "metadata")) {
      syncMetadataState = cloneJson(record.metadata);
    }
    return cloneJson(syncMetadataState);
  };

  const readSyncSecret = async () => {
    const db = await getDb();
    if (!db) return syncSecretState;
    const transaction = db.transaction(SYNC_SECRET_STORE_NAME, "readonly");
    const record = await requestValue(transaction.objectStore(SYNC_SECRET_STORE_NAME).get(CURRENT_RECORD_ID));
    await transactionDone(transaction);
    if (!record) return syncSecretState;
    const { id: _id, updatedAt: _updatedAt, ...secret } = record;
    syncSecretState = secret;
    return syncSecretState;
  };

  const writeSyncSecret = async (secret) => {
    if (!secret || typeof secret !== "object") throw new TypeError("Sync secret must be an object");
    syncSecretState = { ...secret };
    const db = await getDb();
    if (!db) return syncSecretState;
    await withWriteLock(async () => {
      const transaction = db.transaction(SYNC_SECRET_STORE_NAME, "readwrite");
      transaction.objectStore(SYNC_SECRET_STORE_NAME).put({
        id: CURRENT_RECORD_ID,
        ...syncSecretState,
        updatedAt: Date.now(),
      });
      await transactionDone(transaction);
    });
    return syncSecretState;
  };

  const clearSyncSecret = async () => {
    syncSecretState = null;
    const db = await getDb();
    if (!db) return;
    await withWriteLock(async () => {
      const transaction = db.transaction(SYNC_SECRET_STORE_NAME, "readwrite");
      transaction.objectStore(SYNC_SECRET_STORE_NAME).delete(CURRENT_RECORD_ID);
      await transactionDone(transaction);
    });
  };

  const writeSyncRecord = async (storeName, valueKey, value) => {
    const cloned = cloneJson(value);
    if (storeName === PENDING_OPERATIONS_STORE_NAME) pendingOperationsState = cloned;
    if (storeName === SYNC_METADATA_STORE_NAME) syncMetadataState = cloned;
    const db = await getDb();
    if (!db) return cloneJson(cloned);
    await withWriteLock(async () => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put({
        id: CURRENT_RECORD_ID,
        [valueKey]: cloned,
        updatedAt: Date.now(),
      });
      await transactionDone(transaction);
    });
    return cloneJson(cloned);
  };

  const writePendingOperations = (state) => writeSyncRecord(
    PENDING_OPERATIONS_STORE_NAME,
    "state",
    state,
  );

  const writeSyncMetadata = (metadata) => writeSyncRecord(
    SYNC_METADATA_STORE_NAME,
    "metadata",
    metadata,
  );

  const readIntegrationSettings = async (provider = "discord") => {
    const db = await getDb();
    if (!db) return cloneJson(integrationSettingsState.get(provider) || null);
    const transaction = db.transaction(INTEGRATION_SETTINGS_STORE_NAME, "readonly");
    const record = await requestValue(transaction.objectStore(INTEGRATION_SETTINGS_STORE_NAME).get(provider));
    await transactionDone(transaction);
    if (!record || !Object.prototype.hasOwnProperty.call(record, "settings")) return null;
    integrationSettingsState.set(provider, cloneJson(record.settings));
    return cloneJson(record.settings);
  };

  const writeIntegrationSettings = async (provider, settings) => {
    const cloned = cloneJson(settings);
    integrationSettingsState.set(provider, cloned);
    const db = await getDb();
    if (!db) return cloneJson(cloned);
    await withWriteLock(async () => {
      const transaction = db.transaction(INTEGRATION_SETTINGS_STORE_NAME, "readwrite");
      transaction.objectStore(INTEGRATION_SETTINGS_STORE_NAME).put({
        id: provider,
        settings: cloned,
        updatedAt: Date.now(),
      });
      await transactionDone(transaction);
    });
    return cloneJson(cloned);
  };

  const clearIntegrationSettings = async (provider = "discord") => {
    integrationSettingsState.delete(provider);
    const db = await getDb();
    if (!db) return;
    await withWriteLock(async () => {
      const transaction = db.transaction(INTEGRATION_SETTINGS_STORE_NAME, "readwrite");
      transaction.objectStore(INTEGRATION_SETTINGS_STORE_NAME).delete(provider);
      await transactionDone(transaction);
    });
  };

  const readCompletionOutbox = async () => {
    const db = await getDb();
    if (!db) return cloneJson([...completionOutboxState.values()]);
    const transaction = db.transaction(COMPLETION_OUTBOX_STORE_NAME, "readonly");
    const records = await requestValue(transaction.objectStore(COMPLETION_OUTBOX_STORE_NAME).getAll());
    await transactionDone(transaction);
    completionOutboxState = new Map((records || []).map((record) => [record.id, record]));
    return cloneJson(records || []);
  };

  const putCompletionEvent = async (event) => {
    const cloned = cloneJson(event);
    completionOutboxState.set(cloned.id, cloned);
    const db = await getDb();
    if (!db) return cloneJson(cloned);
    await withWriteLock(async () => {
      const transaction = db.transaction(COMPLETION_OUTBOX_STORE_NAME, "readwrite");
      transaction.objectStore(COMPLETION_OUTBOX_STORE_NAME).put(cloned);
      await transactionDone(transaction);
    });
    return cloneJson(cloned);
  };

  const claimCompletionEvent = async (id, owner, now, leaseMs) => {
    const db = await getDb();
    if (!db) {
      const event = completionOutboxState.get(id);
      if (!event || event.status !== "pending" || (event.claimUntil > now && event.claimedBy !== owner)) return false;
      completionOutboxState.set(id, { ...event, claimedBy: owner, claimUntil: now + leaseMs });
      return true;
    }
    return withWriteLock(async () => {
      const transaction = db.transaction(COMPLETION_OUTBOX_STORE_NAME, "readwrite");
      const store = transaction.objectStore(COMPLETION_OUTBOX_STORE_NAME);
      const event = await requestValue(store.get(id));
      const available = event && event.status === "pending" && (!(event.claimUntil > now) || event.claimedBy === owner);
      if (available) store.put({ ...event, claimedBy: owner, claimUntil: now + leaseMs });
      await transactionDone(transaction);
      if (available) completionOutboxState.set(id, { ...event, claimedBy: owner, claimUntil: now + leaseMs });
      return !!available;
    });
  };

  const updateCompletionEvent = async (id, nextEvent, owner = null) => {
    const cloned = cloneJson(nextEvent);
    const db = await getDb();
    if (!db) {
      const current = completionOutboxState.get(id);
      if (!current || (owner && current.claimedBy !== owner)) return null;
      completionOutboxState.set(id, cloned);
      return cloneJson(cloned);
    }
    return withWriteLock(async () => {
      const transaction = db.transaction(COMPLETION_OUTBOX_STORE_NAME, "readwrite");
      const store = transaction.objectStore(COMPLETION_OUTBOX_STORE_NAME);
      const current = await requestValue(store.get(id));
      if (!current || (owner && current.claimedBy !== owner)) {
        await transactionDone(transaction);
        return null;
      }
      store.put(cloned);
      await transactionDone(transaction);
      completionOutboxState.set(id, cloned);
      return cloneJson(cloned);
    });
  };

  const removeCompletionEvent = async (id, owner = null) => {
    const db = await getDb();
    if (!db) {
      const current = completionOutboxState.get(id);
      if (owner && current?.claimedBy !== owner) return false;
      completionOutboxState.delete(id);
      return true;
    }
    return withWriteLock(async () => {
      const transaction = db.transaction(COMPLETION_OUTBOX_STORE_NAME, "readwrite");
      const store = transaction.objectStore(COMPLETION_OUTBOX_STORE_NAME);
      const current = await requestValue(store.get(id));
      if (!current || (owner && current.claimedBy !== owner)) {
        await transactionDone(transaction);
        return false;
      }
      store.delete(id);
      await transactionDone(transaction);
      completionOutboxState.delete(id);
      return true;
    });
  };

  const clearCompletionOutbox = async () => {
    completionOutboxState = new Map();
    const db = await getDb();
    if (!db) return;
    await withWriteLock(async () => {
      const transaction = db.transaction(COMPLETION_OUTBOX_STORE_NAME, "readwrite");
      transaction.objectStore(COMPLETION_OUTBOX_STORE_NAME).clear();
      await transactionDone(transaction);
    });
  };

  const putCurrent = async (doc, shouldNotify = true) => {
    const db = await getDb();
    if (!db) {
      try {
        legacy?.setItem(key, JSON.stringify(doc));
      } catch {
        // The in-memory document remains usable when storage is unavailable.
      }
      return;
    }
    await withWriteLock(async () => {
      const transaction = db.transaction("documents", "readwrite");
      transaction.objectStore("documents").put({
        id: CURRENT_RECORD_ID,
        format: SPLIT_FORMAT,
        doc,
        archiveStats,
        updatedAt: Date.now(),
      });
      await transactionDone(transaction);
    });
    if (shouldNotify) notify(doc, false);
  };

  const replaceSplitState = async (doc, records, shouldNotify = true) => {
    const normalizedRecords = records.filter(Boolean).map((record) => archiveRecord(nodeFromArchiveRecord(record) || record));
    archiveStats = { count: normalizedRecords.length };
    memoryArchive = new Map(normalizedRecords.map((record) => [record.id, record]));

    const db = await getDb();
    if (!db) {
      try {
        legacy?.setItem(key, JSON.stringify(doc));
      } catch {
        // Keep the split projection in memory when IndexedDB is unavailable.
      }
      return;
    }
    await withWriteLock(async () => {
      const transaction = db.transaction(["documents", ARCHIVE_STORE_NAME], "readwrite");
      const archiveStore = transaction.objectStore(ARCHIVE_STORE_NAME);
      archiveStore.clear();
      for (const record of normalizedRecords) archiveStore.put(record);
      transaction.objectStore("documents").put({
        id: CURRENT_RECORD_ID,
        format: SPLIT_FORMAT,
        doc,
        archiveStats,
        updatedAt: Date.now(),
      });
      await transactionDone(transaction);
    });
    try {
      legacy?.setItem(key, JSON.stringify(doc));
    } catch {
      // IndexedDB remains the source of truth when the bootstrap copy is full.
    }
    if (shouldNotify) notify(doc, true);
  };

  const commit = async ({
    doc,
    put = [],
    remove = [],
    pendingOperations,
    syncMetadata,
  } = {}) => {
    const putRecords = put.filter(Boolean).map((node) => archiveRecord(nodeFromArchiveRecord(node) || node));
    const removeIds = [...new Set(remove.filter((id) => typeof id === "string"))];
    for (const record of putRecords) memoryArchive.set(record.id, record);
    for (const id of removeIds) memoryArchive.delete(id);
    archiveStats = { count: memoryArchive.size };
    const hasPendingOperations = pendingOperations !== undefined;
    const hasSyncMetadata = syncMetadata !== undefined;
    if (hasPendingOperations) pendingOperationsState = cloneJson(pendingOperations);
    if (hasSyncMetadata) syncMetadataState = cloneJson(syncMetadata);

    const run = async () => {
      const db = await getDb();
      if (!db) {
        await putCurrent(doc, false);
        return;
      }
      await withWriteLock(async () => {
        const stores = ["documents", ARCHIVE_STORE_NAME];
        if (hasPendingOperations) stores.push(PENDING_OPERATIONS_STORE_NAME);
        if (hasSyncMetadata) stores.push(SYNC_METADATA_STORE_NAME);
        const transaction = db.transaction(stores, "readwrite");
        const archiveStore = transaction.objectStore(ARCHIVE_STORE_NAME);
        for (const id of removeIds) archiveStore.delete(id);
        for (const record of putRecords) archiveStore.put(record);
        transaction.objectStore("documents").put({
          id: CURRENT_RECORD_ID,
          format: SPLIT_FORMAT,
          doc,
          archiveStats,
          updatedAt: Date.now(),
        });
        if (hasPendingOperations) {
          transaction.objectStore(PENDING_OPERATIONS_STORE_NAME).put({
            id: CURRENT_RECORD_ID,
            state: cloneJson(pendingOperationsState),
            updatedAt: Date.now(),
          });
        }
        if (hasSyncMetadata) {
          transaction.objectStore(SYNC_METADATA_STORE_NAME).put({
            id: CURRENT_RECORD_ID,
            metadata: cloneJson(syncMetadataState),
            updatedAt: Date.now(),
          });
        }
        await transactionDone(transaction);
      });
      notify(doc, putRecords.length > 0 || removeIds.length > 0);
    };
    writeChain = writeChain.then(run).catch(() => {
      // Persistence failures must not break editing in the current tab.
    });
    await writeChain;
  };

  const readArchiveNode = async (id) => {
    if (memoryArchive.has(id)) return nodeFromArchiveRecord(memoryArchive.get(id));
    const db = await getDb();
    if (!db) return null;
    const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
    const record = await requestValue(transaction.objectStore(ARCHIVE_STORE_NAME).get(id));
    await transactionDone(transaction);
    return nodeFromArchiveRecord(record);
  };

  const readArchiveSubtree = async (rootId) => {
    const found = [];
    const seen = new Set();
    const queue = [rootId];
    const db = await getDb();

    while (queue.length) {
      const id = queue.shift();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const node = await readArchiveNode(id);
      if (!node) continue;
      found.push(node);

      if (!db) {
        for (const child of memoryArchive.values()) {
          if (child.parentId === id && !seen.has(child.id)) queue.push(child.id);
        }
        continue;
      }

      const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
      const children = await requestValue(
        transaction.objectStore(ARCHIVE_STORE_NAME).index("parentId").getAll(IDBKeyRange.only(id))
      );
      await transactionDone(transaction);
      for (const child of children || []) if (child?.id && !seen.has(child.id)) queue.push(child.id);
    }
    return found;
  };

  const readArchiveDescendants = async (parentId) => {
    const found = [];
    const seen = new Set([parentId]);
    const queue = [parentId];
    const db = await getDb();

    while (queue.length) {
      const id = queue.shift();
      let children = [];
      if (!db) {
        children = [...memoryArchive.values()].filter((record) => record.parentId === id);
      } else {
        const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
        children = await requestValue(
          transaction.objectStore(ARCHIVE_STORE_NAME).index("parentId").getAll(IDBKeyRange.only(id))
        );
        await transactionDone(transaction);
      }
      for (const child of children || []) {
        if (!child?.id || seen.has(child.id)) continue;
        seen.add(child.id);
        const node = nodeFromArchiveRecord(child);
        if (node) found.push(node);
        queue.push(child.id);
      }
    }
    return found;
  };

  const queryArchiveMemory = ({ query, from, to, sort, offset, limit }) => {
    const records = [...memoryArchive.values()].filter((record) => matchesArchiveRecord(record, query, from, to));
    const compare = sort === "title-asc"
      ? (a, b) => (a.title || "").localeCompare(b.title || "") || (b.completedAt || 0) - (a.completedAt || 0)
      : (a, b) => (a.completedAt || 0) - (b.completedAt || 0);
    records.sort(compare);
    if (sort !== "title-asc" && sort !== "completed-asc") records.reverse();
    const items = records.slice(offset, offset + limit).map(archiveSummary).filter(Boolean);
    return { items, total: records.length, hasMore: offset + items.length < records.length };
  };

  const queryArchive = async ({
    query = "",
    from = null,
    to = null,
    sort = "completed-desc",
    offset = 0,
    limit = 100,
  } = {}) => {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
    const db = await getDb();
    if (!db) return queryArchiveMemory({ query: normalizedQuery, from, to, sort, offset, limit });

    const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
    const store = transaction.objectStore(ARCHIVE_STORE_NAME);
    const indexName = sort === "title-asc" ? "title" : "completedAt";
    const index = store.index(indexName);
    const range = indexName === "completedAt" ? normalizeRange(from, to) : null;
    const direction = sort === "completed-desc" ? "prev" : "next";
    const items = [];
    let total = 0;

    await new Promise((resolve, reject) => {
      const request = index.openCursor(range, direction);
      request.onerror = () => reject(request.error || new Error("Archive query failed"));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const record = cursor.value;
        if (matchesArchiveRecord(record, normalizedQuery, from, to)) {
          if (total >= offset && items.length < limit) {
            const summary = archiveSummary(record);
            if (summary) items.push(summary);
          }
          total += 1;
        }
        cursor.continue();
      };
    });
    await transactionDone(transaction);
    return { items, total, hasMore: offset + items.length < total };
  };

  const exportDocument = async (activeDoc) => {
    const records = [];
    const db = await getDb();
    if (!db) {
      for (const record of memoryArchive.values()) records.push(nodeFromArchiveRecord(record));
    } else {
      const transaction = db.transaction(ARCHIVE_STORE_NAME, "readonly");
      const all = await requestValue(transaction.objectStore(ARCHIVE_STORE_NAME).getAll());
      await transactionDone(transaction);
      for (const record of all || []) {
        const node = nodeFromArchiveRecord(record);
        if (node) records.push(node);
      }
    }
    const nodes = { ...(activeDoc?.nodes || {}) };
    for (const node of records) nodes[node.id] = node;
    return { ...activeDoc, storageFormat: undefined, nodes };
  };

  const backupRaw = async (raw, reason) => {
    if (typeof raw !== "string") return;
    const id = `${Date.now()}-${getSourceId()}`;
    try {
      legacy?.setItem(`${key}-legacy-backup-${id}`, raw);
    } catch {
      // IndexedDB remains the primary backup path when localStorage is full.
    }
    const db = await getDb();
    if (!db) return;
    try {
      const transaction = db.transaction("backups", "readwrite");
      transaction.objectStore("backups").put({ id, key, raw, reason, createdAt: Date.now() });
      await transactionDone(transaction);
    } catch {
      // Keep the localStorage backup if IndexedDB is unavailable at runtime.
    }
  };

  return {
    readLegacyRaw() {
      try {
        return legacy?.getItem(key) || null;
      } catch {
        return null;
      }
    },

    backupRaw,

    hydrate(fallbackDoc) {
      if (!hydrationPromise) {
        hydrationPromise = (async () => {
          const current = await readCurrent();
          if (isSplitDocumentRecord(current)) {
            archiveStats = current.archiveStats || { count: 0 };
            try {
              legacy?.setItem(key, JSON.stringify(current.doc));
            } catch {
              // Keep IndexedDB as the source of truth when the bootstrap copy is full.
            }
            return { doc: current.doc, source: "indexeddb", archiveStats };
          }

          const legacyDoc = current?.doc || current;
          const split = legacyDoc?.nodes ? splitDocument(legacyDoc) : splitDocument(fallbackDoc);
          await replaceSplitState(split.doc, split.archiveNodes, false);
          return { doc: split.doc, source: current ? "indexeddb" : "legacy", archiveStats };
        })().catch(() => {
          const split = splitDocument(fallbackDoc);
          memoryArchive = new Map(split.archiveNodes.map((record) => [record.id, record]));
          archiveStats = { count: split.archiveNodes.length };
          return { doc: split.doc, source: "fallback", archiveStats };
        });
      }
      return hydrationPromise;
    },

    write(doc) {
      writeChain = writeChain
        .then(async () => {
          if (hydrationPromise) await hydrationPromise;
          await putCurrent(doc);
        })
        .catch(() => {
          // Persistence failures must not break editing in the current tab.
        });
      return writeChain;
    },

    commit,
    readPendingOperations,
    writePendingOperations,
    readSyncMetadata,
    writeSyncMetadata,
    readSyncSecret,
    writeSyncSecret,
    clearSyncSecret,
    readIntegrationSettings,
    writeIntegrationSettings,
    clearIntegrationSettings,
    readCompletionOutbox,
    putCompletionEvent,
    claimCompletionEvent,
    updateCompletionEvent,
    removeCompletionEvent,
    clearCompletionOutbox,
    queryArchive,
    getArchiveNode: readArchiveNode,
    getArchiveSubtree: readArchiveSubtree,
    getArchiveDescendants: readArchiveDescendants,
    exportDocument,
    replaceDocument(fullDoc) {
      const split = splitDocument(fullDoc);
      return replaceSplitState(split.doc, split.archiveNodes);
    },
    archiveCount() {
      return archiveStats.count;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export { splitDocument, SPLIT_FORMAT };
export { STORAGE_SCHEMA_VERSION };
