# Codex Session-to-Work Map

Updated: 2026-07-21

This is a public summary of the Build Week work phases. The labels below are explanatory work-group labels, not Codex Session IDs. The actual `/feedback` Session ID for the primary build thread must be retrieved from Codex and entered in the Devpost submission.

The public repository is a clean release snapshot and does not contain the complete historical Git timeline. These phases are therefore documented together with the relevant design documents, tests, demo materials, and dated session evidence.

## Work phases

| Work group | Period | Work covered | Why it matters |
| --- | --- | --- | --- |
| S01: Core editing model | Initial work–2026-07-12 | Nested outline editing, parent-child behavior, keyboard indentation, splitting, completion and restoration, focus, due dates, progress, JSON import/export, and Japanese/English UI. | Established the product's central interaction model: keep the whole outline visible, then focus on one branch. |
| S02: Local-first migration | 2026-07-10–07-14 | Safe migration from browser storage to IndexedDB, storage adapter, validators, fixtures, multi-tab coordination, locks, service-worker behavior, and offline recovery. | Protected existing data while keeping core use independent of accounts and cloud services. |
| S03: Mobile interaction model | 2026-07-10–07-14 | Branch View, Outline View, row navigation, Quick Add, detail sheets, touch drag, and mobile menus. | Re-designed the information architecture for deep hierarchical tasks on small screens. |
| S04: OAuth and Drive synchronization | 2026-07-14 | OAuth exchange, secure sessions, refresh-token protection, Drive app-data transport, device state, push/pull, pending work, and retry backoff. | Made the user's own Drive the optional sync destination without placing task content in the service database. |
| S05: End-to-end encrypted synchronization | 2026-07-16 | Workspace data key, AES-256-GCM envelopes, associated-data validation, browser-side decryption and merge, and stricter content-security boundaries. | Kept the service in a transport role while making encryption and content processing browser-side responsibilities. |
| S06: Passkey recovery and device onboarding | 2026-07-17 | WebAuthn PRF/HKDF, recovery file and QR flows, P-256 ECDH, invitation secrets, existing-device approval, and setup wizard. | Created a recovery path that does not require a memorized passphrase. |
| S07: Sync failure and conflict safety | 2026-07-17–07-21 | Migration locks, expiry recovery, reset handling, conflict responses, realtime fallback, protection against overwriting in-flight edits, tombstones, empty remote state, account mismatch, and stale devices. | Addressed the highest-risk failure mode: silently losing a user's edit. |
| S08: Tutorial isolation | 2026-07-16–07-17 | An isolated guided tutorial with practice data separated from production storage, OAuth, synchronization, realtime behavior, Discord, and import/export. | Lets new users learn the product without risking real data. |
| S09: Realtime Cloudflare release | 2026-07-15 | Durable Object notification hub, content-free change notifications, deployment automation, bindings, and fallback behavior. | Improved multi-device freshness without putting task content in realtime messages. |
| S10: Release QA and submission preparation | 2026-07-17–07-21 | Agent workflow rules, CSP and XSS review, public policy pages, operations notes, secret checks, public-repository allowlisting, indexing files, and demo materials. | Extended Codex's role from implementation into security review, release operations, and submission evidence. |

## GPT-5.6 and Codex roles

- GPT-5.6 supported product framing, architecture comparisons, mobile information design, synchronization and recovery UX, and refinement of user-facing explanations.
- Codex translated those decisions into multi-file implementation, automated tests, Git iterations, real-browser checks, debugging, deployment validation, and demo evidence.
- The strongest examples are the encrypted synchronization, device onboarding, and conflict-safety phases, where design decisions, implementation, tests, and browser verification were iterated together.

## Evidence and Session ID handoff

For each phase, judges can inspect the corresponding design documents, source directories, tests, and demo materials listed in [codex-development-history.md](./codex-development-history.md). The S01–S10 labels are not substitutes for the required `/feedback` value.

Before submission, run `/feedback` in the primary Codex build thread—the thread containing most of the core implementation—and replace the placeholder in the submission form with that actual Session ID.

See the [OpenAI Build Week FAQ](https://openai.devpost.com/details/faqs) for the existing-project, Codex, GPT-5.6, and Session ID requirements.
