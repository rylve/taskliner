import { createAccountId, getSessionUser } from "../_lib/auth.mjs";
import { notifySyncChange } from "../_lib/realtime.mjs";
import {
  activateE2eeMigration,
  beginE2eeMigration,
  deleteSyncArtifact,
  deleteTasklinerData,
  ensureSyncV3Schema,
  getE2eeStatus,
  getLegacyInventory,
  getSyncSnapshot,
  getV3Snapshot,
  initializeE2eeWorkspace,
  beginE2eeWorkspaceInitialization,
  finalizeE2eeWorkspaceInitialization,
  putDeviceState,
  putSyncArtifact,
} from "../_lib/sync.mjs";
import { assertArtifactId, assertMutationOrigin, isSyncArtifactKind, isV3SyncEnabled } from "../_lib/sync-artifacts.mjs";

function json(data, init = {}) {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init.headers || {}) } });
}

async function authenticated({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) throw Object.assign(new Error("Google authorization is required"), { status: 401 });
  return user;
}

function errorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return json({
    error: status === 401 ? "authorization_required" : status === 403 ? "forbidden" : "sync_failed",
    code: error?.code || null,
    message: status < 500 ? error.message : "Sync failed",
  }, { status });
}

function publicSnapshot(snapshot, accountId) {
  return {
    accountId,
    workspaceId: snapshot.workspaceId,
    devices: snapshot.devices.map(({ file, state }) => ({ fileId: file.id, modifiedTime: file.modifiedTime, state })),
    staleDevices: snapshot.staleDevices || [],
    fingerprint: snapshot.fingerprint,
    mergedState: snapshot.mergedState,
  };
}

function assertV3Available(context, status = null) {
  if (status === "encrypted-active" || status === "migrating") return;
  if (!isV3SyncEnabled(context.env, context.request.url)) {
    throw Object.assign(new Error("Sync v3 is not enabled"), { status: 404, code: "v3_disabled" });
  }
}

async function v3Response(context, user, { kind = null, artifactId = null } = {}) {
  const accountId = await createAccountId(context.env.AUTH_SECRET, user.google_sub);
  if (kind === "status") {
    const e2ee = await getE2eeStatus(context.env, user);
    const legacy = e2ee.status === "encrypted-active" ? { fingerprint: "empty", count: 0 } : await getLegacyInventory(context.env, user);
    return json({ accountId, e2ee, legacy, artifacts: [], fingerprint: "empty" });
  }
  if (kind && !isSyncArtifactKind(kind)) throw Object.assign(new Error("Unsupported sync artifact kind"), { status: 400, code: "invalid_kind" });
  if (artifactId) assertArtifactId(artifactId);
  const snapshot = await getV3Snapshot(context.env, user, {
    kind,
    artifactId,
    ifNoneMatch: context.request.headers.get("If-None-Match"),
  });
  if (snapshot.notModified) {
    return new Response(null, { status: 304, headers: { ETag: `"${snapshot.fingerprint}"`, "Cache-Control": "no-store" } });
  }
  return json({ accountId, ...snapshot }, { headers: { ETag: `"${snapshot.fingerprint}"` } });
}

export async function onRequestGet(context) {
  try {
    const user = await authenticated(context);
    await ensureSyncV3Schema(context.env);
    const url = new URL(context.request.url);
    const version3 = url.searchParams.get("version") === "3" || url.searchParams.has("kind");
    if (version3) {
      const status = await getE2eeStatus(context.env, user);
      assertV3Available(context, status.status);
      return v3Response(context, user, {
        kind: url.searchParams.get("kind"),
        artifactId: url.searchParams.get("artifactId"),
      });
    }
    const status = await getE2eeStatus(context.env, user);
    if (["migrating", "encrypted-active"].includes(status.status)) {
      throw Object.assign(new Error("Plaintext sync is disabled for this account"), { status: 409, code: "e2ee_upgrade_required" });
    }
    const snapshot = await getSyncSnapshot(context.env, user, { ifNoneMatch: context.request.headers.get("If-None-Match") });
    if (snapshot.notModified) {
      return new Response(null, {
        status: 304,
        headers: { ETag: `"${snapshot.fingerprint}"`, "Cache-Control": "no-store" },
      });
    }
    return json(publicSnapshot(snapshot, await createAccountId(context.env.AUTH_SECRET, user.google_sub)), {
      headers: { ETag: `"${snapshot.fingerprint}"` },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestPut(context) {
  try {
    assertMutationOrigin(context.request, context.env);
    const user = await authenticated(context);
    await ensureSyncV3Schema(context.env);
    const body = await context.request.json();
    const status = await getE2eeStatus(context.env, user);
    if (body?.kind === "workspace") {
      assertV3Available(context, status.status);
      let result;
      if (body.action === "initialize") result = await initializeE2eeWorkspace(context.env, user, body);
      else if (body.action === "begin") result = await beginE2eeWorkspaceInitialization(context.env, user, body);
      else if (body.action === "finalize") result = await finalizeE2eeWorkspaceInitialization(context.env, user, body);
      else throw Object.assign(new Error("Unsupported workspace action"), { status: 400, code: "invalid_action" });
      return json({ accountId: await createAccountId(context.env.AUTH_SECRET, user.google_sub), e2ee: result });
    }
    if (body?.kind === "migration") {
      assertV3Available(context, status.status);
      let result;
      if (body.action === "begin") result = await beginE2eeMigration(context.env, user, body);
      else if (body.action === "activate") result = await activateE2eeMigration(context.env, user, body);
      else throw Object.assign(new Error("Unsupported migration action"), { status: 400, code: "invalid_action" });
      return json({ accountId: await createAccountId(context.env.AUTH_SECRET, user.google_sub), migration: result });
    }
    if (isSyncArtifactKind(body?.kind)) {
      assertV3Available(context, status.status);
      const result = await putSyncArtifact(context.env, user, body);
      const accountId = await createAccountId(context.env.AUTH_SECRET, user.google_sub);
      context.waitUntil?.(notifySyncChange(context.env, accountId, {
        fingerprint: result.fingerprint,
        kind: body.kind,
        artifactId: body.artifactId,
      }).catch(() => undefined));
      return json({ accountId, ...result }, { headers: { ETag: `"${result.fingerprint}"` } });
    }
    if (!body?.state || typeof body.state !== "object") return json({ error: "invalid_state" }, { status: 400 });
    const snapshot = await putDeviceState(context.env, user, body.state);
    const accountId = await createAccountId(context.env.AUTH_SECRET, user.google_sub);
    context.waitUntil?.(notifySyncChange(context.env, accountId, { fingerprint: snapshot.fingerprint }).catch(() => undefined));
    return json(publicSnapshot(snapshot, accountId), { headers: { ETag: `"${snapshot.fingerprint}"` } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequestDelete(context) {
  try {
    assertMutationOrigin(context.request, context.env);
    const user = await authenticated(context);
    await ensureSyncV3Schema(context.env);
    const url = new URL(context.request.url);
    const kind = url.searchParams.get("kind");
    const artifactId = url.searchParams.get("artifactId");
    const accountId = await createAccountId(context.env.AUTH_SECRET, user.google_sub);
    if (url.searchParams.get("version") === "3" || kind || artifactId) {
      const status = await getE2eeStatus(context.env, user);
      assertV3Available(context, status.status);
      if (!isSyncArtifactKind(kind)) throw Object.assign(new Error("Unsupported sync artifact kind"), { status: 400, code: "invalid_kind" });
      assertArtifactId(artifactId);
      const result = await deleteSyncArtifact(context.env, user, { kind, artifactId });
      context.waitUntil?.(notifySyncChange(context.env, accountId, { kind, artifactId, deleted: true }).catch(() => undefined));
      return json(result);
    }
    const result = await deleteTasklinerData(context.env, user);
    context.waitUntil?.(notifySyncChange(context.env, accountId, { deleted: true }).catch(() => undefined));
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
