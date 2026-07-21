const CACHE_NAME = "taskliner-shell-v33";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./guided.js",
  "./bootstrap.js",
  "./i18n.js",
  "./styles.css",
  "./theme.css",
  "./site.css",
  "./vendor/flatpickr/flatpickr.min.css",
  "./vendor/flatpickr/flatpickr.min.js",
  "./vendor/flatpickr/l10n/ja.js",
  "./favicon.svg",
  "./logo-mark.svg",
  "./404.html",
  "./privacy/",
  "./terms/",
  "./contact/",
  "./data-and-sync/",
  "./tutorial/",
  "./src/model/validate-tree.mjs",
  "./src/model/outline-selectors.mjs",
  "./src/model/outline-operations.mjs",
  "./src/storage/storage-adapter.mjs",
  "./src/storage/integration-settings.mjs",
  "./src/google/server-auth.mjs",
  "./src/google/taskliner-server-sync.mjs",
  "./src/google/taskliner-e2ee-sync.mjs",
  "./src/google/sync-v3-api.mjs",
  "./src/google/sync-v3-feature.mjs",
  "./src/crypto/e2ee-utils.mjs",
  "./src/crypto/device-envelope-v3.mjs",
  "./src/crypto/key-wrappers-v1.mjs",
  "./src/crypto/passkey-prf.mjs",
  "./src/crypto/browser-passkey.mjs",
  "./src/crypto/migration-bundle-v1.mjs",
  "./src/pairing/pairing-protocol-v1.mjs",
  "./src/pairing/pairing-fragment.mjs",
  "./src/pairing/qr-code.mjs",
  "./src/sync/backoff.mjs",
  "./src/sync/device-state.mjs",
  "./src/sync/merge.mjs",
  "./src/sync/project.mjs",
  "./src/sync/scheduler.mjs",
  "./src/sync/content-snapshot.mjs",
  "./src/sync/document-guard.mjs",
  "./src/integrations/completion-outbox.mjs",
  "./src/integrations/discord-webhook.mjs",
  "./src/integrations/discord-sync-policy.mjs",
  "./src/crypto/shared-setting-envelope-v1.mjs",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(new Request(event.request, { cache: "no-cache" }))
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return event.request.mode === "navigate" ? caches.match("./index.html") : Response.error();
      }))
  );
});
