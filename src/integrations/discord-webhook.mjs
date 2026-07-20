const DISCORD_WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com"]);
const WEBHOOK_PATH = /^\/api\/webhooks\/[^/]+\/[^/]+$/;
const MAX_TITLE_LENGTH = 240;
const MAX_CATEGORY_LENGTH = 120;
const MAX_DISPLAY_NAME_LENGTH = 40;

function cloneFetch(fetchImpl) {
  return fetchImpl || globalThis.fetch;
}

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function validateDiscordWebhookUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === "https:" &&
      DISCORD_WEBHOOK_HOSTS.has(url.hostname.toLowerCase()) &&
      WEBHOOK_PATH.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function maskDiscordWebhookUrl(value) {
  if (!validateDiscordWebhookUrl(value)) return "";
  try {
    const url = new URL(value.trim());
    return `${url.origin}/api/webhooks/••••••••`;
  } catch {
    return "";
  }
}

export function normalizeDisplayName(value) {
  return normalizeText(value, MAX_DISPLAY_NAME_LENGTH) || "Someone";
}

export function formatCompletionMessage({
  visibility = "hidden",
  title = "",
  category = "",
  displayName = "",
} = {}) {
  const name = normalizeDisplayName(displayName);
  if (visibility === "title") {
    const safeTitle = normalizeText(title, MAX_TITLE_LENGTH) || "Untitled task";
    return `${name} completed “${safeTitle}”.`;
  }
  if (visibility === "category") {
    const safeCategory = normalizeText(category, MAX_CATEGORY_LENGTH);
    if (safeCategory) return `${name} made progress in ${safeCategory}.`;
  }
  return `${name} moved one thing forward.`;
}

export function classifyDiscordResponse(status, headers = new Headers()) {
  if (status >= 200 && status < 300) return { ok: true, code: "ok", retryAfterMs: null };
  const retryAfter = Number(headers.get?.("Retry-After"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : null;
  if (status === 401) return { ok: false, code: "unauthorized", retryAfterMs };
  if (status === 403) return { ok: false, code: "forbidden", retryAfterMs };
  if (status === 404) return { ok: false, code: "notFound", retryAfterMs };
  if (status === 429) return { ok: false, code: "rateLimited", retryAfterMs };
  return { ok: false, code: "http", status, retryAfterMs };
}

async function postDiscordWebhook(url, content, { fetchImpl = cloneFetch(), signal } = {}) {
  if (!validateDiscordWebhookUrl(url)) return { ok: false, code: "invalidUrl" };
  if (typeof fetchImpl !== "function") return { ok: false, code: "network" };
  try {
    const response = await fetchImpl(url.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      redirect: "error",
      signal,
    });
    return classifyDiscordResponse(response.status, response.headers);
  } catch {
    return { ok: false, code: "network" };
  }
}

export function sendCompletionWebhook(url, payload, options = {}) {
  return postDiscordWebhook(
    url,
    formatCompletionMessage(payload),
    options,
  );
}

export function testDiscordWebhook(url, options = {}) {
  return postDiscordWebhook(
    url,
    "Taskliner is connected. Future completion updates can be posted here.",
    options,
  );
}

export { MAX_TITLE_LENGTH };
