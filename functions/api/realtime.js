import { createAccountId, getSessionUser } from "../_lib/auth.mjs";

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return new Response("Google authorization is required", { status: 401 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  if (!env.SYNC_ROOM) return new Response("Realtime sync is not configured", { status: 503 });
  const accountId = await createAccountId(env.AUTH_SECRET, user.google_sub);
  const roomId = env.SYNC_ROOM.idFromName(`account:${accountId}`);
  return env.SYNC_ROOM.get(roomId).fetch(request);
}
