import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readDeployWorkflow() {
  for (const relativePath of [
    ".github/workflows/pages-deployment.yml",
    ".github/workflows/deploy.yml",
  ]) {
    const fullPath = path.join(root, relativePath);
    if (fs.existsSync(fullPath)) return fs.readFileSync(fullPath, "utf8");
  }
  throw new Error("No deploy workflow found (pages-deployment.yml or deploy.yml)");
}

test("public information pages are included in the static site", () => {
  for (const relativePath of [
    "404.html",
    "privacy/index.html",
    "terms/index.html",
    "contact/index.html",
    "data-and-sync/index.html",
    "site.css",
    "favicon.svg",
    "logo-mark.svg",
    "og-image.svg",
  ]) {
    assert.ok(fs.existsSync(path.join(root, relativePath)), `${relativePath} should exist`);
  }
});

test("the service worker cache includes the current public shell", () => {
  const serviceWorker = read("sw.js");
  assert.match(serviceWorker, /taskliner-shell-v33/);
  assert.match(serviceWorker, /new Request\(url, \{ cache: "reload" \}\)/);
  assert.match(serviceWorker, /new Request\(event\.request, \{ cache: "no-cache" \}\)/);
  assert.match(serviceWorker, /\.\/guided\.js/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /event\.request\.mode === "navigate"/);
  for (const asset of ["site.css", "favicon.svg", "logo-mark.svg", "privacy/", "terms/", "contact/", "data-and-sync/", "tutorial/", "src/model/outline-selectors.mjs", "src/model/outline-operations.mjs", "src/sync/content-snapshot.mjs", "src/sync/document-guard.mjs", "src/storage/integration-settings.mjs", "src/integrations/completion-outbox.mjs", "src/integrations/discord-webhook.mjs", "src/google/taskliner-e2ee-sync.mjs", "src/pairing/qr-code.mjs", "src/pairing/pairing-fragment.mjs", "vendor/flatpickr/flatpickr.min.css", "vendor/flatpickr/flatpickr.min.js", "vendor/flatpickr/l10n/ja.js"]) {
    assert.match(serviceWorker, new RegExp(`\\./${asset.replace("/", "\\/")}`));
  }
});

test("Google OAuth requests only account identity and Drive app data", () => {
  const login = read("functions/api/auth/login.js");
  assert.match(login, /openid email https:\/\/www\.googleapis\.com\/auth\/drive\.appdata/);
  assert.match(login, /Cache-Control.*no-store/);
  assert.doesNotMatch(login, /\bprofile\b/);
  assert.match(read("src/google/server-auth.mjs"), /cacheBust/);
});

test("mobile topbar menu uses the popup state that JavaScript toggles", () => {
  const styles = read("styles.css");
  assert.match(styles, /\.topbar-end > \.tool-pop\.is-open > \.topbar-actions\.tool-panel--topbar/);
});

test("first run starts with an editable empty outline and non-blocking practice link", () => {
  const html = read("index.html");
  const app = read("app.js");
  const styles = read("styles.css");
  assert.doesNotMatch(html, /id="welcome-dialog"/);
  assert.match(html, /class="starter-guide"/);
  assert.match(html, /id="btn-starter-dismiss"/);
  assert.match(html, /id="starter-dialog"/);
  assert.match(html, /starter\.dialog\.step1/);
  assert.match(html, /starter\.dialog\.start/);
  assert.match(html, /href="\.\/tutorial\/"/);
  assert.doesNotMatch(html, /id="starter-dialog"[\s\S]*href="\.\/tutorial\/"/);
  assert.match(app, /if \(!raw\) \{\s*return emptyDoc\(\);/);
  assert.doesNotMatch(app, /ONBOARDING_KEY/);
  assert.match(app, /STARTER_DISMISSED_KEY/);
  assert.match(app, /maybeOpenStarterDialog/);
  assert.match(app, /if \(!isMobileSheet\(\)\) return;/);
  assert.match(styles, /\.help-tutorial-bar \{\s*display: none;/);
  assert.match(app, /categoryMode: false/);
  assert.match(app, /ui: \{ \.\.\.defaultUi\(\), categoryMode: true \}/);
});

test("Discord setup reveals sharing options only after a valid webhook is connected", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /id="discord-options" class="discord-options" hidden/);
  assert.match(html, /discord\.setup\.summary/);
  assert.doesNotMatch(html, /discord\.privacy/);
  assert.match(html, /id="btn-discord"/);
  assert.match(html, /id="discord-dialog"/);
  assert.doesNotMatch(html, /settings-section discord-settings/);
  assert.match(app, /discordOptions\.hidden = !validateDiscordWebhookUrl\(settings\.webhookUrl\)/);
});

test("mobile editing has explicit add and close controls with touch-sized rows", () => {
  const html = read("index.html");
  const styles = read("styles.css");
  assert.match(html, /id="btn-mobile-add"/);
  assert.match(html, /id="btn-detail-close"/);
  assert.match(styles, /--mobile-row-line: 44px/);
  assert.match(styles, /\.detail-pane\.is-sheet-peek \.detail-due-row/);
});

test("mobile v2 has a dedicated branch surface, quick add, and explicit move UI", () => {
  const html = read("index.html");
  const app = read("app.js");
  const styles = read("styles.css");
  for (const id of [
    "mobile-active-surface",
    "mobile-screen-stack",
    "mobile-breadcrumbs",
    "mobile-active-list",
    "mobile-quick-add",
    "mobile-row-menu-dialog",
    "mobile-move-dialog",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /function renderMobileActive\(\{ transition = null \} = \{\}\)/);
  assert.match(app, /createOutlineNode\(doc/);
  assert.match(app, /moveOutlineNode\(doc/);
  assert.match(app, /function handleMobileV2Back\(\)/);
  assert.match(app, /window\.addEventListener\("popstate"/);
  assert.match(app, /mobile-reorder-handle/);
  assert.match(app, /mobile-row-edit-btn/);
  assert.match(app, /longPressTimer/);
  assert.doesNotMatch(app, /mobile-open-branch-btn/);
  assert.doesNotMatch(html, /<dialog id="mobile-row-menu-dialog"/);
  assert.match(html, /data-mobile-row-action="details"/);
  assert.match(html, /data-mobile-row-action="move"/);
  assert.match(html, /data-mobile-row-action="complete"/);
  assert.match(html, /data-mobile-row-action="delete"/);
  assert.doesNotMatch(html, /data-mobile-row-action="add-child"/);
  assert.doesNotMatch(html, /data-mobile-row-action="open"/);
  assert.doesNotMatch(html, /data-mobile-row-action="reorder"/);
  assert.match(html, /id="btn-mobile-due-sort"/);
  assert.match(html, /id="mobile-add-parent-bar"/);
  assert.match(html, /mobile-action-list--grid/);
  assert.match(app, /displayMode: "outline"/);
  assert.match(app, /function indentMobileNode\(/);
  assert.match(app, /function outdentMobileNode\(/);
  assert.match(app, /function animateMobileReorder\(/);
  assert.match(app, /openMobileAddParentPicker/);
  assert.match(app, /addParentPick/);
  assert.match(app, /focusMobileInlineInput/);
  assert.match(app, /is-mobile-v2-hidden/);
  assert.match(app, /mobile-archive-restore-btn/);
  assert.match(styles, /\.mobile-action-sheet\.is-open/);
  assert.match(styles, /#view-archive \.view-tools/);
  assert.match(styles, /\.mobile-action-list--grid/);
  assert.match(styles, /\.mobile-archive-restore-btn/);
  assert.match(styles, /background: var\(--pop-panel-bg, var\(--pop-surface\)\)/);
  assert.match(styles, /\.mobile-task-row \{[\s\S]*?min-height: 54px/);
  assert.match(styles, /\.mobile-reorder-handle[\s\S]*?width: 40px/);
  assert.match(styles, /--mobile-motion-branch: 260ms/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /\.mobile-action-sheet\s*\{/);
  assert.match(styles, /#active-desktop-surface \{\s*display: none;/);
  assert.match(styles, /\.desktop-surface \{\s*display: flex;\s*flex-direction: column;\s*flex: 1 1 auto;\s*min-height: 0;/);
  assert.match(styles, /\.outline \{\s*flex: 1 1 auto;\s*min-height: 0;\s*overflow: auto;/);
});

test("the deployment bundle includes every model module imported by the app", () => {
  const workflow = readDeployWorkflow();
  assert.match(workflow, /cp src\/model\/\*\.mjs dist\/src\/model\//);
});

test("dragging a child onto its parent keeps it nested at the top", () => {
  const app = read("app.js");
  assert.match(
    app,
    /if \(over\.id === drag\.parentId\) \{[\s\S]*?return \{ parentId: over\.id, index: 0, mode: "into", overId: over\.id \};/
  );
});

test("the header exposes a compact sync status", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /id="header-sync-status"/);
  assert.match(html, /id="header-sync-status-label"/);
  assert.match(html, /class="header-sync-status-label"/);
  assert.match(read("styles.css"), /@media \(max-width: 560px\)[\s\S]*\.header-sync-status-label \{\s*display: none;/);
  assert.match(app, /sync\.header\.synced/);
  assert.match(app, /sync\.header\.preparing/);
  assert.match(app, /sync\.header\.sending/);
  assert.match(app, /sync\.header\.receiving/);
  assert.match(app, /sync\.header\.checking/);
  assert.match(app, /sync\.header\.finishDevice/);
  assert.match(app, /headerSyncStatus\.hidden = !status\.authorized/);
  assert.match(app, /sync\.header\.degraded/);
  assert.match(app, /headerState = "actionRequired"/);
});

test("sync conflict checks compare the same full document shape", () => {
  const app = read("app.js");
  assert.match(app, /createSyncApplyGuard\(\{ storage, activeDoc: doc, expectedFullSnapshot: expectedSnapshot \}\)/);
  assert.match(app, /activeProjectionIsCurrent\(guard\.activeSnapshot, doc\)/);
  assert.match(app, /if \(!status\.localDirty\) return true/);
  assert.match(app, /remote_data_missing/);
  assert.match(app, /else syncScheduler\.clearLocalChanges\(\)/);
  assert.match(app, /syncOperations\.run\(\(\) => driveSync\.syncNow\(options\)\)/);
});

test("realtime failures reconnect and completed notes remain immutable", () => {
  const app = read("app.js");
  assert.match(app, /if \(realtimeNeedsCatchup && !foregroundSyncInProgress\)/);
  assert.match(app, /realtimeNeedsCatchup = false;\s*void syncOnForeground\(\)/);
  assert.match(app, /updateSyncUi\(error\);\s*realtimeNeedsCatchup = true/);
  assert.match(app, /driveSync\.disconnectRealtime\(\);\s*scheduleRealtimeReconnect\(\)/);
  assert.match(app, /el\.detailNote\.disabled = isCompleted\(n\)/);
  assert.match(app, /if \(!n \|\| isCompleted\(n\)\) return/);
});

test("startup waits for local storage repair before restoring sync", () => {
  const app = read("app.js");
  assert.match(app, /const startupHydration = hydratePersistedDoc\(\)\.catch/);
  assert.match(app, /startupHydration\.then\(\(\) => restoreGoogleConnection\(\)\)/);
});

test("tutorial uses the production app in a disposable guided mode", () => {
  const html = read("tutorial/index.html");
  const appHtml = read("index.html");
  const workflow = readDeployWorkflow();
  const app = read("app.js");
  const guided = read("guided.js");
  assert.match(workflow, /cp index\.html dist\/tutorial\/index\.html/);
  assert.doesNotMatch(html, /location\.replace|Taskliner チュートリアルを開く/);
  assert.match(read("index.html"), /<base href="\/" \/>/);
  assert.match(app, /wantsGuidedTutorialFromUrl/);
  assert.match(app, /GUIDED_STORAGE_KEY/);
  assert.match(app, /GUIDED_DB_NAME/);
  assert.match(app, /dbName: guidedTutorialLocation \? GUIDED_DB_NAME : MAIN_DB_NAME/);
  assert.match(app, /location\.pathname/);
  assert.match(app, /skipPersist = true/);
  assert.match(guided, /Enter/);
  assert.match(guided, /Shift\+Tab/);
  assert.match(guided, /ドラッグハンドル/);
  assert.match(guided, /一覧から消え/);
  assert.match(guided, /setBackdropVisible/);
  assert.match(guided, /guided-celebration/);
  assert.match(guided, /tutorialPathMode/);
  assert.match(appHtml, /id="guided-data-dialog"/);
  assert.match(appHtml, /Tasklinerを完璧に理解されましたね/);
});

test("file dialog explains JSON and orders import before export", () => {
  const html = read("index.html");
  assert.match(html, /file\.description/);
  assert.ok(html.indexOf('id="btn-import"') < html.indexOf('id="btn-export"'));
});

test("deployment packages the v3 browser assets and configures production services", () => {
  const workflow = readDeployWorkflow();
  for (const asset of ["bootstrap.js", "tutorial/index.html", "src/pairing/*.mjs"]) {
    assert.match(workflow, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(workflow, /env_vars\?\.TASKLINER_SYNC_V3\?\.value/);
  assert.match(workflow, /flag !== 'enabled'/);
  assert.doesNotMatch(workflow, /\.\.\.\(production\.env_vars/);
  assert.match(workflow, /without modifying variables or secrets/);
  assert.match(read("functions/_lib/sync.mjs"), /PRAGMA table_info\(taskliner_users\)/);
  assert.match(read("functions/api/sync.js"), /await ensureSyncV3Schema\(context\.env\)/);
  assert.match(workflow, /workers\/durable_objects\/namespaces/);
  assert.match(workflow, /method: 'PATCH'/);
  assert.match(workflow, /SYNC_ROOM: \{ namespace_id: namespace\.id \}/);
  assert.match(workflow, /SYNC_ROOM production binding verification failed/);
  assert.doesNotMatch(workflow, /pages download config/);
});

test("current public copy describes end-to-end encrypted Drive sync", () => {
  const dataPage = read("data-and-sync/index.html");
  const privacyPage = read("privacy/index.html");
  assert.match(dataPage, /Google Drive sync/);
  assert.match(dataPage, /drive\.appdata/);
  assert.match(dataPage, /Cloudflare Pages Functions/);
  assert.match(dataPage, /No passphrase is required/);
  assert.match(dataPage, /AES-256-GCM/);
  assert.match(dataPage, /cannot be recovered/);
  assert.match(privacyPage, /Google’s authorization endpoint/);
  assert.match(privacyPage, /encrypted refresh token/);
  assert.match(privacyPage, /end-to-end encryption protects synchronized data/i);
  assert.doesNotMatch(privacyPage, /not end-to-end encryption/i);
  assert.doesNotMatch(dataPage, /not implemented yet/);
});

test("the app exposes policy and support links", () => {
  const index = read("index.html");
  const contact = read("contact/index.html");
  assert.match(index, /id="btn-about"/);
  assert.match(index, /id="about-dialog"/);
  assert.match(index, /href="\.\/privacy\//);
  assert.match(index, /href="\.\/terms\//);
  assert.match(index, /href="\.\/contact\//);
  assert.match(index, /href="\.\/data-and-sync\//);
  assert.doesNotMatch(index, /mailto:bloomlateral@gmail\.com/);
  assert.match(contact, /mailto:bloomlateral@gmail\.com/);
  assert.match(index, /property="og:title"/);
  assert.match(index, /href="\.\/favicon\.svg"/);
  assert.match(index, /class="brand-logo"/);
  assert.match(index, /aria-label="Taskliner home"/);
});

test("deployment packages the header logo mark", () => {
  const workflow = readDeployWorkflow();
  const styles = read("styles.css");
  assert.match(workflow, /logo-mark\.svg/);
  assert.match(styles, /\.brand-logo/);
  assert.match(styles, /mask: url\("\.\/logo-mark\.svg"\)/);
});

test("production E2EE is enabled without weakening script CSP", () => {
  const html = read("index.html");
  const app = read("app.js");
  const pairingFragment = read("src/pairing/pairing-fragment.mjs");
  const headers = read("_headers");
  assert.match(html, /id="sync-overview"/);
  assert.match(html, /id="btn-sync-primary"/);
  assert.match(html, /id="device-link-dialog"/);
  assert.match(html, /id="btn-device-link-passkey"/);
  assert.match(html, /id="btn-device-link-existing"/);
  assert.match(html, /id="recovery-dialog"/);
  assert.match(html, /meta name="taskliner-sync-v3" content="enabled"/);
  assert.match(html, /id="btn-sync-delete-remote"/);
  assert.match(html, /<script src="\.\/bootstrap\.js"><\/script>/);
  assert.doesNotMatch(headers, /script-src[^;]*'unsafe-inline'/);
  assert.match(pairingFragment, /historyObj\.replaceState\(historyObj\.state, "", clean\)/);
  assert.doesNotMatch(read("src/google/server-auth.mjs"), /locationObj\.hash/);
  assert.match(app, /pendingPairingFragment && autoStart/);
  assert.match(app, /void requestExistingDeviceApproval\(\)/);
  assert.match(app, /setDeviceLinkPhase\("waiting"\)/);
  assert.doesNotMatch(html, /id="e2ee-panel"/);
  assert.doesNotMatch(html, /id="btn-e2ee-passkey"/);
  assert.match(app, /error instanceof E2eeSetupRequiredError\) await setupEncryptedSync\(\)/);
  assert.match(app, /migrationLockExpiresAt > Date\.now\(\)/);
  assert.match(app, /\["legacy", "migrating"\]\.includes\(setupStatus\.e2eeStatus\)/);
  assert.match(app, /Keep archive placeholders while repairing all active parent\/child links/);
  assert.match(app, /const repairedDoc = migrateDoc\(storedDoc\)/);
});

test("device linking is a guided OAuth-to-approval flow instead of an error state", () => {
  const html = read("index.html");
  const app = read("app.js");
  const styles = read("styles.css");
  const protocol = read("src/pairing/pairing-protocol-v1.mjs");
  assert.match(html, /data-device-link-step="account"/);
  assert.match(html, /data-device-link-step="verify"/);
  assert.match(html, /data-device-link-step="sync"/);
  assert.match(html, /id="device-link-confirm"/);
  assert.match(html, /id="device-link-busy"/);
  assert.match(html, /id="btn-device-link-use-local"/);
  assert.match(html, /id="pairing-invite"/);
  assert.match(html, /id="pairing-request"/);
  assert.match(html, /id="pairing-complete"/);
  assert.match(html, /id="pairing-busy"/);
  assert.match(app, /expectedLock \? "sync\.header\.finishDevice"/);
  assert.match(app, /renderSyncOverview\(\{ status, schedulerStatus/);
  assert.match(app, /deviceLinkRequired && deviceLinkPhase !== "complete" && !force/);
  assert.match(app, /else if \(error instanceof E2eeSyncLockedError\)[\s\S]*openDeviceLinkDialog\(\)/);
  assert.match(app, /url\.searchParams\.set\("pairing", inviterPairing\.offer\.offerId\)/);
  assert.match(app, /window\.addEventListener\("hashchange", capturePairingInviteFromLocation\)/);
  assert.match(app, /window\.addEventListener\("pageshow", capturePairingInviteFromLocation\)/);
  assert.match(app, /window\.addEventListener\("focus", capturePairingInviteFromLocation\)/);
  assert.match(app, /setPairingPhase\("preparing"\)[\s\S]*openAppDialog\(el\.pairingDialog\)/);
  assert.match(app, /inviterPairing\.responseArtifactId = result\.response\.responseId[\s\S]*pollPairingCompletion\(\)/);
  assert.match(app, /function pollPairingCompletion\(\)[\s\S]*setPairingPhase\("complete"\)/);
  assert.match(app, /setDeviceLinkPhase\("syncing"\)[\s\S]*resolve\?\.\(true\)/);
  assert.match(app, /await syncDriveNow\(\{ interactive: false \}\)[\s\S]*await driveSync\.deleteArtifact\("pairing-response", entry\.artifactId\)/);
  assert.match(app, /body\.scrollTop = 0/);
  assert.match(protocol, /confirmationCodePart/);
  assert.doesNotMatch(protocol, /あさ|ひつじ/);
  assert.match(styles, /data-state="actionRequired"/);
  assert.match(styles, /\.device-link-steps/);
  assert.match(styles, /\.pairing-spinner/);
  assert.match(styles, /\.pairing-phase-panel\[hidden\]/);
  assert.match(styles, /\.device-link-choices\[hidden\][\s\S]*display: none/);
});

test("Discord settings use the encrypted shared-setting channel only in sync v3", () => {
  const app = read("app.js");
  assert.match(app, /driveSync\.pushSharedSetting\(value\)/);
  assert.match(app, /syncDiscordSettingToDrive\(null\)/);
  assert.match(app, /shouldDiscardDiscordOutbox/);
  assert.doesNotMatch(app, /api\/integrations\/discord/);
});
