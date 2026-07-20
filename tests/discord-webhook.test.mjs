import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompletionMessage,
  sendCompletionWebhook,
  testDiscordWebhook,
  validateDiscordWebhookUrl,
} from "../src/integrations/discord-webhook.mjs";
import {
  COMPLETION_UNDO_DELAY_MS,
  createCompletionEvent,
  createCompletionOutbox,
  retryDelayMs,
} from "../src/integrations/completion-outbox.mjs";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123456/token-value";

function makeStorage() {
  const events = new Map();
  return {
    events,
    async readCompletionOutbox() {
      return [...events.values()].map((event) => structuredClone(event));
    },
    async putCompletionEvent(event) {
      events.set(event.id, structuredClone(event));
    },
    async claimCompletionEvent(id, owner, now, leaseMs) {
      const event = events.get(id);
      if (!event || event.status !== "pending" || (event.claimUntil > now && event.claimedBy !== owner)) return false;
      events.set(id, { ...event, claimedBy: owner, claimUntil: now + leaseMs });
      return true;
    },
    async removeCompletionEvent(id, owner = null) {
      const event = events.get(id);
      if (!event || (owner && event.claimedBy !== owner)) return false;
      events.delete(id);
      return true;
    },
    async updateCompletionEvent(id, event, owner = null) {
      const current = events.get(id);
      if (!current || (owner && current.claimedBy !== owner)) return null;
      events.set(id, structuredClone(event));
      return event;
    },
    async clearCompletionOutbox() {
      events.clear();
    },
  };
}

test("Discord webhook URLs are restricted to HTTPS Discord webhook paths", () => {
  assert.equal(validateDiscordWebhookUrl(WEBHOOK_URL), true);
  assert.equal(validateDiscordWebhookUrl("https://example.com/api/webhooks/1/token"), false);
  assert.equal(validateDiscordWebhookUrl("http://discord.com/api/webhooks/1/token"), false);
  assert.equal(validateDiscordWebhookUrl("https://discord.com/api/webhooks/1/token?leak=1"), false);
});

test("completion messages use the selected visibility and safe fallback", () => {
  assert.equal(formatCompletionMessage({ visibility: "hidden", displayName: "pibo" }), "pibo moved one thing forward.");
  assert.equal(formatCompletionMessage({ visibility: "category", category: "Development", displayName: "pibo" }), "pibo made progress in Development.");
  assert.equal(formatCompletionMessage({ visibility: "title", title: "", displayName: "Someone" }), "Someone completed “Untitled task”.");
  assert.equal(formatCompletionMessage({ visibility: "title", title: "Finish @everyone", displayName: "Someone" }), "Someone completed “Finish @everyone”.");
});

test("Discord POST includes an empty allowed_mentions parse list", async () => {
  let request;
  const result = await testDiscordWebhook(WEBHOOK_URL, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, WEBHOOK_URL);
  assert.deepEqual(JSON.parse(request.options.body).allowed_mentions, { parse: [] });
  assert.equal(request.options.redirect, "error");
});

test("completion outbox waits for Undo and sends one event", async () => {
  const storage = makeStorage();
  const settingsStore = {
    async readDiscord() {
      return { enabled: true, automaticPost: true, webhookUrl: WEBHOOK_URL, visibility: "hidden", displayName: "pibo" };
    },
  };
  let currentTime = 1000;
  let sends = 0;
  const outbox = createCompletionOutbox({
    storage,
    settingsStore,
    now: () => currentTime,
    setTimeoutImpl: () => 0,
    send: async () => {
      sends += 1;
      return { ok: true };
    },
  });

  const event = await outbox.enqueueCompletion({ taskId: "parent", title: "Parent", category: "Development" });
  assert.equal(event.availableAt, currentTime + COMPLETION_UNDO_DELAY_MS);
  await outbox.process();
  assert.equal(sends, 0);
  currentTime += COMPLETION_UNDO_DELAY_MS;
  await outbox.process();
  assert.equal(sends, 1);
  assert.equal((await outbox.status()).pending, 0);
});

test("outbox snapshots the configured visibility at completion time", async () => {
  const storage = makeStorage();
  const settingsStore = {
    async readDiscord() {
      return { enabled: true, automaticPost: true, webhookUrl: WEBHOOK_URL, visibility: "title", displayName: "pibo" };
    },
  };
  const outbox = createCompletionOutbox({ storage, settingsStore, now: () => 1000, setTimeoutImpl: () => 0 });
  const event = await outbox.enqueueCompletion({ taskId: "task-1", title: "Implement export flow", category: "Development" });
  assert.equal(event.visibility, "title");
  assert.equal(event.titleSnapshot, "Implement export flow");
});

test("Undo cancellation removes the pending completion event", async () => {
  const storage = makeStorage();
  const settingsStore = {
    async readDiscord() {
      return { enabled: true, automaticPost: true, webhookUrl: WEBHOOK_URL, visibility: "title", displayName: "Someone" };
    },
  };
  let sends = 0;
  const outbox = createCompletionOutbox({
    storage,
    settingsStore,
    now: () => 1000,
    setTimeoutImpl: () => 0,
    send: async () => {
      sends += 1;
      return { ok: true };
    },
  });
  await outbox.enqueueCompletion({ taskId: "parent", title: "Parent" });
  await outbox.cancelForTask("parent");
  await outbox.process();
  assert.equal(sends, 0);
  assert.equal((await outbox.status()).pending, 0);
});

test("429 retry delay never becomes an immediate retry", () => {
  assert.equal(retryDelayMs(1, 10), 60_000);
  assert.equal(retryDelayMs(2, 360_000), 360_000);
  assert.equal(createCompletionEvent({ visibility: "hidden", title: "secret" }).titleSnapshot, undefined);
});
