import { createSyncContentSnapshot } from "./content-snapshot.mjs";

/**
 * Capture the two document shapes needed while applying a remote projection.
 * The transport compares complete documents, including archived payloads.
 * The second check watches the live active projection for edits during I/O.
 */
export async function createSyncApplyGuard({ storage, activeDoc, expectedFullSnapshot = null } = {}) {
  if (!storage || typeof storage.exportDocument !== "function") {
    throw new TypeError("A storage adapter with exportDocument is required");
  }
  const activeSnapshot = createSyncContentSnapshot(activeDoc);
  if (expectedFullSnapshot === null) {
    return { matchesExpectedFullDocument: true, activeSnapshot };
  }
  const fullDoc = await storage.exportDocument(activeDoc);
  return {
    matchesExpectedFullDocument: createSyncContentSnapshot(fullDoc) === expectedFullSnapshot,
    activeSnapshot,
  };
}

export function activeProjectionIsCurrent(activeSnapshot, activeDoc) {
  return createSyncContentSnapshot(activeDoc) === activeSnapshot;
}
