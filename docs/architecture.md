# Architecture

Taskliner is a browser-based outline task editor with local-first storage and optional encrypted multi-device sync.

## Static frontend

The UI is static HTML, CSS, and JavaScript (`index.html`, `app.js`, `src/`, styles, and related assets). No application server is required for local-only use.

## Local-first storage

- Authoritative on-device store: IndexedDB (`taskliner-local-first`)
- Legacy `localStorage["taskliner-v1"]` is migrated safely and kept as a backup after migration
- Outline structure, completion state, due dates, notes, and UI preferences live on the device

## Optional Google Drive sync

When sync is enabled:

1. The browser encrypts device state and shared settings with a workspace data key (AES-256-GCM)
2. Cloudflare Pages Functions authenticate the user and relay Drive `appDataFolder` reads/writes
3. Encrypted artifacts are stored in the user’s own Google Drive application data folder

Taskliner does **not** store task titles or notes in its own D1/KV as plaintext application data.

## Cloudflare Pages Functions

Functions handle:

- Google OAuth code exchange and session cookies
- Drive API relay for sync artifacts
- Outer schema, origin, size, and expiry checks

Decryption, merge, and projection of task state happen in the browser, not on the server.

D1 may hold encrypted OAuth refresh tokens, Google account identifiers, and non-secret E2EE cutover metadata.

## Realtime Worker

An optional Durable Object Worker can push lightweight “something changed” notifications over WebSocket. Notifications carry change facts and non-secret artifact identifiers, not task plaintext. HTTP polling remains the fallback.

## Discord webhook

Users may configure their own Discord Incoming Webhook URL. Completion posts are sent from the browser. The Webhook URL is not included in JSON export. With sync enabled, the shared Discord setting is encrypted with the workspace key; the send outbox stays device-local.

## Trust summary

| Layer | Role |
| --- | --- |
| Browser | Encrypts/decrypts, merges, renders, talks to Discord |
| Cloudflare Functions | OAuth, Drive relay, schema/size/origin gates |
| D1 | Encrypted refresh tokens + non-secret metadata |
| Google Drive appDataFolder | Encrypted sync artifacts owned by the user |
| Realtime Worker | Optional change notifications |

See also [security-model.md](./security-model.md) and [self-hosting.md](./self-hosting.md).
