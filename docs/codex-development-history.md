# Taskliner: Codex Development History

This document summarizes the Build Week development record from the repository's Git history, design documents, tests, browser checks, and demo materials. It is a public-facing summary rather than a complete transcript of every development session; claims are limited to evidence available in the repository.

## Project summary

Taskliner is a browser-based, keyboard-first outline task editor. Users can write tasks in the order they think, organize them into nested branches, and focus on the branch that matters. Local use requires no account. Optional synchronization uses encrypted artifacts in the user's Google Drive app data folder rather than storing task content in the service's long-term database.

## Build Week scope and public-history note

- The public repository is a clean release snapshot reconstructed on 2026-07-21. Its public Git history currently contains five commits, all dated 2026-07-21; it does not preserve the earlier working repository's full commit count.
- The largest Build Week extensions covered synchronization, end-to-end encryption, device onboarding, mobile UX, tutorials, deployment, and release preparation.
- The `tests/` directory contains coverage for the model, migrations, IndexedDB, synchronization, OAuth, encryption, pairing, Discord integration, and public-surface behavior.
- The project existed before Build Week. The phase-by-phase work is documented in [codex-session-work-map.md](./codex-session-work-map.md), design documents, test history, and the Codex submission evidence. The clean public snapshot should not be interpreted as a complete historical Git timeline.

This distinction is intentional: the repository is publishable and reproducible, while the development record remains explicit about which evidence comes from the reconstructed public snapshot and which comes from the dated Build Week work log. Some development logs were not suitable for public release; the complete commit-preserving repository log is provided separately as a ZIP attachment with the Build Week submission.

## Major implementation areas

### Outline editing

The editor supports deep indentation, keyboard navigation, split and focus operations, collapse and expand, search, due-date sorting, completion and restoration, Markdown detail notes, drag and drop, JSON import/export, and Japanese and English UI.

Evidence includes `src/model/`, `tests/model.test.mjs`, the outline tests, and the design documentation.

### Local-first storage and migration

IndexedDB is the source of truth, with a safe migration path from the earlier browser storage format. Validators, fixtures, JSON recovery, BroadcastChannel, Web Locks, and the Service Worker protect existing data during refactoring and multi-tab use.

The key decisions were to keep local use independent of accounts and never silently replace invalid data with an empty document.

### Mobile UX

Mobile uses separate Branch View and Outline View interactions: branch navigation, Quick Add, inline editing, detail sheets, destination picking, reorder mode, touch drag, and back navigation. This treats mobile as a context-preserving branch workflow rather than a scaled-down desktop screen.

Evidence includes `MOBILE_UX_DESIGN.md`, the related UI commits, UI tests, and mobile verification artifacts.

### Google OAuth and synchronization

Cloudflare Pages Functions handle authorization-code exchange, secure sessions, refresh-token protection, logout, revoke, and same-origin return-path validation. Synchronization uses per-device state files, debounced push, pull on lifecycle events, categorized failures, exponential backoff with jitter, pending operations, and operation IDs.

Important conservative decisions include avoiding an empty remote state being interpreted as a delete-all command, avoiding merges on account changes, excluding stale devices, using fingerprints and ETags to avoid unchanged downloads, and representing deletion with tombstones.

### Encryption, recovery, and device onboarding

The synchronization design uses a workspace data key, AES-256-GCM device envelopes, canonical associated data, non-exportable device keys, WebAuthn PRF-derived key encryption keys, recovery files and QR support, and P-256 ECDH-based device onboarding.

The server is limited to OAuth, artifact transport, and outer schema, origin, expiry, and size validation. Decryption, merging, and projection remain in the browser. This implements the product promise that the service does not hold users' task content.

### Realtime notifications

A Cloudflare Durable Object acts as a notification hub per Google account. WebSocket messages contain change signals and fingerprints, not task content. Clients then perform the normal HTTP synchronization flow, with HTTP fallback after disconnection. Local edits made while a pull is in progress are protected from accidental overwrite.

### Tutorial, public surface, and release operations

The isolated tutorial keeps practice data, authentication, synchronization, WebSocket behavior, Discord, and import/export separate from production data. The project also includes Privacy, Terms, Contact, Data & Sync, 404, favicon, social preview, sitemap, robots, CSP, deployment automation, a public-repository extraction script, an operations runbook, and secret-history checks.

## Where Codex accelerated the workflow

1. **Specification-to-implementation iteration**: Codex read the existing code, design documents, tests, and Git diffs together, then helped split cross-cutting changes into reviewable implementation and test steps.
2. **Real-browser debugging**: Browser and desktop UI checks exposed issues that unit tests could not, including mobile sheet behavior, sync overwrites during editing, tutorial data isolation, and production security headers. Those findings were converted into fixes and regression tests.
3. **Failure-first testing**: Encryption errors, OAuth failures, rate limits, empty remote state, stale devices, account mismatch, tombstones, and pairing recovery were enumerated and tested before the corresponding features were considered complete.
4. **Release-quality iteration**: Deployment checks, manual QA, security review, public-surface review, and demo preparation were treated as part of implementation rather than as a final afterthought.

## Key decisions made during the workflow

| Decision | Product or engineering consequence |
| --- | --- |
| Local use must remain account-free. | The core editor works without OAuth or synchronization. |
| Task content must not be stored as plaintext in the service database. | Encryption and content processing are browser-side responsibilities. |
| The remote store is not treated as a realtime database. | Pull and push have explicit lifecycle triggers, retries, fingerprints, and recovery behavior. |
| Mobile needs a branch-first interaction model. | Mobile navigation preserves context instead of presenting a compressed desktop tree. |
| Data-loss paths must fail conservatively. | Empty state, stale devices, account changes, deletion, and in-flight edits have explicit safeguards. |

## How GPT-5.6 and Codex were used

GPT-5.6 was used for product framing, architecture trade-off analysis, mobile information design, synchronization and recovery UX, and refinement of user-facing explanations. Codex turned those decisions into repository-wide implementation, tests, Git iterations, real-browser checks, deployment validation, and demo evidence.

The workflow was:

`investigate → specify → implement → test → verify in the browser → fix → document → prepare the release`

This is the central technical contribution of the AI-assisted workflow: Codex connected design reasoning with implementation and verification, while GPT-5.6 supported the product and engineering decisions that shaped the result.

## Repository evidence

- Design and architecture: `PRODUCT_RELEASE_PLAN.md`, `sync-v3-e2ee-spec.md`, `MOBILE_UX_DESIGN.md`, and `docs/optional-sync-encryption-policy.md`
- Implementation: `src/`, `functions/`, and `realtime-worker/`
- Quality assurance: `tests/`, `tests/MANUAL_TESTS.md`, and the pre-launch checks document
- Agent workflow rules: `.agents/AGENTS.md` and the agent-operations section in `TODO.md`
- Demo materials: `.tmp/demo-video/README.md`, `.tmp/demo-video/SCRIPT.md`, and the narration timeline
- Public extraction and safety checks: `scripts/export-public-repo.mjs` and `public-repo/`
- Session-to-work mapping: [codex-session-work-map.md](./codex-session-work-map.md)

## Evidence available to judges

The phase map, design documents, source directories, tests, and demo materials provide the technical evidence behind the workflow described here. The S01–S10 labels are explanatory work-group labels, not Codex Session IDs. The submission is represented by one identifier for the primary build thread containing most of the core implementation.
