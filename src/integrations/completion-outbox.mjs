import { sendCompletionWebhook } from "./discord-webhook.mjs";

export const COMPLETION_OUTBOX_LIMIT = 100;
export const COMPLETION_UNDO_DELAY_MS = 5000;
export const COMPLETION_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000];
const MAX_ATTEMPTS = COMPLETION_RETRY_DELAYS_MS.length + 1;
const CLAIM_LEASE_MS = 30_000;

function createId() {
  try {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function eventPayload(event) {
  return {
    visibility: event.visibility,
    title: event.titleSnapshot || "",
    category: event.categorySnapshot || "",
    displayName: event.displayNameSnapshot || "",
  };
}

export function createCompletionEvent({
  taskId,
  title = "",
  category = "",
  visibility = "hidden",
  displayName = "",
  createdAt = Date.now(),
  id = createId(),
} = {}) {
  const event = {
    id,
    taskId: typeof taskId === "string" ? taskId : "",
    createdAt,
    availableAt: createdAt + COMPLETION_UNDO_DELAY_MS,
    visibility,
    status: "pending",
    attemptCount: 0,
    lastErrorCode: null,
    titleSnapshot: visibility === "title" ? String(title || "").slice(0, 240) : undefined,
    categorySnapshot: visibility === "category" ? String(category || "").slice(0, 120) : undefined,
    displayNameSnapshot: String(displayName || "").slice(0, 40),
  };
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

export function retryDelayMs(attemptCount, retryAfterMs = null) {
  const backoff = COMPLETION_RETRY_DELAYS_MS[Math.max(0, attemptCount - 1)] || 0;
  return Math.max(backoff, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}

export function createCompletionOutbox({
  storage,
  settingsStore,
  send = sendCompletionWebhook,
  fetchImpl,
  now = () => Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
} = {}) {
  const ownerId = createId();
  let timers = new Map();

  const readEvents = () => storage.readCompletionOutbox();

  const schedule = (event) => {
    if (!event || event.status !== "pending") return;
    const delay = Math.max(0, Number(event.availableAt || 0) - now());
    if (timers.has(event.id)) return;
    const timer = setTimeoutImpl(() => {
      timers.delete(event.id);
      void process();
    }, delay);
    timers.set(event.id, timer);
  };

  const scheduleAll = (events) => {
    for (const event of events) schedule(event);
  };

  async function process() {
    const settings = await settingsStore.readDiscord({ fresh: true });
    if (!settings.enabled || !settings.automaticPost || !settings.webhookUrl) return;
    const current = await readEvents();
    const eligible = current
      .filter((event) => event.status === "pending" && Number(event.availableAt || 0) <= now())
      .sort((a, b) => Number(a.availableAt || 0) - Number(b.availableAt || 0));

    for (const event of eligible) {
      const claimed = await storage.claimCompletionEvent(event.id, ownerId, now(), CLAIM_LEASE_MS);
      if (!claimed) continue;
      let result;
      try {
        result = await send(settings.webhookUrl, eventPayload(event), { fetchImpl });
      } catch {
        result = { ok: false, code: "network" };
      }
      if (result?.ok) {
        await storage.removeCompletionEvent(event.id, ownerId);
        continue;
      }

      const attemptCount = Number(event.attemptCount || 0) + 1;
      const status = attemptCount >= MAX_ATTEMPTS ? "failed" : "pending";
      const next = {
        ...event,
        status,
        attemptCount,
        lastErrorCode: result?.code || "network",
        availableAt: now() + retryDelayMs(attemptCount, result?.retryAfterMs),
        claimedBy: undefined,
        claimUntil: undefined,
      };
      await storage.updateCompletionEvent(event.id, next, ownerId);
      if (status === "pending") schedule(next);
    }
  }

  async function enqueueCompletion(payload) {
    const settings = await settingsStore.readDiscord({ fresh: true });
    if (!settings.enabled || !settings.automaticPost || !settings.webhookUrl) return null;
    const current = await readEvents();
    if (current.length >= COMPLETION_OUTBOX_LIMIT) return null;
    const event = createCompletionEvent({
      ...payload,
      visibility: settings.visibility,
      displayName: settings.displayName,
      createdAt: now(),
    });
    await storage.putCompletionEvent(event);
    const currentSettings = await settingsStore.readDiscord({ fresh: true });
    if (!currentSettings.enabled || !currentSettings.webhookUrl) {
      await storage.removeCompletionEvent(event.id);
      return null;
    }
    schedule(event);
    return event;
  }

  async function cancelForTask(taskId) {
    if (!taskId) return;
    const current = await readEvents();
    for (const event of current) {
      if (event.taskId === taskId && event.status === "pending") {
        const timer = timers.get(event.id);
        if (timer != null) globalThis.clearTimeout?.(timer);
        timers.delete(event.id);
        await storage.removeCompletionEvent(event.id);
      }
    }
  }

  async function retryFailed() {
    const current = await readEvents();
    const retried = [];
    for (const event of current) {
      if (event.status !== "failed") continue;
      const next = {
        ...event,
        status: "pending",
        availableAt: now(),
        lastErrorCode: null,
        claimedBy: undefined,
        claimUntil: undefined,
      };
      await storage.updateCompletionEvent(event.id, next);
      retried.push(next);
    }
    scheduleAll(retried);
    await process();
  }

  async function clear() {
    for (const timer of timers.values()) globalThis.clearTimeout?.(timer);
    timers = new Map();
    await storage.clearCompletionOutbox();
  }

  async function status() {
    const current = await readEvents();
    return {
      pending: current.filter((event) => event.status === "pending").length,
      failed: current.filter((event) => event.status === "failed").length,
    };
  }

  return {
    enqueueCompletion,
    cancelForTask,
    process,
    retryFailed,
    clear,
    status,
    async start() {
      const current = await readEvents();
      scheduleAll(current);
      await process();
    },
  };
}
