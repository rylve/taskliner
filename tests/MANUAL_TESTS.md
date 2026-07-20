# Manual tests

Automated coverage:

```bash
node --test tests/*.test.mjs
node --check app.js
```

Use these checks for browser behavior that unit tests do not fully cover.

## Stage 0: legacy data safety

1. In DevTools Application storage, delete the `taskliner-local-first` IndexedDB database, then create `localStorage["taskliner-v1"]` from `tests/fixtures/taskliner-v1.json`.
2. Reload. Confirm the fixture tasks and parent/child relationship are present.
3. Confirm the original `taskliner-v1` value remains after editing and reloading.
4. Replace `taskliner-v1` with invalid JSON, reload, and confirm the app opens a blank document without deleting the invalid raw value.
5. Restore the fixture, edit a task, export JSON, import that export, and confirm titles, notes, due dates, completion state, and tree shape match.

## Stage 1: IndexedDB and multi-tab behavior

1. With data loaded, reload and confirm `taskliner-local-first` appears in IndexedDB with a `documents/current` record.
2. Close the tab during an edit, reopen, and confirm the edit remains.
3. Open two tabs, edit a title in one, and confirm the other updates after saving.
4. After the Service Worker has installed once, enable Offline in DevTools Network, reload, and confirm the shell opens.
5. Go back online, edit again, and confirm the value persists after reload.

## Stage 2: core outline UX

1. Add several rows; indent with Tab and outdent with Shift+Tab.
2. Press Enter at end / middle / start of a title and confirm add / split / insert-above behavior.
3. Complete with hover control and with Ctrl+Enter; confirm Undo toast and Archive placement.
4. Focus with Ctrl+.; step back with Esc and breadcrumbs.
5. Set a due date; toggle due-date sorting.
6. Paste a multi-line Markdown bullet list and confirm it becomes a tree.
7. On a narrow viewport, exercise branch/outline navigation, Quick Add, inline title edit, details, move, and reorder.

## Stage 3: optional sync (official or self-hosted with Functions)

Use a dedicated test Google account.

1. Connect Google and confirm sync can start when passkey PRF or recovery setup succeeds.
2. Reload and confirm automatic sync without unexpected prompts on a registered device.
3. Add a second device via passkey unlock, existing-device approval, or recovery file.
4. Confirm pairing secrets stay in URL fragments only and are cleared from the address bar after capture.
5. Change Discord settings on one device (if used) and confirm encrypted propagation without putting Webhook URLs into JSON export.
6. Inspect network traffic at a high level and confirm task titles are not visible as plaintext in Drive upload bodies outside ciphertext fields.

Do not paste real personal task content, exports, tokens, or Webhook URLs into public bug reports.
