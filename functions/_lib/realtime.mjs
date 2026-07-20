export async function notifySyncChange(env, accountId, payload = {}) {
  if (!env.SYNC_ROOM || !accountId) return;
  const id = env.SYNC_ROOM.idFromName(`account:${accountId}`);
  const room = env.SYNC_ROOM.get(id);
  await room.fetch("https://taskliner-sync/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "changed", ...payload }),
  });
}
