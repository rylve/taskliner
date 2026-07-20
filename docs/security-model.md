# Security model

This document describes the intended security boundaries of Taskliner. It is documentation for transparency, **not** a formal audit report and **not** a guarantee of absolute safety.

## What we try to protect

In the sync and integration path:

- Task titles, notes, structure, and related outline content
- Discord Webhook URLs (when configured)
- Workspace Data Key (WDK) and recovery material

Design intent: keep those secrets out of Taskliner’s own long-term D1/KV storage as plaintext, and keep them encrypted while stored in Google Drive `appDataFolder` and while relayed through Cloudflare Functions.

## Trust boundaries

| Boundary | Notes |
| --- | --- |
| Your device / browser profile | Local IndexedDB holds task content in plaintext |
| Browser JS after unlock | Can decrypt workspace data; XSS after unlock is high impact |
| Cloudflare | Sees ciphertext, OAuth/session machinery, and ordinary request metadata |
| Google | Hosts encrypted appDataFolder blobs under the user’s account |
| Discord | Receives whatever the user configures a webhook to post |

## Browser-side encryption

- Workspace key material is generated and used in the browser
- Device envelopes and shared settings use AES-256-GCM with fresh nonces
- Unlock paths include device-local wrapping, WebAuthn PRF passkeys when available, existing-device approval, and recovery files

Cloudflare Functions validate authentication, Origin, outer schema, identifiers, expiry, and size. They do not decrypt or merge task bodies.

## What the server stores

Allowed in Taskliner-operated D1 (and related metadata):

- Encrypted Google OAuth refresh tokens
- Google account identifiers
- Non-secret E2EE cutover metadata

Not stored as Taskliner-owned plaintext application data:

- Task titles and notes
- Workspace Data Keys
- Discord Webhook URLs

## Local IndexedDB is plaintext

Sync encryption does **not** encrypt the on-device IndexedDB document. Anyone with access to the unlocked browser profile can read local tasks.

## Threats outside this model

Examples that are out of scope for “sync E2EE protects my tasks”:

- Malware, stolen laptop disk access, or OS compromise
- XSS that runs inside an already unlocked Taskliner tab
- Screen sharing, cameras, or keyloggers
- Compelled disclosure from Google about the user’s own Drive account
- Ordinary IP / User-Agent style request metadata

## Recovery failure mode

If you lose **all** of:

- every registered device,
- usable passkey unlock, and
- the recovery file,

then neither you nor the maintainer can recover the encrypted workspace.

## Reporting issues

See [SECURITY.md](../SECURITY.md).
