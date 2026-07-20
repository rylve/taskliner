# Taskliner

<p align="center">
  <img src="./logo-mark.svg" alt="Taskliner" width="96" height="96">
</p>

**A fast, keyboard-first task outliner.**  
Local-first, private, open source, and ad-free.

**Official app:** [https://taskliner.app](https://taskliner.app)

## Screenshot

<p align="center">
  <img src="./docs/screenshots/desktop-outline.jpg" alt="Taskliner desktop outline view with task details" width="720">
</p>

<p align="center">
  <img src="./docs/screenshots/desktop-zoom.jpg" alt="Taskliner desktop focused task view" width="720">
  <img src="./docs/screenshots/mobile-outline.jpg" alt="Taskliner mobile outline view" width="240">
</p>

## Features

- Infinite-depth outline editing that feels like Markdown bullets
- Keyboard-first navigation, indent, split, focus, and complete
- Collapse / expand, focus (zoom), search, and due-date sorting
- Optional due dates and Markdown detail notes
- Mobile branch / outline views with quick add and reorder
- JSON export / import with schema versioning
- Japanese and English UI
- Optional Discord completion webhook (sent from your browser)
- Optional end-to-end encrypted Google Drive sync

## Keyboard essentials

| Action | Shortcut |
| --- | --- |
| Indent / outdent | `Tab` / `Shift+Tab` |
| Add / split line | `Enter` |
| Complete / restore | `Ctrl+Enter` |
| Focus current item | `Ctrl+.` |
| Step back from focus | `Esc` |
| Undo | `Ctrl+Z` |

More shortcuts are listed in the in-app help (`?`).

## Local-first and data ownership

- Local use needs **no account**
- Task content is stored in your browser (IndexedDB; legacy `localStorage` is migrated safely)
- Taskliner does **not** store your task titles or notes in its own D1/KV database
- You can export and import JSON at any time

## Google Drive sync (optional)

If you connect Google:

1. Your browser encrypts sync artifacts with a workspace key (AES-256-GCM)
2. Cloudflare Pages Functions relay OAuth and Drive `appDataFolder` traffic
3. Encrypted artifacts live in **your** Google Drive app data folder
4. Device unlock uses a Taskliner passkey (WebAuthn PRF when available), existing-device approval, or a recovery file

Sync is optional. Local-only use stays account-free.

## Security boundary (short)

**Protected in the sync path:** task content, Discord Webhook URL, workspace key material, and recovery material — kept out of Taskliner’s own long-term D1/KV storage as plaintext.

**Not covered by sync encryption:** plaintext local IndexedDB on your device, compromised browsers/devices, screen capture, and losing every unlock method (devices + passkey + recovery file).

This repository documents the model for transparency. It is **not** a formal security audit. See [docs/security-model.md](./docs/security-model.md).

## Run locally (static UI)

No dependency install is required for the static shell.

```bash
python -m http.server 5173
```

Open `http://localhost:5173`.

This serves the UI only. OAuth and sync APIs need Pages Functions (see [docs/self-hosting.md](./docs/self-hosting.md)).

## Tests

```bash
node --test tests/*.test.mjs
node --check app.js
```

Manual checks: [docs/manual-tests.md](./docs/manual-tests.md).

## Self-hosting

You can host the static UI yourself, and optionally wire Google OAuth + Cloudflare Functions for sync.

Self-hosting is provided for reproducibility under the MIT License. It is **not** an offer of managed support, and a self-hosted site must not be presented as the official Taskliner service. See [docs/self-hosting.md](./docs/self-hosting.md) and [TRADEMARKS.md](./TRADEMARKS.md).

## Feedback and contributions

Bug reports and concrete feedback are welcome.

Taskliner is mainly developed by the maintainer. Replies, fixes, and pull request review are not guaranteed. Large changes need an Issue discussion first. See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SUPPORT.md](./SUPPORT.md).

## License and trademarks

- Source code: [MIT License](./LICENSE)
- Name, logo, and brand assets: **not** covered by the MIT License — see [TRADEMARKS.md](./TRADEMARKS.md)
- Third-party notices: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

## Further reading

- [docs/architecture.md](./docs/architecture.md)
- [docs/security-model.md](./docs/security-model.md)
- [docs/self-hosting.md](./docs/self-hosting.md)
- [SECURITY.md](./SECURITY.md)
