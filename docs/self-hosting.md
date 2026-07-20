# Self-hosting

Self-hosting is documented so the MIT-licensed source is reproducible. It is **not** a recommendation that you run your own production instance, and it does **not** come with managed support.

A self-hosted deployment must **not** use Taskliner branding in a way that implies it is the official service. See [TRADEMARKS.md](../TRADEMARKS.md).

Availability, uptime, and behavior will not match [taskliner.app](https://taskliner.app).

## 1. Static UI only

From a checkout of this repository:

```bash
python -m http.server 5173
```

Open `http://localhost:5173`.

This path does not run OAuth or sync APIs.

You can also deploy the static files (and optionally Functions) to any static host. The official project uses Cloudflare Pages.

## 2. Enabling Google OAuth and sync

You will need:

1. A Google Cloud OAuth **web** client with redirect URI pointing at your origin’s `/api/auth/callback`
2. OAuth scopes: `openid`, `email`, `https://www.googleapis.com/auth/drive.appdata`
3. Cloudflare Pages (or equivalent) hosting for the static assets **and** Pages Functions under `functions/`
4. A Cloudflare D1 database bound as `DB`
5. Environment configuration (names only — never commit secret values)

### Environment variable names

| Name | Role |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret (store as a Secret) |
| `AUTH_SECRET` | Random signing secret, at least 32 bytes (store as a Secret) |
| `TASKLINER_SYNC_V3` | Set to `enabled` for encrypted sync v3 |
| `SYNC_ALLOWED_ORIGINS` | Optional comma-separated extra Origins for sync mutating requests |

Generate a signing secret locally, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Apply the D1 schema from `functions/schema.sql` (and migrations under `functions/migrations/` when needed). Details live in `functions/README.md`.

### Local Functions development

```bash
npx wrangler pages dev . --d1=DB=<your-d1-database-name>
```

Register the matching local callback URI in Google Cloud Console.

## 3. Optional Realtime Worker

The Durable Object Worker under `realtime-worker/` can notify connected clients that sync artifacts changed.

1. Deploy `realtime-worker/wrangler.toml`
2. Bind the Durable Object namespace to Pages Functions as `SYNC_ROOM`

WebSocket notifications are optional; HTTP polling still works without them.

## 4. What this does not promise

- No guarantee of the same reliability as the official host
- No individualized operator support (see [SUPPORT.md](../SUPPORT.md))
- No license to present your instance as official Taskliner
- Secret values must stay in your own secret store — never in git

## 5. Tests before you expose anything

```bash
node --test tests/*.test.mjs
node --check app.js
```
