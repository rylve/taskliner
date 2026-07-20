export const SYNC_V3_ARTIFACT_KINDS = Object.freeze([
  "device-envelope",
  "key-wrapper",
  "shared-setting",
  "pairing-offer",
  "pairing-request",
  "pairing-response",
]);

const ARTIFACT_KINDS = new Set(SYNC_V3_ARTIFACT_KINDS);

function assertKind(kind) {
  if (!ARTIFACT_KINDS.has(kind)) throw new TypeError(`Unsupported sync v3 artifact kind: ${kind}`);
}

function assertArtifactId(artifactId) {
  if (typeof artifactId !== "string" || !artifactId || artifactId.length > 160) {
    throw new TypeError("artifactId must be a non-empty string of at most 160 characters");
  }
}

export class SyncV3ApiError extends Error {
  constructor(message, { status = 0, code = "sync_v3_failed", body = null } = {}) {
    super(message);
    this.name = "SyncV3ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class SyncV3ConflictError extends SyncV3ApiError {
  constructor(message, details = {}) {
    super(message, { ...details, status: 409 });
    this.name = "SyncV3ConflictError";
  }
}

export function createSyncV3Api({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetchImpl(path, {
        credentials: "include",
        cache: "no-store",
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        },
      });
    } catch {
      throw new SyncV3ApiError("Taskliner sync server is unavailable", { code: "sync_v3_unavailable" });
    }

    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const details = {
        status: response.status,
        code: typeof body?.code === "string" ? body.code : "sync_v3_failed",
        body,
      };
      const message = body?.message || `Sync v3 request failed: ${response.status}`;
      if (response.status === 409) throw new SyncV3ConflictError(message, details);
      throw new SyncV3ApiError(message, details);
    }
    return body;
  }

  function artifactQuery(kind, artifactId = null) {
    assertKind(kind);
    const query = new URLSearchParams({ version: "3", kind });
    if (artifactId != null) {
      assertArtifactId(artifactId);
      query.set("artifactId", artifactId);
    }
    return `/api/sync?${query}`;
  }

  return {
    status() {
      return request("/api/sync?version=3&kind=status");
    },

    list(kind) {
      return request(artifactQuery(kind));
    },

    get(kind, artifactId) {
      return request(artifactQuery(kind, artifactId));
    },

    put(kind, artifactId, payload) {
      assertKind(kind);
      assertArtifactId(artifactId);
      return request("/api/sync?version=3", {
        method: "PUT",
        body: JSON.stringify({ kind, artifactId, payload }),
      });
    },

    delete(kind, artifactId) {
      return request(artifactQuery(kind, artifactId), { method: "DELETE" });
    },

    deleteAll() {
      return request("/api/sync", { method: "DELETE" });
    },

    initializeWorkspace({ workspaceId, keyId }) {
      return request("/api/sync?version=3", {
        method: "PUT",
        body: JSON.stringify({ kind: "workspace", action: "initialize", workspaceId, keyId }),
      });
    },

    beginWorkspaceInitialization({ workspaceId, keyId }) {
      return request("/api/sync?version=3", {
        method: "PUT",
        body: JSON.stringify({ kind: "workspace", action: "begin", workspaceId, keyId }),
      });
    },

    finalizeWorkspaceInitialization({ lockToken, workspaceId, keyId, verifiedDeviceId, requirePasskey = false }) {
      return request("/api/sync?version=3", {
        method: "PUT",
        body: JSON.stringify({
          kind: "workspace",
          action: "finalize",
          lockToken,
          workspaceId,
          keyId,
          verifiedDeviceId,
          requirePasskey,
        }),
      });
    },

    beginMigration({ workspaceId, keyId, expectedFingerprint, migrationPublicKey }) {
      return request("/api/sync?version=3", {
        method: "PUT",
        body: JSON.stringify({
          kind: "migration",
          action: "begin",
          workspaceId,
          keyId,
          expectedFingerprint,
          migrationPublicKey,
        }),
      });
    },

    activateMigration({ lockToken, expectedFingerprint, verifiedV3Fingerprint }) {
      return request("/api/sync?version=3", {
        method: "PUT",
        body: JSON.stringify({
          kind: "migration",
          action: "activate",
          lockToken,
          expectedFingerprint,
          verifiedV3Fingerprint,
        }),
      });
    },
  };
}
