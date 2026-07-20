import assert from "node:assert/strict";
import test from "node:test";

import { shouldDiscardDiscordOutbox } from "../src/integrations/discord-sync-policy.mjs";

const base = {
  webhookUrl: "https://discord.com/api/webhooks/1/token",
  enabled: true,
  automaticPost: true,
  visibility: "hidden",
  displayName: "Taskliner",
};

test("remote endpoint changes, disable, and tombstones discard the local Discord outbox", () => {
  assert.equal(shouldDiscardDiscordOutbox(base, { ...base, webhookUrl: "https://discord.com/api/webhooks/2/token" }), true);
  assert.equal(shouldDiscardDiscordOutbox(base, { ...base, enabled: false }), true);
  assert.equal(shouldDiscardDiscordOutbox(base, null), true);
});

test("display name and visibility changes preserve snapshotted outbox events", () => {
  assert.equal(shouldDiscardDiscordOutbox(base, { ...base, displayName: "Other" }), false);
  assert.equal(shouldDiscardDiscordOutbox(base, { ...base, visibility: "title" }), false);
});
