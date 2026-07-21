import { initI18n, t, getLocale, getLocaleTag, setLocale } from "./i18n.js";
import { repairTreeLinks, validateTree } from "./src/model/validate-tree.mjs";
import {
  activeChildrenOf as activeOutlineChildrenOf,
  ancestorChain as outlineAncestorChain,
  canIndentNode as canIndentOutlineNode,
  canMoveNode as canMoveOutlineNode,
  canOutdentNode as canOutdentOutlineNode,
  canReorderNode as canReorderOutlineNode,
  siblingList as outlineSiblingList,
} from "./src/model/outline-selectors.mjs";
import {
  createNode as createOutlineNode,
  indentUnderPreviousSibling,
  moveNode as moveOutlineNode,
  outdentPreservingOutline,
  renameNode as renameOutlineNode,
  reorderNode as reorderOutlineNode,
  reorderNodeByDelta,
} from "./src/model/outline-operations.mjs";
import { createStorageAdapter, splitDocument, SPLIT_FORMAT } from "./src/storage/storage-adapter.mjs";
import { createGoogleServerAuth, ServerAuthUnavailableError } from "./src/google/server-auth.mjs";
import {
  createTasklinerServerSync,
  ServerSyncAccountMismatchError,
  ServerSyncAuthorizationRequiredError,
  ServerSyncUnavailableError,
} from "./src/google/taskliner-server-sync.mjs";
import {
  createTasklinerE2eeSync,
  E2eeAccountMismatchError,
  E2eeMigrationLockedError,
  E2eeSetupRequiredError,
  E2eeSyncLockedError,
} from "./src/google/taskliner-e2ee-sync.mjs";
import { isSyncV3Enabled } from "./src/google/sync-v3-feature.mjs";
import { createTasklinerPasskey, getTasklinerPasskeyPrf } from "./src/crypto/browser-passkey.mjs";
import {
  createPasskeyKeyWrapper,
  createRecoveryFile,
  createRecoveryKeyWrapper,
  generateRecoveryKey,
  parseRecoveryFile,
  unwrapPasskeyKeyWrapper,
  unwrapRecoveryKeyWrapper,
} from "./src/crypto/key-wrappers-v1.mjs";
import {
  acceptPairingResponse,
  approvePairingRequest,
  createPairingOffer,
  createPairingRequest,
  inspectPairingRequest,
  PairingUseRegistry,
  parsePairingQrFragment,
} from "./src/pairing/pairing-protocol-v1.mjs";
import { capturePairingFragment, PAIRING_FRAGMENT_SESSION_KEY } from "./src/pairing/pairing-fragment.mjs";
import { encodeQrSvg } from "./src/pairing/qr-code.mjs";
import { base64urlDecode } from "./src/crypto/e2ee-utils.mjs";
import { createSyncOperationQueue, createSyncScheduler } from "./src/sync/scheduler.mjs";
import { createSyncContentSnapshot } from "./src/sync/content-snapshot.mjs";
import { activeProjectionIsCurrent, createSyncApplyGuard } from "./src/sync/document-guard.mjs";
import { createIntegrationSettingsStore, normalizeDiscordSettings } from "./src/storage/integration-settings.mjs";
import { createCompletionOutbox } from "./src/integrations/completion-outbox.mjs";
import { shouldDiscardDiscordOutbox } from "./src/integrations/discord-sync-policy.mjs";
import {
  maskDiscordWebhookUrl,
  testDiscordWebhook,
  validateDiscordWebhookUrl,
} from "./src/integrations/discord-webhook.mjs";

let pendingPairingFragment = capturePairingFragment();

initI18n();

const STORAGE_KEY = "taskliner-v1";
const GUIDED_STORAGE_KEY = "taskliner-guided-v1";
const MAIN_DB_NAME = "taskliner-local-first";
const GUIDED_DB_NAME = "taskliner-guided-local-first";
const SCHEMA_VERSION = 3;
const guidedTutorialLocation = (() => {
  try {
    return new URLSearchParams(location.search).has("guided") || /\/tutorial\/?$/.test(location.pathname);
  } catch {
    return false;
  }
})();
const storage = createStorageAdapter({
  key: guidedTutorialLocation ? GUIDED_STORAGE_KEY : STORAGE_KEY,
  dbName: guidedTutorialLocation ? GUIDED_DB_NAME : MAIN_DB_NAME,
});
const googleAuth = createGoogleServerAuth();
const syncV3Enabled = isSyncV3Enabled();
const integrationSettings = createIntegrationSettingsStore({ storage });
const completionOutbox = createCompletionOutbox({ storage, settingsStore: integrationSettings });
let syncUiPhase = null;
let realtimeEnabled = false;
let realtimeReconnectTimer = null;
let realtimeReconnectAttempt = 0;
let realtimeNeedsCatchup = false;
let foregroundSyncPromise = null;
let foregroundSyncInProgress = false;
const pairingRegistry = new PairingUseRegistry();
let inviterPairing = null;
let requesterPairing = null;
let pairingPollTimer = null;
let pairingPollRetryCount = 0;
let pairingPhase = "idle";
let deviceLinkConfirmResolver = null;
let deviceLinkPhase = "idle";
let deviceLinkRequired = false;
let pendingRecoveryFile = null;
let recoveryDialogResolver = null;
let recoveryExported = false;
let syncEncryptionExplainerShown = false;
let detailDuePicker = null;

/** @typedef {{
 *  id: string,
 *  title: string,
 *  parentId: string | null,
 *  childIds: string[],
 *  collapsed: boolean,
 *  createdAt: number,
 *  completedAt: number | null,
 *  dueAt: number | null,
 *  note: string,
 *  completedChildCount?: number
 * }} Node */

/** @typedef {{
 *  schemaVersion: number,
 *  nodes: Record<string, Node>,
 *  rootIds: string[],
 *  selectedId: string | null,
 *  ui: {
 *    tab: 'active' | 'archive',
 *    theme: 'easygoing' | 'retro-pop' | 'formal' | 'geek' | 'calm',
 *    activeQuery: string,
 *    activeSort: 'outline' | 'due-asc',
 *    progressMode: 'off' | 'all',
 *    categoryMode: boolean,
 *    dueKeepTree: boolean,
 *    dueShowUndated: boolean,
 *    titleWrap: boolean,
 *    plainTextMode: boolean,
 *    zoomId: string | null,
 *    archiveQuery: string,
 *    archiveSort: string,
 *    archivePeriod: 'all' | 'today' | 'week' | 'month' | 'custom',
 *    archiveFrom: string,
 *    archiveTo: string
 *  }
 * }} Doc */

const HISTORY_LIMIT = 80;
const STARTER_DISMISSED_KEY = "taskliner-starter-dismissed";
const STARTER_DIALOG_SEEN_KEY = "taskliner-starter-dialog-seen";

const el = {
  tabs: [...document.querySelectorAll(".tab")],
  viewActive: document.getElementById("view-active"),
  viewArchive: document.getElementById("view-archive"),
  activeDesktopSurface: document.getElementById("active-desktop-surface"),
  activeOutline: document.getElementById("active-outline"),
  mobileActiveSurface: document.getElementById("mobile-active-surface"),
  mobileCurrentHeading: document.getElementById("mobile-current-heading"),
  mobileBreadcrumbs: document.getElementById("mobile-breadcrumbs"),
  mobileScreenStack: document.getElementById("mobile-screen-stack"),
  mobileActiveList: document.getElementById("mobile-active-list"),
  btnMobileBack: document.getElementById("btn-mobile-back"),
  btnMobileDisplayMode: document.getElementById("btn-mobile-display-mode"),
  btnMobileDueSort: document.getElementById("btn-mobile-due-sort"),
  btnMobileSearch: document.getElementById("btn-mobile-search"),
  mobileSearchBar: document.getElementById("mobile-search-bar"),
  mobileSearchQuery: document.getElementById("mobile-search-query"),
  btnMobileSearchClose: document.getElementById("btn-mobile-search-close"),
  btnMobileReorder: document.getElementById("btn-mobile-reorder"),
  mobileReorderHeader: document.getElementById("mobile-reorder-header"),
  btnMobileReorderDone: document.getElementById("btn-mobile-reorder-done"),
  btnMobileV2Add: document.getElementById("btn-mobile-v2-add"),
  mobileQuickAdd: document.getElementById("mobile-quick-add"),
  mobileQuickAddInput: document.getElementById("mobile-quick-add-input"),
  mobileAddUnder: document.getElementById("mobile-add-under"),
  btnMobileQuickAddClose: document.getElementById("btn-mobile-quick-add-close"),
  mobileAddParentBar: document.getElementById("mobile-add-parent-bar"),
  btnMobileAddParentRoot: document.getElementById("btn-mobile-add-parent-root"),
  btnMobileAddParentCancel: document.getElementById("btn-mobile-add-parent-cancel"),
  mobileRowMenuDialog: document.getElementById("mobile-row-menu-dialog"),
  mobileRowMenuBackdrop: document.getElementById("mobile-row-menu-backdrop"),
  mobileRowMenuTitle: document.getElementById("mobile-row-menu-title"),
  btnMobileRowMenuClose: document.getElementById("btn-mobile-row-menu-close"),
  mobileMoveDialog: document.getElementById("mobile-move-dialog"),
  mobileMoveTitle: document.getElementById("mobile-move-title"),
  mobileMoveSearch: document.getElementById("mobile-move-search"),
  mobileMoveList: document.getElementById("mobile-move-list"),
  btnMobileMoveClose: document.getElementById("btn-mobile-move-close"),
  archiveOutline: document.getElementById("archive-outline"),
  btnExport: document.getElementById("btn-export"),
  btnImport: document.getElementById("btn-import"),
  btnOpenTutorial: document.getElementById("btn-open-tutorial"),
  starterGuide: document.querySelector(".starter-guide"),
  btnStarterDismiss: document.getElementById("btn-starter-dismiss"),
  starterDialog: document.getElementById("starter-dialog"),
  btnStarterDialogClose: document.getElementById("btn-starter-dialog-close"),
  btnStarterDialogLater: document.getElementById("btn-starter-dialog-later"),
  btnFileMenu: document.getElementById("btn-file-menu"),
  btnFileClose: document.getElementById("btn-file-close"),
  fileDialog: document.getElementById("file-dialog"),
  btnTheme: document.getElementById("btn-theme"),
  btnThemeClose: document.getElementById("btn-theme-close"),
  themeDialog: document.getElementById("theme-dialog"),
  themeOptions: [...document.querySelectorAll(".theme-option")],
  btnTopbarMenu: document.getElementById("btn-topbar-menu"),
  topbarMenuPanel: document.getElementById("topbar-menu-panel"),
  btnAbout: document.getElementById("btn-about"),
  btnAboutClose: document.getElementById("btn-about-close"),
  aboutDialog: document.getElementById("about-dialog"),
  btnLangMenu: document.getElementById("btn-lang-menu"),
  langMenuPanel: document.getElementById("lang-menu-panel"),
  btnAccount: document.getElementById("btn-account"),
  accountDialog: document.getElementById("account-dialog"),
  syncEncryptionExplainer: document.getElementById("sync-encryption-explainer"),
  btnSyncEncryptionExplainerClose: document.getElementById("btn-sync-encryption-explainer-close"),
  btnSyncEncryptionExplainerCancel: document.getElementById("btn-sync-encryption-explainer-cancel"),
  btnSyncEncryptionExplainerAccept: document.getElementById("btn-sync-encryption-explainer-accept"),
  btnAccountClose: document.getElementById("btn-account-close"),
  btnSyncPrimary: document.getElementById("btn-sync-primary"),
  syncOverview: document.getElementById("sync-overview"),
  syncOverviewKicker: document.getElementById("sync-overview-kicker"),
  syncOverviewTitle: document.getElementById("sync-overview-title"),
  syncOverviewDescription: document.getElementById("sync-overview-description"),
  syncManageDetails: document.getElementById("sync-manage-details"),
  btnSyncManageAddDevice: document.getElementById("btn-sync-manage-add-device"),
  btnSyncManageRecovery: document.getElementById("btn-sync-manage-recovery"),
  btnSyncManageNow: document.getElementById("btn-sync-manage-now"),
  btnSyncDeleteRemote: document.getElementById("btn-sync-delete-remote"),
  btnSyncDisconnect: document.getElementById("btn-sync-disconnect"),
  syncStatus: document.getElementById("sync-status"),
  deviceLinkDialog: document.getElementById("device-link-dialog"),
  btnDeviceLinkClose: document.getElementById("btn-device-link-close"),
  deviceLinkSteps: document.getElementById("device-link-steps"),
  deviceLinkKicker: document.getElementById("device-link-kicker"),
  deviceLinkStageTitle: document.getElementById("device-link-stage-title"),
  deviceLinkDescription: document.getElementById("device-link-description"),
  deviceLinkBusy: document.getElementById("device-link-busy"),
  deviceLinkBusyText: document.getElementById("device-link-busy-text"),
  deviceLinkStatus: document.getElementById("device-link-status"),
  deviceLinkChoices: document.getElementById("device-link-choices"),
  btnDeviceLinkPasskey: document.getElementById("btn-device-link-passkey"),
  btnDeviceLinkExisting: document.getElementById("btn-device-link-existing"),
  btnDeviceLinkRecoveryFile: document.getElementById("btn-device-link-recovery-file"),
  btnDeviceLinkRecoveryCode: document.getElementById("btn-device-link-recovery-code"),
  deviceLinkCodeForm: document.getElementById("device-link-code-form"),
  deviceLinkInviteCode: document.getElementById("device-link-invite-code"),
  btnDeviceLinkRequest: document.getElementById("btn-device-link-request"),
  deviceLinkConfirm: document.getElementById("device-link-confirm"),
  deviceLinkWords: document.getElementById("device-link-words"),
  btnDeviceLinkConfirm: document.getElementById("btn-device-link-confirm"),
  btnDeviceLinkReject: document.getElementById("btn-device-link-reject"),
  btnDeviceLinkPrimary: document.getElementById("btn-device-link-primary"),
  btnDeviceLinkUseLocal: document.getElementById("btn-device-link-use-local"),
  deviceLinkRecoveryInput: document.getElementById("device-link-recovery-input"),
  pairingDialog: document.getElementById("pairing-dialog"),
  btnPairingClose: document.getElementById("btn-pairing-close"),
  pairingSteps: document.getElementById("pairing-steps"),
  pairingBusy: document.getElementById("pairing-busy"),
  pairingBusyText: document.getElementById("pairing-busy-text"),
  pairingInvite: document.getElementById("pairing-invite"),
  pairingQr: document.getElementById("pairing-qr"),
  pairingCode: document.getElementById("pairing-code"),
  pairingStatus: document.getElementById("pairing-status"),
  pairingRequest: document.getElementById("pairing-request"),
  pairingDeviceName: document.getElementById("pairing-device-name"),
  pairingReviewDescription: document.getElementById("pairing-review-description"),
  pairingReviewActions: document.getElementById("pairing-review-actions"),
  pairingWords: document.getElementById("pairing-words"),
  btnPairingApprove: document.getElementById("btn-pairing-approve"),
  btnPairingCancel: document.getElementById("btn-pairing-cancel"),
  pairingComplete: document.getElementById("pairing-complete"),
  btnPairingDone: document.getElementById("btn-pairing-done"),
  recoveryDialog: document.getElementById("recovery-dialog"),
  btnRecoveryClose: document.getElementById("btn-recovery-close"),
  recoveryQr: document.getElementById("recovery-qr"),
  recoveryCopyValue: document.getElementById("recovery-copy-value"),
  btnRecoveryDownload: document.getElementById("btn-recovery-download"),
  btnRecoveryCopy: document.getElementById("btn-recovery-copy"),
  btnRecoverySaved: document.getElementById("btn-recovery-saved"),
  recoveryStatus: document.getElementById("recovery-status"),
  headerSyncStatus: document.getElementById("header-sync-status"),
  headerSyncLabel: document.getElementById("header-sync-status-label"),
  btnDiscord: document.getElementById("btn-discord"),
  btnDiscordClose: document.getElementById("btn-discord-close"),
  discordDialog: document.getElementById("discord-dialog"),
  btnHelp: document.getElementById("btn-help"),
  btnHelpClose: document.getElementById("btn-help-close"),
  helpDialog: document.getElementById("help-dialog"),
  btnCategoryHelp: document.getElementById("btn-category-help"),
  btnCategoryHelpClose: document.getElementById("btn-category-help-close"),
  categoryHelpDialog: document.getElementById("category-help-dialog"),
  zoomBar: document.getElementById("zoom-bar"),
  zoomCrumbs: document.getElementById("zoom-crumbs"),
  btnZoomOut: document.getElementById("btn-zoom-out"),
  activeQuery: document.getElementById("active-query"),
  activeToolHint: document.getElementById("active-tool-hint"),
  btnActiveSearch: document.getElementById("btn-active-search"),
  btnActiveDueSort: document.getElementById("btn-active-due-sort"),
  btnActivePlainText: document.getElementById("btn-active-plain-text"),
  btnSettingsMenu: document.getElementById("btn-settings-menu"),
  settingsMenuPanel: document.getElementById("settings-menu-panel"),
  progressModeSelect: document.getElementById("progress-mode-select"),
  categoryMode: document.getElementById("category-mode"),
  dueKeepTree: document.getElementById("due-keep-tree"),
  dueShowUndated: document.getElementById("due-show-undated"),
  titleWrap: document.getElementById("title-wrap"),
  discordOptions: document.getElementById("discord-options"),
  discordEnabled: document.getElementById("discord-enabled"),
  discordWebhookUrl: document.getElementById("discord-webhook-url"),
  discordTest: document.getElementById("discord-test"),
  discordStatus: document.getElementById("discord-status"),
  discordVisibility: document.getElementById("discord-visibility"),
  discordDisplayName: document.getElementById("discord-display-name"),
  discordAutomatic: document.getElementById("discord-automatic"),
  discordCounts: document.getElementById("discord-counts"),
  discordRetry: document.getElementById("discord-retry"),
  discordDisconnect: document.getElementById("discord-disconnect"),
  archiveQuery: document.getElementById("archive-query"),
  archiveClearFilters: document.getElementById("archive-clear-filters"),
  archiveCount: document.getElementById("archive-count"),
  archiveToolHint: document.getElementById("archive-tool-hint"),
  btnArchiveSearch: document.getElementById("btn-archive-search"),
  btnArchiveFilter: document.getElementById("btn-archive-filter"),
  archiveFilterPanel: document.getElementById("archive-filter-panel"),
  archivePeriodChips: [...document.querySelectorAll("#archive-period .filter-chip")],
  archiveSortChips: [...document.querySelectorAll("#archive-sort-chips .filter-chip")],
  archiveRangePanel: document.getElementById("archive-range-panel"),
  archiveFrom: document.getElementById("archive-from"),
  archiveTo: document.getElementById("archive-to"),
  archiveLoadMore: document.getElementById("archive-load-more"),
  detailEmpty: document.getElementById("detail-empty"),
  detailBody: document.getElementById("detail-body"),
  detailPane: document.querySelector(".detail-pane"),
  detailSheetHandle: document.getElementById("detail-sheet-handle"),
  detailSheetBackdrop: document.getElementById("detail-sheet-backdrop"),
  btnDetailClose: document.getElementById("btn-detail-close"),
  detailTitle: document.getElementById("detail-title"),
  detailCategory: document.getElementById("detail-category"),
  detailMeta: document.getElementById("detail-meta"),
  detailDue: document.getElementById("detail-due"),
  detailDueClear: document.getElementById("detail-due-clear"),
  detailNote: document.getElementById("detail-note"),
  mobileMoveActions: document.getElementById("mobile-move-actions"),
  btnOutdent: document.getElementById("btn-outdent"),
  btnIndent: document.getElementById("btn-indent"),
  btnMoveUp: document.getElementById("btn-move-up"),
  btnMoveDown: document.getElementById("btn-move-down"),
  btnToggleDone: document.getElementById("btn-toggle-done"),
  btnZoomIn: document.getElementById("btn-zoom-in"),
  btnDelete: document.getElementById("btn-delete"),
  btnMobileAdd: document.getElementById("btn-mobile-add"),
  toastHost: document.getElementById("toast-host"),
};

const driveSync = (syncV3Enabled ? createTasklinerE2eeSync : createTasklinerServerSync)({
  auth: googleAuth,
  storage,
  getDocument: () => storage.exportDocument(doc),
  applyDocument: applySyncedDocument,
  applySharedSetting: applyEncryptedDiscordSetting,
  validateSharedSetting: validateEncryptedDiscordSetting,
});

const syncOperations = createSyncOperationQueue();
const syncScheduler = createSyncScheduler({
  onPush: async () => {
    syncUiPhase = "sending";
    updateSyncUi();
    try {
      const result = await syncOperations.run(() => driveSync.push({ interactive: false }));
      const status = driveSync.getStatus();
      if (!status.localDirty) return true;
      return ["sync_paused", "sync_paused_after_delete", "remote_data_missing"].includes(result?.reason);
    } finally {
      syncUiPhase = null;
      updateSyncUi();
    }
  },
  onPull: async () => {
    syncUiPhase = "checking";
    updateSyncUi();
    try {
      await syncOperations.run(() => driveSync.pull({ interactive: false }));
    } finally {
      syncUiPhase = null;
      updateSyncUi();
    }
  },
  onError: (error) => {
    if (error instanceof ServerSyncAuthorizationRequiredError || error instanceof ServerSyncUnavailableError) return;
    updateSyncUi(error);
  },
});

async function syncDriveNow(options) {
  const result = await syncOperations.run(() => driveSync.syncNow(options));
  if (driveSync.getStatus().localDirty) syncScheduler.noteLocalChange();
  else syncScheduler.clearLocalChanges();
  return result;
}

/** @type {Doc} */
let doc;
/** @type {string[]} */
let rangeIds = [];
let rangeAnchorId = null;
/** @type {{ kind: string, payload: any, el: HTMLElement, timer: number } | null} */
let actionToast = null;
let suppressRowClickUntil = 0;
/** @type {Set<string>} */
const animatingIds = new Set();
/** @type {Set<string>} */
let pendingEnterIds = new Set();
/** @type {Set<string>} */
let pendingExpandEnterIds = new Set();

/** @type {'closed' | 'peek' | 'expanded'} */
let sheetLevel = "closed";
const MOBILE_SHEET_MQ = "(max-width: 900px)";
const mobileUi = {
  navRootId: null,
  displayMode: "outline",
  detailsOpen: false,
  inlineEditor: null,
  quickAdd: { open: false, parentId: null, draft: "" },
  reorderMode: false,
  addParentPick: false,
  rowMenuId: null,
  movePicker: null,
  detailOriginId: null,
  detailSheetAnim: null,
  transitioning: false,
};
const MOBILE_HISTORY_STATE_KEY = "__tasklinerMobileUi";
let mobileTransitionToken = 0;

function replaceMobileHistoryState({ transient = false } = {}) {
  if (!isMobileSheet()) return;
  const current = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  window.history.replaceState(
    {
      ...current,
      [MOBILE_HISTORY_STATE_KEY]: { navRootId: mobileUi.navRootId, transient },
    },
    ""
  );
}

function pushMobileHistoryState({ transient = false } = {}) {
  if (!isMobileSheet()) return;
  const current = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  window.history.pushState(
    {
      ...current,
      [MOBILE_HISTORY_STATE_KEY]: { navRootId: mobileUi.navRootId, transient },
    },
    ""
  );
}

/** @type {{ past: any[], future: any[], applying: boolean, coalescing: boolean }} */
const history = {
  past: [],
  future: [],
  applying: false,
  coalescing: false,
};

/** @type {{ nodes: Record<string, Node>, matchIds: Set<string>, displayIds: Set<string>, signature: string, offset: number, total: number, matchedTotal: number, hasMore: boolean, loading: boolean, requestId: number, payloads: Map<string, Node> }} */
const archiveState = {
  nodes: {},
  matchIds: new Set(),
  displayIds: new Set(),
  signature: "",
  offset: 0,
  total: 0,
  matchedTotal: 0,
  hasMore: false,
  loading: false,
  requestId: 0,
  payloads: new Map(),
  pendingPersistence: Promise.resolve(),
};

/** @type {{
 *  dragId: string | null,
 *  parentId: string | null,
 *  index: number,
 *  mode: 'before' | 'after' | 'into' | null,
 *  overId: string | null,
 *  active: boolean
 * }} */
let dnd = {
  dragId: null,
  parentId: null,
  index: 0,
  mode: null,
  overId: null,
  active: false,
};

function uid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

/** @returns {Node} */
function createNode(title = "", parentId = null) {
  return {
    id: uid(),
    title,
    parentId,
    childIds: [],
    collapsed: false,
    createdAt: now(),
    completedAt: null,
    dueAt: null,
    note: "",
    completedChildCount: 0,
  };
}

/** Default UI for a fresh document. */
function defaultUi() {
  return {
    tab: "active",
    theme: "easygoing",
    activeQuery: "",
    activeSort: "outline",
    progressMode: "all",
    categoryMode: false,
    dueKeepTree: true,
    dueShowUndated: false,
    titleWrap: true,
    plainTextMode: false,
    zoomId: null,
    archiveQuery: "",
    archiveSort: "completed-desc",
    archivePeriod: "all",
    archiveFrom: "",
    archiveTo: "",
  };
}

/** @returns {Doc} */
function emptyDoc() {
  const n = createNode("");
  return {
    schemaVersion: SCHEMA_VERSION,
    nodes: { [n.id]: n },
    rootIds: [n.id],
    selectedId: null,
    ui: defaultUi(),
  };
}

/** Stable IDs for the first-run tutorial tree (also used by verifyTutorialDoc). */
const TUTORIAL_IDS = {
  catStart: "tutorial-cat-start",
  click: "tutorial-click",
  enter: "tutorial-enter",
  complete: "tutorial-complete",
  completePractice: "tutorial-complete-practice",
  remove: "tutorial-remove",
  removePractice: "tutorial-remove-practice",
  nest: "tutorial-nest",
  nestTab: "tutorial-nest-tab",
  nestShift: "tutorial-nest-shift",
  nestPractice: "tutorial-nest-practice",
  nestCollapse: "tutorial-nest-collapse",
  reorder: "tutorial-reorder",
  reorderPractice: "tutorial-reorder-practice",
  progress: "tutorial-progress",
  progressA: "tutorial-progress-a",
  progressB: "tutorial-progress-b",
  catCategory: "tutorial-cat-category",
  catWhat: "tutorial-cat-what",
  catNoComplete: "tutorial-cat-no-complete",
  catAreas: "tutorial-cat-areas",
  catMove: "tutorial-cat-move",
  catOff: "tutorial-cat-off",
  catDetail: "tutorial-cat-detail",
  detailOpen: "tutorial-detail-open",
  detailFields: "tutorial-detail-fields",
  catDue: "tutorial-cat-due",
  dueToday: "tutorial-due-today",
  dueSoon: "tutorial-due-soon",
  dueSub: "tutorial-due-sub",
  dueChildEarly: "tutorial-due-child-early",
  dueChildLate: "tutorial-due-child-late",
  dueSort: "tutorial-due-sort",
  dueSortHidden: "tutorial-due-sort-hidden",
  catFocus: "tutorial-cat-focus",
  focusBtn: "tutorial-focus-btn",
  focusChild: "tutorial-focus-child",
  catMore: "tutorial-cat-more",
  moreTheme: "tutorial-more-theme",
  moreHelp: "tutorial-more-help",
  moreExport: "tutorial-more-export",
  moreCopy: "tutorial-more-copy",
};

/**
 * @param {string} id
 * @param {string} title
 * @param {{ parentId?: string | null, childIds?: string[], dueAt?: number | null, note?: string, collapsed?: boolean }} [opts]
 * @returns {Node}
 */
function makeTutorialNode(id, title, opts = {}) {
  return {
    id,
    title,
    parentId: opts.parentId ?? null,
    childIds: opts.childIds ? [...opts.childIds] : [],
    collapsed: !!opts.collapsed,
    createdAt: now(),
    completedAt: null,
    dueAt: opts.dueAt ?? null,
    note: opts.note ?? "",
  };
}

/** Local midnight + day offset (tutorial due dates stay relative to "today"). */
function tutorialDueOffset(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Optional sample outline used by the help tutorial.
 * Assumes categoryMode on, progress gauge on, dueKeepTree on,
 * dueShowUndated off, titleWrap on.
 * @returns {Doc}
 */
function tutorialDoc() {
  const I = TUTORIAL_IDS;
  const today = tutorialDueOffset(0);
  const tomorrow = tutorialDueOffset(1);
  const inThree = tutorialDueOffset(3);
  const inFive = tutorialDueOffset(5);
  const inSeven = tutorialDueOffset(7);
  const tt = (id) => t(`tut.${id}.title`);
  const tn = (id) => t(`tut.${id}.note`);

  /** @type {Record<string, Node>} */
  const nodes = {
    [I.catStart]: makeTutorialNode(I.catStart, tt("catStart"), {
      childIds: [I.click, I.enter, I.complete, I.remove, I.nest, I.reorder, I.progress],
      note: tn("catStart"),
    }),
    [I.click]: makeTutorialNode(I.click, tt("click"), {
      parentId: I.catStart,
      note: tn("click"),
    }),
    [I.enter]: makeTutorialNode(I.enter, tt("enter"), {
      parentId: I.catStart,
      note: tn("enter"),
    }),
    [I.complete]: makeTutorialNode(I.complete, tt("complete"), {
      parentId: I.catStart,
      childIds: [I.completePractice],
      note: tn("complete"),
    }),
    [I.completePractice]: makeTutorialNode(I.completePractice, tt("completePractice"), {
      parentId: I.complete,
      note: tn("completePractice"),
    }),
    [I.remove]: makeTutorialNode(I.remove, tt("remove"), {
      parentId: I.catStart,
      childIds: [I.removePractice],
      note: tn("remove"),
    }),
    [I.removePractice]: makeTutorialNode(I.removePractice, tt("removePractice"), {
      parentId: I.remove,
      note: tn("removePractice"),
    }),
    [I.nest]: makeTutorialNode(I.nest, tt("nest"), {
      parentId: I.catStart,
      childIds: [I.nestTab, I.nestShift, I.nestPractice, I.nestCollapse],
      note: tn("nest"),
    }),
    [I.nestTab]: makeTutorialNode(I.nestTab, tt("nestTab"), {
      parentId: I.nest,
    }),
    [I.nestShift]: makeTutorialNode(I.nestShift, tt("nestShift"), {
      parentId: I.nest,
    }),
    [I.nestPractice]: makeTutorialNode(I.nestPractice, tt("nestPractice"), {
      parentId: I.nest,
      note: tn("nestPractice"),
    }),
    [I.nestCollapse]: makeTutorialNode(I.nestCollapse, tt("nestCollapse"), {
      parentId: I.nest,
      note: tn("nestCollapse"),
    }),
    [I.reorder]: makeTutorialNode(I.reorder, tt("reorder"), {
      parentId: I.catStart,
      childIds: [I.reorderPractice],
      note: tn("reorder"),
    }),
    [I.reorderPractice]: makeTutorialNode(I.reorderPractice, tt("reorderPractice"), {
      parentId: I.reorder,
      note: tn("reorderPractice"),
    }),
    [I.progress]: makeTutorialNode(I.progress, tt("progress"), {
      parentId: I.catStart,
      childIds: [I.progressA, I.progressB],
      note: tn("progress"),
    }),
    [I.progressA]: makeTutorialNode(I.progressA, tt("progressA"), {
      parentId: I.progress,
    }),
    [I.progressB]: makeTutorialNode(I.progressB, tt("progressB"), {
      parentId: I.progress,
    }),

    [I.catCategory]: makeTutorialNode(I.catCategory, tt("catCategory"), {
      childIds: [I.catWhat, I.catNoComplete, I.catAreas, I.catMove, I.catOff],
      note: tn("catCategory"),
    }),
    [I.catWhat]: makeTutorialNode(I.catWhat, tt("catWhat"), {
      parentId: I.catCategory,
      note: tn("catWhat"),
    }),
    [I.catNoComplete]: makeTutorialNode(I.catNoComplete, tt("catNoComplete"), {
      parentId: I.catCategory,
      note: tn("catNoComplete"),
    }),
    [I.catAreas]: makeTutorialNode(I.catAreas, tt("catAreas"), {
      parentId: I.catCategory,
    }),
    [I.catMove]: makeTutorialNode(I.catMove, tt("catMove"), {
      parentId: I.catCategory,
    }),
    [I.catOff]: makeTutorialNode(I.catOff, tt("catOff"), {
      parentId: I.catCategory,
      note: tn("catOff"),
    }),

    [I.catDetail]: makeTutorialNode(I.catDetail, tt("catDetail"), {
      childIds: [I.detailOpen, I.detailFields],
      note: tn("catDetail"),
    }),
    [I.detailOpen]: makeTutorialNode(I.detailOpen, tt("detailOpen"), {
      parentId: I.catDetail,
      note: tn("detailOpen"),
    }),
    [I.detailFields]: makeTutorialNode(I.detailFields, tt("detailFields"), {
      parentId: I.catDetail,
      note: tn("detailFields"),
    }),

    [I.catDue]: makeTutorialNode(I.catDue, tt("catDue"), {
      childIds: [I.dueToday, I.dueSoon, I.dueSub, I.dueSort],
      note: tn("catDue"),
    }),
    [I.dueToday]: makeTutorialNode(I.dueToday, tt("dueToday"), {
      parentId: I.catDue,
      dueAt: today,
    }),
    [I.dueSoon]: makeTutorialNode(I.dueSoon, tt("dueSoon"), {
      parentId: I.catDue,
      dueAt: inThree,
    }),
    [I.dueSub]: makeTutorialNode(I.dueSub, tt("dueSub"), {
      parentId: I.catDue,
      dueAt: inSeven,
      childIds: [I.dueChildEarly, I.dueChildLate],
      note: tn("dueSub"),
    }),
    [I.dueChildEarly]: makeTutorialNode(I.dueChildEarly, tt("dueChildEarly"), {
      parentId: I.dueSub,
      dueAt: tomorrow,
    }),
    [I.dueChildLate]: makeTutorialNode(I.dueChildLate, tt("dueChildLate"), {
      parentId: I.dueSub,
      dueAt: inFive,
    }),
    [I.dueSort]: makeTutorialNode(I.dueSort, tt("dueSort"), {
      parentId: I.catDue,
      dueAt: inSeven,
      childIds: [I.dueSortHidden],
      note: tn("dueSort"),
    }),
    [I.dueSortHidden]: makeTutorialNode(I.dueSortHidden, tt("dueSortHidden"), {
      parentId: I.dueSort,
      note: tn("dueSortHidden"),
    }),

    [I.catFocus]: makeTutorialNode(I.catFocus, tt("catFocus"), {
      childIds: [I.focusBtn],
      note: tn("catFocus"),
    }),
    [I.focusBtn]: makeTutorialNode(I.focusBtn, tt("focusBtn"), {
      parentId: I.catFocus,
      childIds: [I.focusChild],
      note: tn("focusBtn"),
    }),
    [I.focusChild]: makeTutorialNode(I.focusChild, tt("focusChild"), {
      parentId: I.focusBtn,
      note: tn("focusChild"),
    }),

    [I.catMore]: makeTutorialNode(I.catMore, tt("catMore"), {
      childIds: [I.moreTheme, I.moreHelp, I.moreExport, I.moreCopy],
      note: tn("catMore"),
    }),
    [I.moreTheme]: makeTutorialNode(I.moreTheme, tt("moreTheme"), {
      parentId: I.catMore,
    }),
    [I.moreHelp]: makeTutorialNode(I.moreHelp, tt("moreHelp"), {
      parentId: I.catMore,
    }),
    [I.moreExport]: makeTutorialNode(I.moreExport, tt("moreExport"), {
      parentId: I.catMore,
      note: tn("moreExport"),
    }),
    [I.moreCopy]: makeTutorialNode(I.moreCopy, tt("moreCopy"), {
      parentId: I.catMore,
      note: tn("moreCopy"),
    }),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    nodes,
    rootIds: [I.catStart, I.catCategory, I.catDetail, I.catDue, I.catFocus, I.catMore],
    selectedId: null,
    ui: { ...defaultUi(), categoryMode: true },
  };
}

/** Small, disposable outline used by the guided practice mode. */
const GUIDED_TUTORIAL_IDS = {
  root: "guided-root",
  seed: "guided-seed",
  tail: "guided-tail",
};

function guidedTutorialDoc() {
  const I = GUIDED_TUTORIAL_IDS;
  const japanese = getLocale() === "ja";
  const rootTitle = japanese ? "週末の整理" : "Weekend reset";
  const seedTitle = japanese ? "買い出しを考える" : "Plan groceries";
  const tailTitle = japanese ? "予定を確認する" : "Check the calendar";
  const root = makeTutorialNode(I.root, rootTitle, { childIds: [I.seed, I.tail] });
  const seed = makeTutorialNode(I.seed, seedTitle, { parentId: I.root });
  const tail = makeTutorialNode(I.tail, tailTitle, { parentId: I.root });
  return {
    schemaVersion: SCHEMA_VERSION,
    nodes: { [I.root]: root, [I.seed]: seed, [I.tail]: tail },
    rootIds: [I.root],
    selectedId: null,
    ui: { ...defaultUi(), titleWrap: true, progressMode: "all" },
  };
}

/**
 * Structural check for the tutorial seed (settings + tree shape).
 * @param {Doc} d
 * @returns {{ ok: boolean, errors: string[] }}
 */
function verifyTutorialDoc(d) {
  /** @type {string[]} */
  const errors = [];
  if (!d || typeof d !== "object") {
    return { ok: false, errors: ["doc がありません"] };
  }
  const ui = d.ui || {};
  if (ui.categoryMode !== true) errors.push("categoryMode は true であるべき");
  if (ui.progressMode !== "all") errors.push('progressMode は "all" であるべき');
  if (ui.dueKeepTree !== true) errors.push("dueKeepTree は true であるべき");
  if (ui.dueShowUndated !== false) errors.push("dueShowUndated は false であるべき");
  if (ui.titleWrap !== true) errors.push("titleWrap は true であるべき");

  const I = TUTORIAL_IDS;
  const expectedRoots = [
    I.catStart,
    I.catCategory,
    I.catDetail,
    I.catDue,
    I.catFocus,
    I.catMore,
  ];
  if (!Array.isArray(d.rootIds) || d.rootIds.length !== expectedRoots.length) {
    errors.push(`rootIds は ${expectedRoots.length} 件であるべき`);
  } else {
    for (let i = 0; i < expectedRoots.length; i++) {
      if (d.rootIds[i] !== expectedRoots[i]) {
        errors.push(`rootIds[${i}] は ${expectedRoots[i]} であるべき`);
      }
    }
  }

  const tt = (id) => t(`tut.${id}.title`);
  /** @type {[string, string, string[]][]} */
  const expected = [
    [I.catStart, tt("catStart"), [I.click, I.enter, I.complete, I.remove, I.nest, I.reorder, I.progress]],
    [I.complete, tt("complete"), [I.completePractice]],
    [I.remove, tt("remove"), [I.removePractice]],
    [I.nest, tt("nest"), [I.nestTab, I.nestShift, I.nestPractice, I.nestCollapse]],
    [I.reorder, tt("reorder"), [I.reorderPractice]],
    [I.progress, tt("progress"), [I.progressA, I.progressB]],
    [I.catCategory, tt("catCategory"), [I.catWhat, I.catNoComplete, I.catAreas, I.catMove, I.catOff]],
    [I.catDetail, tt("catDetail"), [I.detailOpen, I.detailFields]],
    [I.catDue, tt("catDue"), [I.dueToday, I.dueSoon, I.dueSub, I.dueSort]],
    [I.dueSub, tt("dueSub"), [I.dueChildEarly, I.dueChildLate]],
    [I.dueSort, tt("dueSort"), [I.dueSortHidden]],
    [I.catFocus, tt("catFocus"), [I.focusBtn]],
    [I.focusBtn, tt("focusBtn"), [I.focusChild]],
    [I.catMore, tt("catMore"), [I.moreTheme, I.moreHelp, I.moreExport, I.moreCopy]],
  ];
  for (const [id, title, childIds] of expected) {
    const n = d.nodes?.[id];
    if (!n) {
      errors.push(`ノード ${id} がない`);
      continue;
    }
    if (n.title !== title) errors.push(`${id} の title が不一致`);
    const got = Array.isArray(n.childIds) ? n.childIds.join(",") : "";
    if (got !== childIds.join(",")) errors.push(`${id} の childIds が不一致`);
  }

  const dated = [
    I.dueToday,
    I.dueSoon,
    I.dueSub,
    I.dueChildEarly,
    I.dueChildLate,
    I.dueSort,
  ];
  for (const id of dated) {
    if (d.nodes?.[id]?.dueAt == null) errors.push(`${id} に期限が必要`);
  }
  if (d.nodes?.[I.dueSortHidden]?.dueAt != null) {
    errors.push(`${I.dueSortHidden} は期限なしであるべき`);
  }
  if (!(d.nodes?.[I.catWhat]?.note || "").trim()) {
    errors.push(`${I.catWhat} に説明メモが必要`);
  }
  if (!(d.nodes?.[I.focusBtn]?.note || "").trim()) {
    errors.push(`${I.focusBtn} に説明メモが必要`);
  }

  const expectedCount = Object.keys(I).length;
  const nodeCount = d.nodes ? Object.keys(d.nodes).length : 0;
  if (nodeCount !== expectedCount) {
    errors.push(`ノード数は ${expectedCount} であるべき（実際 ${nodeCount}）`);
  }

  return { ok: errors.length === 0, errors };
}

function wantsTutorialFromUrl() {
  try {
    return new URLSearchParams(location.search).has("tutorial");
  } catch {
    return false;
  }
}

function wantsGuidedTutorialFromUrl() {
  try {
    return new URLSearchParams(location.search).has("guided") || /\/tutorial\/?$/.test(location.pathname);
  } catch {
    return false;
  }
}

/** Strip `verify` only. Keep `tutorial` so refresh stays in preview mode. */
function clearVerifyQueryParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("verify")) return;
    url.searchParams.delete("verify");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

/**
 * When true, the in-memory doc is a disposable tutorial preview and must not
 * write the user's normal document. Guided mode also has its own storage key
 * so completion paths cannot touch the user's data.
 */
let skipPersist = false;

function loadDoc() {
  if (wantsGuidedTutorialFromUrl()) {
    skipPersist = true;
    return guidedTutorialDoc();
  }
  if (wantsTutorialFromUrl()) {
    skipPersist = true;
    return tutorialDoc();
  }
  const raw = storage.readLegacyRaw();
  if (!raw) {
    return emptyDoc();
  }
  try {
    const parsed = JSON.parse(raw);
    const migrated = migrateDoc(parsed);
    if (parsed?.storageFormat === SPLIT_FORMAT) return migrated;
    const validation = validateTree(migrated);
    if (validation.ok) return migrated;
    void storage.backupRaw(raw, "invalid-tree");
  } catch {
    void storage.backupRaw(raw, "invalid-json");
  }
  return emptyDoc();
}

/** @param {any} parsed @returns {Doc} */
function migrateDoc(parsed) {
  const base = emptyDoc();
  if (!parsed || typeof parsed !== "object" || !parsed.nodes) return base;
  const splitProjection = parsed.storageFormat === SPLIT_FORMAT;

  /** @type {Record<string, Node>} */
  const nodes = {};
  for (const [id, raw] of Object.entries(parsed.nodes)) {
    if (!raw || typeof raw !== "object") continue;
    nodes[id] = {
      id,
      title: typeof raw.title === "string" ? raw.title : "",
      parentId: raw.parentId ?? null,
      childIds: Array.isArray(raw.childIds) ? raw.childIds.filter((x) => typeof x === "string") : [],
      collapsed: !!raw.collapsed,
      createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now(),
      completedAt: typeof raw.completedAt === "number" ? raw.completedAt : null,
      dueAt: typeof raw.dueAt === "number" ? raw.dueAt : null,
      note: typeof raw.note === "string" ? raw.note : "",
      completedChildCount: Number.isFinite(raw.completedChildCount) ? Math.max(0, Math.floor(raw.completedChildCount)) : 0,
    };
  }

  let rootIds = Array.isArray(parsed.rootIds)
    ? (splitProjection ? parsed.rootIds.filter((id) => typeof id === "string") : parsed.rootIds.filter((id) => nodes[id]))
    : Object.values(nodes)
        .filter((n) => !n.parentId)
        .map((n) => n.id);

  if (!splitProjection) {
    // Repair parent/child links from parentId as source of truth.
    for (const n of Object.values(nodes)) n.childIds = [];
    for (const n of Object.values(nodes)) {
      if (n.parentId && nodes[n.parentId]) {
        if (!nodes[n.parentId].childIds.includes(n.id)) {
          nodes[n.parentId].childIds.push(n.id);
        }
      } else {
        n.parentId = null;
        if (!rootIds.includes(n.id)) rootIds.push(n.id);
      }
    }
  } else {
    // Keep archive placeholders while repairing all active parent/child links.
    const projection = { nodes, rootIds };
    repairTreeLinks(projection, { preserveExternalIds: true });
    rootIds = projection.rootIds;
  }
  rootIds = splitProjection
    ? [...new Set(rootIds.filter((id) => nodes[id] && nodes[id].parentId == null))]
    : rootIds.filter((id) => nodes[id] && nodes[id].parentId == null);
  for (const n of Object.values(nodes)) {
    if (n.parentId == null && !rootIds.includes(n.id)) rootIds.push(n.id);
  }

  if (!rootIds.length) {
    const n = createNode("");
    nodes[n.id] = n;
    rootIds = [n.id];
  }

  const selectedId =
    typeof parsed.selectedId === "string" && nodes[parsed.selectedId]
      ? parsed.selectedId
      : null;

  const rawUi = parsed.ui && typeof parsed.ui === "object" ? parsed.ui : {};
  const periods = new Set(["all", "today", "week", "month", "custom"]);
  const archiveSorts = new Set(["completed-desc", "completed-asc", "title-asc", "created-desc", "created-asc"]);
  const activeSorts = new Set(["outline", "due-asc"]);
  const themes = new Set(["easygoing", "retro-pop", "formal", "geek", "calm"]);
  const progressModes = new Set(["off", "all"]);
  const zoomId =
    typeof rawUi.zoomId === "string" && nodes[rawUi.zoomId] && isActive(nodes[rawUi.zoomId])
      ? rawUi.zoomId
      : null;
  let activeSort = typeof rawUi.activeSort === "string" ? rawUi.activeSort : "outline";
  if (activeSort === "due-desc") activeSort = "due-asc";
  if (!activeSorts.has(activeSort)) activeSort = "outline";
  const theme = themes.has(rawUi.theme) ? rawUi.theme : "easygoing";
  let progressMode = typeof rawUi.progressMode === "string" ? rawUi.progressMode : null;
  let categoryMode = !!rawUi.categoryMode;
  // legacy: hide-roots → categoryMode + gauge on all non-categories
  if (progressMode === "hide-roots") {
    progressMode = "all";
    categoryMode = true;
  }
  if (!progressModes.has(progressMode)) {
    // legacy hideProgress hid all gauges
    progressMode = rawUi.hideProgress ? "off" : "all";
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    storageFormat: splitProjection ? SPLIT_FORMAT : undefined,
    nodes,
    rootIds,
    selectedId,
    ui: {
      tab: rawUi.tab === "archive" ? "archive" : "active",
      theme,
      activeQuery: typeof rawUi.activeQuery === "string" ? rawUi.activeQuery : "",
      activeSort,
      progressMode,
      categoryMode,
      dueKeepTree: !!rawUi.dueKeepTree,
      dueShowUndated: !!rawUi.dueShowUndated,
      titleWrap: !!rawUi.titleWrap,
      plainTextMode: !!rawUi.plainTextMode,
      zoomId,
      archiveQuery: typeof rawUi.archiveQuery === "string" ? rawUi.archiveQuery : "",
      archiveSort: archiveSorts.has(rawUi.archiveSort) ? rawUi.archiveSort : "completed-desc",
      archivePeriod: periods.has(rawUi.archivePeriod) ? rawUi.archivePeriod : "all",
      archiveFrom: typeof rawUi.archiveFrom === "string" ? rawUi.archiveFrom : "",
      archiveTo: typeof rawUi.archiveTo === "string" ? rawUi.archiveTo : "",
    },
  };
}

const fallbackDoc = loadDoc();
doc = skipPersist || fallbackDoc.storageFormat === SPLIT_FORMAT ? fallbackDoc : splitDocument(fallbackDoc).doc;
let lastQueuedSyncSnapshot = createSyncContentSnapshot(doc);
let hasLocalChangesSinceStartup = false;
const storageHydration = skipPersist ? null : storage.hydrate(fallbackDoc);

function invalidateArchiveView() {
  archiveState.nodes = {};
  archiveState.matchIds = new Set();
  archiveState.displayIds = new Set();
  archiveState.signature = "";
  archiveState.offset = 0;
  archiveState.total = 0;
  archiveState.matchedTotal = 0;
  archiveState.hasMore = false;
  archiveState.loading = false;
  archiveState.requestId += 1;
  archiveState.payloads.clear();
}

function applyPersistedDoc(nextDoc) {
  doc = nextDoc;
  rangeIds = doc.selectedId ? [doc.selectedId] : [];
  rangeAnchorId = rangeIds[0] || null;
  const tab = doc.ui.tab;
  for (const btn of el.tabs) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  el.viewActive.classList.toggle("is-active", tab === "active");
  el.viewActive.hidden = tab !== "active";
  el.viewArchive.classList.toggle("is-active", tab === "archive");
  el.viewArchive.hidden = tab !== "archive";
  applyTheme(doc.ui.theme);
  render();
}

async function applySyncedDocument(fullDoc, { expectedSnapshot = null } = {}) {
  if (!fullDoc || skipPersist) return false;
  const guard = await createSyncApplyGuard({ storage, activeDoc: doc, expectedFullSnapshot: expectedSnapshot });
  if (!guard.matchesExpectedFullDocument) return false;
  const split = splitDocument(fullDoc);
  hasLocalChangesSinceStartup = true;
  await storage.replaceDocument(fullDoc);
  if (!activeProjectionIsCurrent(guard.activeSnapshot, doc)) return false;
  invalidateArchiveView();
  archiveState.total = split.archiveNodes.length;
  archiveState.matchedTotal = split.archiveNodes.length;
  applyPersistedDoc(split.doc);
  lastQueuedSyncSnapshot = createSyncContentSnapshot(doc);
  return true;
}

async function hydratePersistedDoc() {
  if (!storageHydration) return;
  const { doc: storedDoc, source, archiveStats } = await storageHydration;
  if (hasLocalChangesSinceStartup) return;
  if (!storedDoc || typeof storedDoc !== "object" || !storedDoc.nodes) return;
  const repairedDoc = migrateDoc(storedDoc);
  const total = Number(archiveStats?.count || 0);
  invalidateArchiveView();
  archiveState.total = total;
  archiveState.matchedTotal = total;
  if (JSON.stringify(repairedDoc) !== JSON.stringify(storedDoc)) await storage.write(repairedDoc);
  applyPersistedDoc(repairedDoc);
  lastQueuedSyncSnapshot = createSyncContentSnapshot(doc);
}

storage.subscribe((storedDoc, meta = {}) => {
  if (skipPersist || !storedDoc) return;
  if (!storedDoc.nodes || typeof storedDoc.nodes !== "object") return;
  if (meta.archiveChanged) invalidateArchiveView();
  applyPersistedDoc(storedDoc);
  if (!hasLocalChangesSinceStartup) lastQueuedSyncSnapshot = createSyncContentSnapshot(doc);
});

function cloneDocSnapshot() {
  return JSON.stringify({
    doc,
    rangeIds,
    rangeAnchorId,
  });
}

function pushHistory() {
  if (history.applying || history.coalescing) return;
  history.past.push({ raw: cloneDocSnapshot(), archiveChange: null });
  if (history.past.length > HISTORY_LIMIT) history.past.shift();
  history.future = [];
}

function recordArchiveChange(change) {
  const entry = history.past[history.past.length - 1];
  if (entry) entry.archiveChange = change;
}

function applyArchiveChange(change, inverse = false) {
  if (!change) return;
  const putNodes = inverse ? change.removedNodes || [] : change.putNodes || [];
  const removeIds = inverse ? (change.putNodes || []).map((node) => node.id) : change.removeIds || [];
  for (const node of putNodes) archiveState.nodes[node.id] = { ...node, note: "", archivePayloadLoaded: false };
  for (const id of removeIds) {
    delete archiveState.nodes[id];
    archiveState.payloads.delete(id);
    archiveState.matchIds.delete(id);
    archiveState.displayIds.delete(id);
  }
  archiveState.total = Math.max(0, archiveState.total + putNodes.length - removeIds.length);
  archiveState.signature = "";
  const persistence = storage.commit({ doc, put: putNodes, remove: removeIds });
  archiveState.pendingPersistence = persistence.catch(() => undefined);
  return persistence;
}

function beginCoalesce() {
  if (!history.coalescing) {
    pushHistory();
    history.coalescing = true;
  }
}

function endCoalesce() {
  history.coalescing = false;
}

function restoreSnapshot(raw) {
  try {
    const parsed = JSON.parse(raw);
    history.applying = true;
    doc = parsed.doc;
    rangeIds = Array.isArray(parsed.rangeIds) ? parsed.rangeIds.filter((id) => doc.nodes[id]) : [];
    rangeAnchorId =
      typeof parsed.rangeAnchorId === "string" && doc.nodes[parsed.rangeAnchorId]
        ? parsed.rangeAnchorId
        : rangeIds[0] || doc.selectedId;
    if (doc.selectedId && !doc.nodes[doc.selectedId]) doc.selectedId = rangeIds[0] || null;
    if (!skipPersist) {
      hasLocalChangesSinceStartup = true;
      void storage.write(doc);
    }
    // Paint tab chrome without clearing selection
    const tab = doc.ui.tab;
    for (const btn of el.tabs) {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
    el.viewActive.classList.toggle("is-active", tab === "active");
    el.viewActive.hidden = tab !== "active";
    el.viewArchive.classList.toggle("is-active", tab === "archive");
    el.viewArchive.hidden = tab !== "archive";
    applyTheme(doc.ui.theme);
    render();
    queueSyncIfContentChanged();
  } finally {
    history.applying = false;
  }
}

function undo() {
  if (!history.past.length) return;
  const current = cloneDocSnapshot();
  const prev = history.past.pop();
  history.future.push({ raw: current, archiveChange: prev.archiveChange });
  if (!skipPersist) {
    for (const node of prev.archiveChange?.putNodes || []) {
      void completionOutbox.cancelForTask(node.id);
    }
  }
  applyArchiveChange(prev.archiveChange, true);
  restoreSnapshot(prev.raw);
}

function redo() {
  if (!history.future.length) return;
  const current = cloneDocSnapshot();
  const next = history.future.pop();
  history.past.push({ raw: current, archiveChange: next.archiveChange });
  applyArchiveChange(next.archiveChange, false);
  restoreSnapshot(next.raw);
}

function saveDoc({ recordHistory = false } = {}) {
  if (recordHistory) pushHistory();
  if (skipPersist) return;
  repairTreeLinks(doc, { preserveExternalIds: true });
  hasLocalChangesSinceStartup = true;
  void storage.write(doc);
  queueSyncIfContentChanged();
}

function queueSyncIfContentChanged() {
  const nextSnapshot = createSyncContentSnapshot(doc);
  if (nextSnapshot === lastQueuedSyncSnapshot) return false;
  lastQueuedSyncSnapshot = nextSnapshot;
  driveSync.noteLocalChange();
  syncScheduler.noteLocalChange();
  updateSyncUi();
  return true;
}

const THEME_IDS = new Set(["easygoing", "retro-pop", "formal", "geek", "calm"]);

function normalizeTheme(id) {
  return THEME_IDS.has(id) ? id : "easygoing";
}

function normalizeProgressMode(id) {
  if (id === "off" || id === "all") return id;
  return "all";
}

function isCategoryMode() {
  return !!doc.ui.categoryMode;
}

/** Top-level node treated as a category when categoryMode is on. */
function isCategoryNode(n) {
  return !!(n && isCategoryMode() && n.parentId == null);
}

/** True root category for a descendant (or null). */
function categoryRootOf(id) {
  if (!isCategoryMode()) return null;
  let cur = getNode(id);
  if (!cur || cur.parentId == null) return null;
  while (cur && cur.parentId != null) {
    const parent = getNode(cur.parentId);
    if (!parent) break;
    if (parent.parentId == null) return parent;
    cur = parent;
  }
  return null;
}

function applyTheme(themeId = doc.ui.theme) {
  const theme = normalizeTheme(themeId);
  doc.ui.theme = theme;
  document.body.dataset.theme = theme;
  for (const opt of el.themeOptions) {
    const on = opt.dataset.themeId === theme;
    opt.classList.toggle("is-active", on);
    opt.setAttribute("aria-checked", on ? "true" : "false");
  }
}

function syncBodyUiClasses() {
  document.body.classList.toggle("is-title-wrap", !!doc.ui.titleWrap);
  document.body.classList.toggle("is-plain-text", !!doc.ui.plainTextMode && doc.ui.tab === "active");
}

/** Structural edits: push history then save. */
function commit() {
  pushHistory();
  if (skipPersist) return;
  hasLocalChangesSinceStartup = true;
  void storage.write(doc);
  queueSyncIfContentChanged();
}

function getNode(id) {
  return doc.nodes[id] || archiveState.nodes[id] || null;
}

function isActive(node) {
  return !!(node && node.completedAt == null);
}

function isCompleted(node) {
  return !!(node && node.completedAt != null);
}

function childrenOf(id) {
  const n = doc.nodes[id];
  return n ? n.childIds.map((childId) => doc.nodes[childId]).filter(Boolean) : [];
}

function activeChildrenOf(id) {
  return childrenOf(id).filter(isActive);
}

function depthOf(id) {
  let d = 0;
  let cur = getNode(id);
  while (cur && cur.parentId) {
    d += 1;
    cur = getNode(cur.parentId);
  }
  return d;
}

function collectDescendants(id) {
  /** @type {string[]} */
  const out = [];
  const walk = (nid) => {
    for (const c of childrenOf(nid)) {
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

function subtreeHasCompleted(id) {
  const n = getNode(id);
  if (!n) return false;
  if (isCompleted(n)) return true;
  return childrenOf(id).some((c) => subtreeHasCompleted(c.id));
}

function latestCompletedInSubtree(id) {
  let latest = isCompleted(getNode(id)) ? getNode(id).completedAt : null;
  for (const did of collectDescendants(id)) {
    const d = getNode(did);
    if (d && isCompleted(d) && (latest == null || d.completedAt > latest)) {
      latest = d.completedAt;
    }
  }
  return latest;
}

function earliestCreatedInSubtree(id) {
  let earliest = getNode(id)?.createdAt ?? null;
  for (const did of collectDescendants(id)) {
    const d = getNode(did);
    if (d && (earliest == null || d.createdAt < earliest)) earliest = d.createdAt;
  }
  return earliest;
}

function formatDate(ts) {
  if (ts == null) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDateShort(ts) {
  if (ts == null) return "—";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Compact month/day for mobile row submeta. */
function formatDateCompact(ts) {
  if (ts == null) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Local calendar day start for a due date (date-only). */
function dueAtFromDateInput(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

function dueAtToDateInput(ts) {
  if (ts == null) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function detailDueAltFormat() {
  return getLocale() === "ja" ? "Y年n月j日" : "M j, Y";
}

function detailDuePickerLocale() {
  if (getLocale() === "ja" && window.flatpickr?.l10ns?.ja) return window.flatpickr.l10ns.ja;
  return "default";
}

function syncDetailDuePickerState(value = "", disabled = false) {
  if (!detailDuePicker) return;
  if (value) detailDuePicker.setDate(value, false, "Y-m-d");
  else detailDuePicker.clear(false);
  if (detailDuePicker.altInput) detailDuePicker.altInput.disabled = disabled;
}

function initDetailDuePicker() {
  if (!el.detailDue || !window.flatpickr || detailDuePicker) return;
  const dueLabel = document.querySelector('label[for="detail-due"]');
  detailDuePicker = window.flatpickr(el.detailDue, {
    altInput: true,
    altFormat: detailDueAltFormat(),
    dateFormat: "Y-m-d",
    disableMobile: true,
    locale: detailDuePickerLocale(),
    monthSelectorType: "static",
    nextArrow: '<span aria-hidden="true">›</span>',
    prevArrow: '<span aria-hidden="true">‹</span>',
    onReady: (_selectedDates, _dateStr, instance) => {
      instance.altInput.classList.add("pop-input", "input-white", "range-date", "detail-due-picker-input");
      instance.altInput.id = "detail-due-alt";
      instance.altInput.setAttribute("aria-label", t("detail.due"));
      dueLabel?.setAttribute("for", "detail-due-alt");
      instance.calendarContainer.classList.add("taskliner-date-picker");
    },
    onChange: (_selectedDates, dateStr) => {
      if (el.detailDue.value !== dateStr) el.detailDue.value = dateStr;
      el.detailDue.dispatchEvent(new Event("change", { bubbles: true }));
    },
  });
  syncDetailDuePickerState(el.detailDue.value, !!el.detailDue.disabled);
}

function refreshDetailDuePicker() {
  if (!detailDuePicker) return;
  detailDuePicker.set("locale", detailDuePickerLocale());
  detailDuePicker.set("altFormat", detailDueAltFormat());
  if (detailDuePicker.altInput) detailDuePicker.altInput.setAttribute("aria-label", t("detail.due"));
  syncDetailDuePickerState(el.detailDue?.value || "", !!el.detailDue?.disabled);
}

function isDueOverdue(ts) {
  if (ts == null) return false;
  return ts < startOfLocalDay();
}

function isDueToday(ts) {
  if (ts == null) return false;
  const today = startOfLocalDay();
  return ts >= today && ts < today + 86400000;
}

/** Direct children only (not grandchildren). */
function childProgress(id) {
  const n = getNode(id);
  const kids = childrenOf(id);
  const archivedDone = doc.ui.tab === "active" ? Number(n?.completedChildCount || 0) : 0;
  if (!kids.length && !archivedDone) return null;
  let done = 0;
  for (const c of kids) {
    if (isCompleted(c)) done += 1;
  }
  return { done: done + archivedDone, total: kids.length + archivedDone };
}

function ancestorChain(id) {
  /** @type {Node[]} */
  const chain = [];
  let cur = getNode(id);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return chain;
}

function ensureZoomValid() {
  const z = doc.ui.zoomId;
  if (!z) return;
  const n = getNode(z);
  if (!n || !isActive(n)) doc.ui.zoomId = null;
}

function setZoom(id) {
  const n = getNode(id);
  if (!n || !isActive(n) || doc.ui.tab !== "active") return;
  pushHistory();
  doc.ui.zoomId = id;
  n.collapsed = false;
  selectNode(id);
  render();
  focusTitle(id, { selectAll: false });
  saveDoc();
}

function zoomOut() {
  const z = doc.ui.zoomId;
  if (!z) return;
  pushHistory();
  const n = getNode(z);
  const parentId = n?.parentId || null;
  // If parent is outside current zoom ancestry, go to parent; else clear to root
  if (parentId && getNode(parentId) && isActive(getNode(parentId))) {
    doc.ui.zoomId = parentId;
  } else {
    doc.ui.zoomId = null;
  }
  if (n) selectNode(n.id);
  render();
  if (n) focusTitle(n.id, { selectAll: false });
  saveDoc();
}

function zoomToRoot() {
  if (!doc.ui.zoomId) return;
  pushHistory();
  doc.ui.zoomId = null;
  render();
  saveDoc();
}

function activeFiltersActive() {
  return !!doc.ui.activeQuery.trim();
}

function nodePassesActiveFilters(n) {
  if (!n || !isActive(n)) return false;
  const q = doc.ui.activeQuery.trim().toLowerCase();
  if (q && !nodeMatchesQuery(n, q)) return false;
  return true;
}

function subtreeHasActiveMatch(id) {
  const n = getNode(id);
  if (!n || !isActive(n)) return false;
  if (nodePassesActiveFilters(n)) return true;
  return activeChildrenOf(id).some((c) => subtreeHasActiveMatch(c.id));
}

function activeForestRoots() {
  ensureZoomValid();
  const zoomId = doc.ui.zoomId;
  if (zoomId && getNode(zoomId) && isActive(getNode(zoomId))) {
    return [zoomId];
  }
  return doc.rootIds.filter((id) => {
    const n = getNode(id);
    return n && isActive(n);
  });
}

function compareDue(a, b, desc = false) {
  const da = a.dueAt;
  const db = b.dueAt;
  const aMissing = da == null;
  const bMissing = db == null;
  if (aMissing && bMissing) return a.title.localeCompare(b.title, getLocaleTag());
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (da !== db) return desc ? db - da : da - db;
  return a.title.localeCompare(b.title, getLocaleTag());
}

function ensureActiveRoot() {
  if (Object.values(doc.nodes).some(isActive)) return;
  const n = createNode("");
  doc.nodes[n.id] = n;
  doc.rootIds.push(n.id);
  // Keep unselected; user can click a row to start editing
}

function focusSelectedEditor() {
  if (!doc.selectedId) return;
  if (isMobileSheet()) {
    sheetLevel = "peek";
    syncSheetUi();
    requestAnimationFrame(() => {
      el.detailTitle?.focus();
      el.detailTitle?.select();
    });
    return;
  }
  focusTitle(doc.selectedId);
}

function addMobileItem() {
  if (!isMobileSheet()) return;
  const blank = Object.values(doc.nodes).find(
    (n) => isActive(n) && !n.parentId && !(n.title || "").trim() && !n.childIds.length
  );
  if (blank) {
    selectNode(blank.id);
    render();
    focusSelectedEditor();
    return;
  }
  pushHistory();
  const n = createNode("");
  doc.nodes[n.id] = n;
  doc.rootIds.push(n.id);
  selectNode(n.id);
  render();
  saveDoc();
  focusSelectedEditor();
}

function clearSelection() {
  doc.selectedId = null;
  mobileUi.detailsOpen = false;
  rangeIds = [];
  rangeAnchorId = null;
}

/** Blur title/detail inputs and clear the current selection. */
function clearInputAndSelection() {
  const active = document.activeElement;
  if (
    active &&
    (active.classList?.contains("title-input") ||
      active === el.detailTitle ||
      active === el.detailNote ||
      active === el.detailDue ||
      active === detailDuePicker?.altInput)
  ) {
    active.blur();
  }
  clearSelection();
  clearDropIndicators();
  syncSelectionClasses();
  renderDetail();
  saveDoc();
}

function setTab(tab) {
  if (doc.ui.tab === tab) return;
  doc.ui.tab = tab;
  for (const btn of el.tabs) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  el.viewActive.classList.toggle("is-active", tab === "active");
  el.viewActive.hidden = tab !== "active";
  el.viewArchive.classList.toggle("is-active", tab === "archive");
  el.viewArchive.hidden = tab !== "archive";
  clearSelection();
  clearDropIndicators();
  closeAllToolPops();
  // Retrigger view enter animation
  const view = tab === "active" ? el.viewActive : el.viewArchive;
  if (!prefersReducedMotion()) {
    view.style.animation = "none";
    void view.offsetWidth;
    view.style.animation = "";
  }
  render();
  saveDoc();
}

function selectNode(id, { extend = false } = {}) {
  if (!id || !getNode(id)) {
    doc.selectedId = null;
    rangeIds = [];
    rangeAnchorId = null;
    renderDetail();
    syncSelectionClasses();
    saveDoc();
    return;
  }

  if (extend) {
    const visible = currentVisibleIds();
    const anchor = rangeAnchorId || doc.selectedId || id;
    const a = visible.indexOf(anchor);
    const b = visible.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      rangeIds = visible.slice(lo, hi + 1);
      rangeAnchorId = anchor;
      doc.selectedId = id;
      syncSelectionClasses();
      renderDetail();
      saveDoc();
      focusSelectedTitleIfNeeded();
      return;
    }
  }

  doc.selectedId = id;
  rangeIds = [id];
  rangeAnchorId = id;
  renderDetail();
  syncSelectionClasses();
  saveDoc();
  focusSelectedTitleIfNeeded();
}

function currentVisibleIds() {
  return doc.ui.tab === "active" ? visibleActiveIds() : visibleArchiveIds().map((x) => x.id);
}

function visibleActiveIds() {
  return visibleActiveRows().map((r) => r.id);
}

/**
 * Visible active rows with display depth.
 * Due-sort: flat by default; optional tree via ui.dueKeepTree.
 * @returns {{ id: string, displayDepth: number, isZoomRoot?: boolean, contextParent?: boolean }[]}
 */
function visibleActiveRows() {
  const sort = doc.ui.activeSort || "outline";
  if (sort === "due-asc") return visibleDueSortRows();

  /** @type {{ id: string, displayDepth: number, isZoomRoot?: boolean }[]} */
  const rows = [];
  const filtering = activeFiltersActive();
  const zoomId = doc.ui.zoomId;

  const walk = (id, displayDepth) => {
    const n = getNode(id);
    if (!n || !isActive(n)) return;
    if (!subtreeHasActiveMatch(id)) return;
    rows.push({ id, displayDepth });
    const expand = filtering || !n.collapsed;
    if (!expand) return;
    for (const c of activeChildrenOf(id)) walk(c.id, displayDepth + 1);
  };

  for (const rootId of activeForestRoots()) {
    if (zoomId && rootId === zoomId) {
      const z = getNode(rootId);
      if (!z || !subtreeHasActiveMatch(rootId)) continue;
      rows.push({ id: rootId, displayDepth: 0, isZoomRoot: true });
      const expand = filtering || !z.collapsed;
      if (expand) {
        for (const c of activeChildrenOf(rootId)) walk(c.id, 1);
      }
    } else {
      walk(rootId, 0);
    }
  }
  return rows;
}

function nodeIsDueSortMatch(n) {
  if (!nodePassesActiveFilters(n)) return false;
  // Categories are headers in due-sort (shown separately), not due-sorted tasks.
  if (isCategoryNode(n)) return false;
  if (n.dueAt != null) return true;
  return !!doc.ui.dueShowUndated;
}

function subtreeHasDueSortMatch(id) {
  const n = getNode(id);
  if (!n || !isActive(n)) return false;
  if (nodeIsDueSortMatch(n)) return true;
  return activeChildrenOf(id).some((c) => subtreeHasDueSortMatch(c.id));
}

function earliestDueInActiveSubtree(id) {
  const n = getNode(id);
  if (!n || !isActive(n)) return null;
  let best = n.dueAt;
  for (const c of activeChildrenOf(id)) {
    const d = earliestDueInActiveSubtree(c.id);
    if (d != null && (best == null || d < best)) best = d;
  }
  return best;
}

function compareDueSubtree(a, b) {
  const da = earliestDueInActiveSubtree(a.id);
  const db = earliestDueInActiveSubtree(b.id);
  const aMissing = da == null;
  const bMissing = db == null;
  if (aMissing && bMissing) return a.title.localeCompare(b.title, getLocaleTag());
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (da !== db) return da - db;
  return a.title.localeCompare(b.title, getLocaleTag());
}

/** Collect due-sort matches under `rootId` (excluding category roots themselves). */
function collectDueSortMatchesFlat(rootId) {
  /** @type {Node[]} */
  const flat = [];
  const walkFlat = (id) => {
    const n = getNode(id);
    if (!n || !isActive(n)) return;
    if (!subtreeHasActiveMatch(id)) return;
    if (nodeIsDueSortMatch(n)) flat.push(n);
    for (const c of activeChildrenOf(id)) walkFlat(c.id);
  };
  walkFlat(rootId);
  flat.sort((a, b) => compareDue(a, b, false));
  return flat;
}

/** @returns {{ id: string, displayDepth: number, contextParent?: boolean }[]} */
function visibleDueSortRows() {
  const keepTree = !!doc.ui.dueKeepTree;
  const filtering = activeFiltersActive();
  const categoryMode = isCategoryMode();

  if (!keepTree) {
    if (categoryMode) {
      /** @type {{ id: string, displayDepth: number, contextParent?: boolean }[]} */
      const rows = [];
      const roots = activeForestRoots()
        .map(getNode)
        .filter(Boolean)
        .filter((n) => subtreeHasDueSortMatch(n.id))
        .sort(compareDueSubtree);
      for (const root of roots) {
        if (isCategoryNode(root)) {
          rows.push({ id: root.id, displayDepth: 0, contextParent: false });
          if (filtering || !root.collapsed) {
            for (const n of collectDueSortMatchesFlat(root.id)) {
              rows.push({ id: n.id, displayDepth: 1 });
            }
          }
        } else {
          for (const n of collectDueSortMatchesFlat(root.id)) {
            rows.push({ id: n.id, displayDepth: 0 });
          }
        }
      }
      return rows;
    }

    /** @type {Node[]} */
    const flat = [];
    for (const rootId of activeForestRoots()) {
      flat.push(...collectDueSortMatchesFlat(rootId));
    }
    flat.sort((a, b) => compareDue(a, b, false));
    return flat.map((n) => ({ id: n.id, displayDepth: 0 }));
  }

  /** @type {{ id: string, displayDepth: number, contextParent?: boolean }[]} */
  const rows = [];
  const walk = (id, displayDepth) => {
    const n = getNode(id);
    if (!n || !isActive(n)) return;
    if (!subtreeHasDueSortMatch(id)) return;
    const isMatch = nodeIsDueSortMatch(n);
    const isCat = isCategoryNode(n);
    // Categories stay as headers (not dimmed context). Other non-matches are ancestors kept for tree context.
    rows.push({ id, displayDepth, contextParent: !isMatch && !isCat });
    const expand = filtering || !n.collapsed;
    if (!expand) return;
    const kids = activeChildrenOf(id)
      .filter((c) => subtreeHasDueSortMatch(c.id))
      .sort(compareDueSubtree);
    for (const c of kids) walk(c.id, displayDepth + 1);
  };

  const roots = activeForestRoots()
    .map(getNode)
    .filter(Boolean)
    .filter((n) => subtreeHasDueSortMatch(n.id))
    .sort(compareDueSubtree);
  for (const root of roots) walk(root.id, 0);
  return rows;
}

function nodeMatchesQuery(n, q) {
  if (!q) return true;
  const hay = `${n.title}\n${n.note}`.toLowerCase();
  return hay.includes(q);
}

function startOfLocalDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseDateInput(value, endOfDay = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (endOfDay) return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  return new Date(y, m - 1, d).getTime();
}

function archivePeriodRange(period) {
  const now = new Date();
  const today = startOfLocalDay(now);
  if (period === "today") return { from: today, to: today + 86400000 - 1 };
  if (period === "week") {
    const day = now.getDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    return { from: today - mondayOffset * 86400000, to: null };
  }
  if (period === "month") {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), to: null };
  }
  if (period === "custom") {
    const from = parseDateInput(doc.ui.archiveFrom, false);
    const to = parseDateInput(doc.ui.archiveTo, true);
    if (from == null && to == null) return null;
    return { from: from ?? 0, to: to ?? null };
  }
  return null;
}

function completedInPeriod(n, period) {
  if (!n || !isCompleted(n)) return false;
  const range = archivePeriodRange(period);
  if (!range) return period !== "custom";
  if (range.from != null && n.completedAt < range.from) return false;
  if (range.to != null && n.completedAt > range.to) return false;
  return true;
}

function archiveFiltersActive() {
  const period = doc.ui.archivePeriod || "all";
  if (doc.ui.archiveQuery.trim()) return true;
  if (period === "all") return false;
  if (period === "custom") return !!(doc.ui.archiveFrom || doc.ui.archiveTo);
  return true;
}

function archiveViewSignature() {
  return JSON.stringify([
    doc.ui.archiveQuery || "",
    doc.ui.archiveSort || "completed-desc",
    doc.ui.archivePeriod || "all",
    doc.ui.archiveFrom || "",
    doc.ui.archiveTo || "",
  ]);
}

function archiveLoadedChildrenOf(id) {
  const parent = doc.nodes[id] || archiveState.nodes[id];
  if (!parent) return [];
  const byId = new Map();
  for (const node of Object.values(archiveState.nodes)) {
    if (node.parentId === id && archiveState.displayIds.has(node.id)) byId.set(node.id, node);
  }
  for (const childId of parent.childIds || []) {
    if (!archiveState.displayIds.has(childId)) continue;
    const child = doc.nodes[childId] || archiveState.nodes[childId];
    if (child) byId.set(child.id, child);
  }
  const order = new Map((parent.childIds || []).map((childId, index) => [childId, index]));
  return [...byId.values()].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.id) ? order.get(b.id) : Number.MAX_SAFE_INTEGER;
    return ai - bi || (a.createdAt || 0) - (b.createdAt || 0) || a.title.localeCompare(b.title, getLocaleTag());
  });
}

function buildArchiveDisplayIds() {
  const display = new Set();
  for (const matchId of archiveState.matchIds) {
    let current = getNode(matchId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      display.add(current.id);
      current = current.parentId ? getNode(current.parentId) : null;
    }
  }
  archiveState.displayIds = display;
}

function subtreeHasArchiveMatch(id) {
  if (archiveState.matchIds.has(id)) return true;
  return archiveLoadedChildrenOf(id).some((child) => subtreeHasArchiveMatch(child.id));
}

function countCompletedArchiveMatches() {
  return archiveState.matchedTotal || 0;
}

function countAllCompleted() {
  return doc.ui.tab === "archive" ? archiveState.total : Object.values(doc.nodes).filter(isCompleted).length;
}

function archiveSortValue(id, kind) {
  const node = getNode(id);
  if (!node) return 0;
  let value = kind === "created" ? node.createdAt || 0 : node.completedAt || 0;
  for (const child of archiveLoadedChildrenOf(id)) {
    if (!archiveState.displayIds.has(child.id)) continue;
    const next = archiveSortValue(child.id, kind);
    value = kind === "created" ? Math.min(value || next, next || value) : Math.max(value, next);
  }
  return value;
}

/** Visible archive rows are built from the currently loaded matching page and its ancestors. */
function visibleArchiveRows() {
  buildArchiveDisplayIds();
  const filtering = archiveFiltersActive();
  const roots = [...archiveState.displayIds]
    .filter((id) => {
      const n = getNode(id);
      return n && (!n.parentId || !archiveState.displayIds.has(n.parentId));
    })
    .sort((a, b) => {
      const sort = doc.ui.archiveSort;
      if (sort === "title-asc") return getNode(a).title.localeCompare(getNode(b).title, getLocaleTag());
      const kind = sort.startsWith("created") ? "created" : "completed";
      const av = archiveSortValue(a, kind);
      const bv = archiveSortValue(b, kind);
      if (av !== bv) return sort.endsWith("asc") ? av - bv : bv - av;
      return getNode(a).title.localeCompare(getNode(b).title, getLocaleTag());
    });

  const rows = [];
  const walk = (id, depth) => {
    const node = getNode(id);
    if (!node || !archiveState.displayIds.has(id)) return;
    rows.push({ id, displayDepth: depth, contextParent: !archiveState.matchIds.has(id) });
    if (!filtering && node.collapsed) return;
    for (const child of archiveLoadedChildrenOf(id)) walk(child.id, depth + 1);
  };
  for (const rootId of roots) walk(rootId, 0);
  return rows;
}

function visibleArchiveIds() {
  return visibleArchiveRows();
}

function archiveQueryOptions() {
  const range = archivePeriodRange(doc.ui.archivePeriod || "all");
  return {
    query: doc.ui.archiveQuery || "",
    from: range?.from ?? null,
    to: range?.to ?? null,
    sort: doc.ui.archiveSort || "completed-desc",
  };
}

async function loadArchivePage({ reset = false } = {}) {
  const signature = archiveViewSignature();
  if (archiveState.loading) return;
  const requestId = ++archiveState.requestId;
  archiveState.loading = true;
  if (reset) {
    archiveState.signature = signature;
    archiveState.offset = 0;
    archiveState.nodes = {};
    archiveState.matchIds = new Set();
    archiveState.displayIds = new Set();
    archiveState.payloads.clear();
  }
  renderArchive();

  try {
    await archiveState.pendingPersistence;
    const result = await storage.queryArchive({
      ...archiveQueryOptions(),
      offset: archiveState.offset,
      limit: 100,
    });
    if (requestId !== archiveState.requestId || signature !== archiveViewSignature()) return;

    const loaded = new Map();
    const add = (node) => {
      if (node && node.id) loaded.set(node.id, node);
    };
    for (const item of result.items || []) {
      add(item);
      let parentId = item.parentId;
      while (parentId) {
        if (doc.nodes[parentId]) break;
        if (loaded.has(parentId) || archiveState.nodes[parentId]) {
          parentId = (loaded.get(parentId) || archiveState.nodes[parentId]).parentId;
          continue;
        }
        const parent = await storage.getArchiveNode(parentId);
        if (!parent) break;
        add({ ...parent, note: "", childIds: [], archivePayloadLoaded: false });
        parentId = parent.parentId;
      }
    }
    for (const [id, node] of loaded) archiveState.nodes[id] = node;
    for (const item of result.items || []) archiveState.matchIds.add(item.id);
    archiveState.offset += (result.items || []).length;
    archiveState.matchedTotal = result.total || 0;
    archiveState.total = Math.max(archiveState.total, storage.archiveCount(), archiveState.matchedTotal);
    archiveState.hasMore = !!result.hasMore;
    buildArchiveDisplayIds();
  } catch {
    archiveState.hasMore = false;
  } finally {
    if (requestId === archiveState.requestId) {
      archiveState.loading = false;
      renderArchive();
    }
  }
}

function syncArchiveFilterUi() {
  const q = doc.ui.archiveQuery || "";
  if (el.archiveQuery && document.activeElement !== el.archiveQuery) {
    el.archiveQuery.value = q;
  }

  const period = doc.ui.archivePeriod || "all";
  for (const chip of el.archivePeriodChips) {
    chip.classList.toggle("is-active", chip.dataset.period === period);
  }
  for (const chip of el.archiveSortChips) {
    chip.classList.toggle("is-active", chip.dataset.sort === doc.ui.archiveSort);
  }

  el.archiveRangePanel.hidden = period !== "custom";
  el.archiveFrom.value = doc.ui.archiveFrom || "";
  el.archiveTo.value = doc.ui.archiveTo || "";

  const matched = countCompletedArchiveMatches();
  const total = countAllCompleted();
  const filtering = archiveFiltersActive();
  el.archiveClearFilters.hidden = !filtering;

  if (!total) {
    el.archiveCount.textContent = "";
  } else if (filtering) {
    el.archiveCount.textContent = t("archive.countFiltered", { matched, total });
  } else {
    el.archiveCount.textContent = t("archive.count", { n: total });
  }
}

function clearArchiveFilters() {
  doc.ui.archiveQuery = "";
  doc.ui.archivePeriod = "all";
  doc.ui.archiveFrom = "";
  doc.ui.archiveTo = "";
  syncArchiveFilterUi();
  invalidateArchiveView();
  renderArchive();
  saveDoc();
}

function siblingList(id) {
  const n = getNode(id);
  if (!n) return null;
  if (n.parentId) {
    const parent = getNode(n.parentId);
    return parent ? parent.childIds : null;
  }
  return doc.rootIds;
}

function detachNode(id) {
  const n = getNode(id);
  if (!n) return;
  if (n.parentId) {
    const parent = getNode(n.parentId);
    if (parent) parent.childIds = parent.childIds.filter((cid) => cid !== id);
  } else {
    doc.rootIds = doc.rootIds.filter((rid) => rid !== id);
  }
  n.parentId = null;
}

function insertNode(id, parentId, index) {
  const n = getNode(id);
  if (!n) return;
  n.parentId = parentId;
  if (parentId) {
    const parent = getNode(parentId);
    if (!parent) return;
    const i = Math.max(0, Math.min(index, parent.childIds.length));
    parent.childIds.splice(i, 0, id);
  } else {
    const i = Math.max(0, Math.min(index, doc.rootIds.length));
    doc.rootIds.splice(i, 0, id);
  }
}

function isAncestor(maybeAncestorId, nodeId) {
  let cur = getNode(nodeId);
  while (cur) {
    if (cur.id === maybeAncestorId) return true;
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return false;
}

function insertSiblingBelow(id) {
  const n = getNode(id);
  if (!n || !isActive(n)) return;
  pushHistory();
  const neu = createNode("", n.parentId);
  doc.nodes[neu.id] = neu;

  if (n.parentId) {
    const parent = getNode(n.parentId);
    const idx = parent.childIds.indexOf(id);
    parent.childIds.splice(idx + 1, 0, neu.id);
  } else {
    const idx = doc.rootIds.indexOf(id);
    doc.rootIds.splice(idx + 1, 0, neu.id);
  }

  selectNode(neu.id);
  render();
  focusTitle(neu.id);
  saveDoc();
}

function insertSiblingAbove(id) {
  const n = getNode(id);
  if (!n || !isActive(n)) return;
  pushHistory();
  const neu = createNode("", n.parentId);
  doc.nodes[neu.id] = neu;

  if (n.parentId) {
    const parent = getNode(n.parentId);
    const idx = parent.childIds.indexOf(id);
    parent.childIds.splice(idx, 0, neu.id);
  } else {
    const idx = doc.rootIds.indexOf(id);
    doc.rootIds.splice(idx, 0, neu.id);
  }

  selectNode(neu.id);
  render();
  focusTitle(neu.id);
  saveDoc();
}

/** Split title at caret: left stays, right becomes new sibling below. */
function splitNodeAtCaret(id, caret) {
  const n = getNode(id);
  if (!n || !isActive(n)) return;
  const title = n.title || "";
  const left = title.slice(0, caret);
  const right = title.slice(caret);
  pushHistory();
  n.title = left;
  const neu = createNode(right, n.parentId);
  doc.nodes[neu.id] = neu;

  if (n.parentId) {
    const parent = getNode(n.parentId);
    const idx = parent.childIds.indexOf(id);
    parent.childIds.splice(idx + 1, 0, neu.id);
  } else {
    const idx = doc.rootIds.indexOf(id);
    doc.rootIds.splice(idx + 1, 0, neu.id);
  }

  selectNode(neu.id);
  render();
  focusTitle(neu.id, { selectAll: false });
  saveDoc();
}

/**
 * Parse pasted Markdown / indented bullets into a tree of titles.
 * @returns {{ title: string, children: any[] }[]}
 */
function parseOutlinePaste(text) {
  const rawLines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  /** @type {{ title: string, depth: number }[]} */
  const items = [];
  for (const line of rawLines) {
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    let depth;
    let title;
    if (m) {
      const spaces = m[1].replace(/\t/g, "  ").length;
      depth = Math.floor(spaces / 2);
      title = m[3];
    } else {
      const spaces = (line.match(/^\s*/) || [""])[0].replace(/\t/g, "  ").length;
      depth = Math.floor(spaces / 2);
      title = line.trim();
    }
    items.push({ title, depth });
  }
  if (!items.length) return [];

  const min = Math.min(...items.map((x) => x.depth));
  /** @type {{ title: string, children: any[] }[]} */
  const roots = [];
  /** @type {{ title: string, children: any[], depth: number }[]} */
  const stack = [];
  for (const item of items) {
    const depth = item.depth - min;
    const node = { title: item.title, children: [], depth };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (!stack.length) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * Insert parsed outline as siblings below `afterId` (same parent), or as children if intoParent.
 * @param {{ title: string, children: any[] }[]} trees
 */
function insertOutlineTrees(afterId, trees) {
  const after = getNode(afterId);
  if (!after || !isActive(after) || !trees.length) return;

  pushHistory();
  const parentId = after.parentId;
  /** @type {string[]} */
  const createdIds = [];

  const materialize = (tree, pId) => {
    const neu = createNode(tree.title, pId);
    doc.nodes[neu.id] = neu;
    createdIds.push(neu.id);
    if (pId) {
      getNode(pId).childIds.push(neu.id);
    } else {
      // root placement handled by caller for top-level only
    }
    for (const child of tree.children) materialize(child, neu.id);
    return neu.id;
  };

  if (parentId) {
    const parent = getNode(parentId);
    const idx = parent.childIds.indexOf(afterId);
    let insertAt = idx + 1;
    for (const tree of trees) {
      const neu = createNode(tree.title, parentId);
      doc.nodes[neu.id] = neu;
      createdIds.push(neu.id);
      parent.childIds.splice(insertAt, 0, neu.id);
      insertAt += 1;
      for (const child of tree.children) materialize(child, neu.id);
    }
  } else {
    const idx = doc.rootIds.indexOf(afterId);
    let insertAt = idx + 1;
    for (const tree of trees) {
      const neu = createNode(tree.title, null);
      doc.nodes[neu.id] = neu;
      createdIds.push(neu.id);
      doc.rootIds.splice(insertAt, 0, neu.id);
      insertAt += 1;
      for (const child of tree.children) materialize(child, neu.id);
    }
  }

  // If the target row was empty, remove it after paste
  if (!(after.title || "").trim() && !after.childIds.length && !after.note && after.dueAt == null) {
    detachNode(afterId);
    delete doc.nodes[afterId];
    if (doc.ui.zoomId === afterId) doc.ui.zoomId = null;
  }

  const first = createdIds[0];
  if (first) {
    selectNode(first);
    markEnter(createdIds);
    render();
    focusTitle(first, { selectAll: false });
  } else {
    render();
  }
  saveDoc();
}

function indentNode(id) {
  if (!canIndentOutlineNode(doc, id)) return;
  pushHistory();
  const result = indentUnderPreviousSibling(doc, { id });
  if (!result.changed) return;
  render();
  focusTitle(id);
  saveDoc();
}

function outdentNode(id) {
  if (!canOutdentOutlineNode(doc, id)) return;
  pushHistory();
  const result = outdentPreservingOutline(doc, { id });
  if (!result.changed) return;
  render();
  focusTitle(id);
  saveDoc();
}

function canIndentNode(id) {
  const n = getNode(id);
  const siblings = siblingList(id);
  return !!n && isActive(n) && doc.ui.tab === "active" && !!siblings && siblings.indexOf(id) > 0;
}

function canOutdentNode(id) {
  const n = getNode(id);
  return !!n && isActive(n) && doc.ui.tab === "active" && !!n.parentId;
}

function canReorderNode(id, delta) {
  const n = getNode(id);
  const siblings = siblingList(id);
  if (!n || !isActive(n) || doc.ui.tab !== "active" || !siblings) return false;
  const index = siblings.indexOf(id);
  return index >= 0 && index + delta >= 0 && index + delta < siblings.length;
}

function syncMobileMoveActions(n) {
  if (!el.mobileMoveActions) return;
  const movable = !!n && doc.ui.tab === "active" && isActive(n);
  el.mobileMoveActions.hidden = !movable;
  if (!movable) return;
  if (el.btnIndent) el.btnIndent.disabled = !canIndentNode(n.id);
  if (el.btnOutdent) el.btnOutdent.disabled = !canOutdentNode(n.id);
  if (el.btnMoveUp) el.btnMoveUp.disabled = !canReorderNode(n.id, -1);
  if (el.btnMoveDown) el.btnMoveDown.disabled = !canReorderNode(n.id, 1);
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

function clipTitle(title, max = 18) {
  const short = (title || t("untitled")).trim() || t("untitled");
  return {
    short,
    clipped: short.length > max ? `${short.slice(0, max)}…` : short,
  };
}

function captureRowTops(ids = currentVisibleIds()) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const id of ids) {
    const row = document.querySelector(`.row[data-id="${id}"]`);
    if (row) map.set(id, row.getBoundingClientRect().top);
  }
  return map;
}

/** @returns {Map<string, { top: number, height: number }>} root row id → .root-block box */
function captureRootBlocks() {
  /** @type {Map<string, { top: number, height: number }>} */
  const map = new Map();
  for (const block of document.querySelectorAll(".root-block")) {
    const root = block.querySelector(".row.is-root");
    if (!root?.dataset.id) continue;
    const rect = block.getBoundingClientRect();
    map.set(root.dataset.id, { top: rect.top, height: rect.height });
  }
  return map;
}

/** FLIP after layout change (reorder / collapse / drop). */
function animateReorder(beforeTops, beforeBlocks) {
  if (prefersReducedMotion()) return;

  /** @type {{ block: HTMLElement, nextHeight: number }[]} */
  const blockAnims = [];
  if (beforeBlocks?.size) {
    for (const block of document.querySelectorAll(".root-block")) {
      const root = block.querySelector(".row.is-root");
      if (!root?.dataset.id) continue;
      const prev = beforeBlocks.get(root.dataset.id);
      if (!prev) continue;
      const nextHeight = block.getBoundingClientRect().height;
      if (Math.abs(prev.height - nextHeight) < 1) continue;
      // Height transition moves following blocks in flow — no separate transform FLIP
      block.classList.add("is-height-animating");
      block.style.transition = "none";
      block.style.height = `${prev.height}px`;
      blockAnims.push({ block, nextHeight });
    }
  }

  /** @type {string[]} */
  const flippingIds = [];
  if (beforeTops?.size) {
    const ids = currentVisibleIds().filter((id) => beforeTops.has(id));
    for (const id of ids) {
      const row = document.querySelector(`.row[data-id="${id}"]`);
      if (!row) continue;
      // When a root-block height is animating, rows ride along in normal flow
      if (blockAnims.length && row.closest(".root-block")) continue;
      const prevTop = beforeTops.get(id);
      const nextTop = row.getBoundingClientRect().top;
      const dy = prevTop - nextTop;
      if (Math.abs(dy) < 1) continue;
      row.classList.add("is-flipping");
      row.style.transition = "none";
      row.style.transform = `translateY(${dy}px)`;
      flippingIds.push(id);
    }
  }

  if (!blockAnims.length && !flippingIds.length) return;
  void document.body.offsetHeight;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const { block, nextHeight } of blockAnims) {
        block.style.transition = "height 0.22s ease-out";
        block.style.height = `${nextHeight}px`;
      }
      for (const id of flippingIds) {
        const row = document.querySelector(`.row[data-id="${id}"]`);
        if (!row) continue;
        row.style.transition = "transform 0.22s ease-out";
        row.style.transform = "";
      }
      window.setTimeout(() => {
        for (const { block } of blockAnims) {
          block.classList.remove("is-height-animating");
          block.style.height = "";
          block.style.transition = "";
        }
        for (const id of flippingIds) {
          const row = document.querySelector(`.row[data-id="${id}"]`);
          if (!row) continue;
          row.classList.remove("is-flipping");
          row.style.transition = "";
          row.style.transform = "";
        }
      }, 240);
    });
  });
}

function markEnter(ids) {
  if (prefersReducedMotion()) return;
  for (const id of ids) pendingEnterIds.add(id);
}

function markExpandEnter(ids) {
  if (prefersReducedMotion()) return;
  for (const id of ids) pendingExpandEnterIds.add(id);
}

function applyPendingEnters() {
  const enterIds = prefersReducedMotion() ? [] : [...pendingEnterIds];
  const expandIds = prefersReducedMotion() ? [] : [...pendingExpandEnterIds];
  pendingEnterIds = new Set();
  pendingExpandEnterIds = new Set();
  if (!enterIds.length && !expandIds.length) return;

  requestAnimationFrame(() => {
    for (const id of enterIds) {
      const row = document.querySelector(`.row[data-id="${id}"]`);
      if (!row) continue;
      row.classList.add("is-enter");
      row.addEventListener("animationend", () => row.classList.remove("is-enter"), {
        once: true,
      });
    }
    for (const id of expandIds) {
      const row = document.querySelector(`.row[data-id="${id}"]`);
      if (!row) continue;
      // Don't mix with complete/restore enter
      row.classList.remove("is-enter");
      row.classList.add("is-expand-enter");
      row.addEventListener(
        "animationend",
        () => row.classList.remove("is-expand-enter"),
        { once: true }
      );
    }
  });
}

/**
 * Play exit animation on visible rows, then run `onDone`.
 * @param {string[]} ids
 * @param {() => void} onDone
 */
function withExitAnimation(ids, onDone) {
  const unique = [...new Set(ids)].filter((id) => getNode(id));
  if (!unique.length) {
    onDone();
    return;
  }
  if (unique.some((id) => animatingIds.has(id))) return;
  if (prefersReducedMotion()) {
    onDone();
    return;
  }

  const rows = unique
    .map((id) => document.querySelector(`.row[data-id="${id}"]`))
    .filter(Boolean);
  if (!rows.length) {
    onDone();
    return;
  }

  for (const id of unique) animatingIds.add(id);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const id of unique) animatingIds.delete(id);
    onDone();
  };

  for (const row of rows) row.classList.add("is-exit");
  // Wait for the first row's animation (they share duration)
  rows[0].addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, 220);
}

function dismissActionToast(immediate = false) {
  if (!actionToast) {
    el.toastHost.innerHTML = "";
    return;
  }
  clearTimeout(actionToast.timer);
  const toastEl = actionToast.el;
  actionToast = null;
  if (!toastEl) {
    el.toastHost.innerHTML = "";
    return;
  }
  if (immediate) {
    toastEl.remove();
    return;
  }
  toastEl.classList.add("is-leaving");
  const done = () => toastEl.remove();
  toastEl.addEventListener("animationend", done, { once: true });
  window.setTimeout(done, 280);
}

/**
 * @param {string} message
 * @param {(() => void) | null} [onUndo]
 */
function showActionToast(message, onUndo = null) {
  dismissActionToast(true);
  const toast = document.createElement("div");
  toast.className = "toast";
  const label = document.createElement("span");
  label.className = "toast-label";
  label.textContent = message;
  label.title = message;
  toast.appendChild(label);
  if (typeof onUndo === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = t("undo");
    btn.addEventListener("click", () => {
      onUndo();
      dismissActionToast();
    });
    toast.appendChild(btn);
  }
  el.toastHost.appendChild(toast);
  actionToast = {
    kind: "action",
    payload: null,
    el: toast,
    timer: window.setTimeout(() => dismissActionToast(), 5000),
  };
}

function showNoticeToast(message) {
  showActionToast(message, null);
}

/** Move among siblings (Ctrl+↑↓). Keeps depth / children. */
function reorderAmongSiblings(id, delta) {
  const n = getNode(id);
  if (!n || doc.ui.tab !== "active" || !canReorderOutlineNode(doc, id, delta)) return false;

  const mobile = isMobileSheet() && !el.mobileActiveSurface?.hidden;
  const beforeTops = mobile ? captureMobileRowTops() : captureRowTops();
  pushHistory();
  const result = reorderNodeByDelta(doc, { id, delta });
  if (!result.changed) return false;
  selectNode(id);
  render();
  if (mobile) animateMobileReorder(beforeTops);
  else animateReorder(beforeTops);
  if (!mobile) focusTitle(id, { selectAll: false });
  saveDoc();
  return true;
}

function captureMobileRowTops() {
  /** @type {Map<string, number>} */
  const map = new Map();
  el.mobileActiveList?.querySelectorAll(".mobile-task-row[data-id]").forEach((row) => {
    map.set(row.dataset.id, row.getBoundingClientRect().top);
  });
  return map;
}

function animateMobilePanelDismiss(element, { duration = 220, onDone } = {}) {
  if (!element || element.hidden || prefersReducedMotion()) {
    onDone?.();
    return;
  }
  element.classList.add("is-closing");
  const finish = () => {
    element.classList.remove("is-closing");
    onDone?.();
  };
  const onEnd = (event) => {
    if (event.target !== element) return;
    element.removeEventListener("animationend", onEnd);
    finish();
  };
  element.addEventListener("animationend", onEnd);
  window.setTimeout(finish, duration + 40);
}

function animateMobileReorder(beforeTops) {
  if (prefersReducedMotion() || !beforeTops?.size) return;
  /** @type {string[]} */
  const flippingIds = [];
  for (const [id, prevTop] of beforeTops) {
    const row = el.mobileActiveList?.querySelector(`.mobile-task-row[data-id="${id}"]`);
    if (!row) continue;
    const nextTop = row.getBoundingClientRect().top;
    const dy = prevTop - nextTop;
    if (Math.abs(dy) < 1) continue;
    row.classList.add("is-flipping");
    row.style.transition = "none";
    row.style.transform = `translateY(${dy}px)`;
    flippingIds.push(id);
  }
  if (!flippingIds.length) return;
  void document.body.offsetHeight;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const id of flippingIds) {
        const row = el.mobileActiveList?.querySelector(`.mobile-task-row[data-id="${id}"]`);
        if (!row) continue;
        row.style.transition = "transform 0.22s ease-out";
        row.style.transform = "";
      }
      window.setTimeout(() => {
        for (const id of flippingIds) {
          const row = el.mobileActiveList?.querySelector(`.mobile-task-row[data-id="${id}"]`);
          if (!row) continue;
          row.classList.remove("is-flipping");
          row.style.transition = "";
          row.style.transform = "";
        }
      }, 240);
    });
  });
}

function indentMobileNode(id) {
  if (!canIndentOutlineNode(doc, id)) return false;
  const beforeTops = captureMobileRowTops();
  pushHistory();
  const result = indentUnderPreviousSibling(doc, { id });
  if (!result.changed) return false;
  renderMobileActive();
  animateMobileReorder(beforeTops);
  saveDoc();
  return true;
}

function outdentMobileNode(id) {
  if (!canOutdentOutlineNode(doc, id)) return false;
  const beforeTops = captureMobileRowTops();
  pushHistory();
  const result = outdentPreservingOutline(doc, { id });
  if (!result.changed) return false;
  renderMobileActive();
  animateMobileReorder(beforeTops);
  saveDoc();
  return true;
}

function completeNode(id) {
  const n = doc.nodes[id];
  if (!n || !isActive(n)) return;
  if (isCategoryNode(n)) return;
  if (animatingIds.has(id)) return;
  const { clipped } = clipTitle(n.title);
  const completionTitle = n.title;
  const completionCategory = categoryRootOf(id)?.title || "";
  const visibleBeforeCompletion = currentVisibleIds();
  const completedIndex = visibleBeforeCompletion.indexOf(id);
  const selectAfterCompletion = completedIndex > 0 ? visibleBeforeCompletion[completedIndex - 1] : null;
  const affected = [id, ...collectDescendants(id)].filter((did) => isActive(getNode(did)));
  const affectedSetForMobile = new Set(affected);
  const mobileNavFallback =
    mobileUi.navRootId && affectedSetForMobile.has(mobileUi.navRootId)
      ? outlineAncestorChain(doc, mobileUi.navRootId)
          .slice(0, -1)
          .reverse()
          .find((node) => isActive(node) && !affectedSetForMobile.has(node.id))?.id || null
      : mobileUi.navRootId;

  withExitAnimation(affected, () => {
    if (!isActive(n)) return;
    pushHistory();
    const completedAt = now();
    const archivedNodes = affected
      .map((did) => doc.nodes[did])
      .filter(Boolean)
      .map((node) => ({ ...node, completedAt, childIds: [...(node.childIds || [])] }));
    const affectedSet = new Set(affected);
    for (const did of [...affected].sort((a, b) => depthOf(b) - depthOf(a))) {
      const node = doc.nodes[did];
      if (!node) continue;
      if (node.parentId && !affectedSet.has(node.parentId) && doc.nodes[node.parentId]) {
        doc.nodes[node.parentId].completedChildCount = Number(doc.nodes[node.parentId].completedChildCount || 0) + 1;
      }
      delete doc.nodes[did];
    }
    recordArchiveChange({ putNodes: archivedNodes, removeIds: [], removedNodes: [] });
    applyArchiveChange({ putNodes: archivedNodes, removeIds: [], removedNodes: [] });
    rangeIds = selectAfterCompletion && getNode(selectAfterCompletion) ? [selectAfterCompletion] : [];
    doc.selectedId = selectAfterCompletion && getNode(selectAfterCompletion) ? selectAfterCompletion : null;
    mobileUi.navRootId = mobileNavFallback;
    if (mobileUi.inlineEditor && affectedSet.has(mobileUi.inlineEditor.id)) mobileUi.inlineEditor = null;
    ensureZoomValid();
    ensureActiveRoot();
    render();
    focusSelectedTitleIfNeeded();
    saveDoc();
    if (!skipPersist) {
      void completionOutbox.enqueueCompletion({
        taskId: id,
        title: completionTitle,
        category: completionCategory,
      }).then(syncDiscordSettingsUi).catch(() => undefined);
    }
    showActionToast(t("toast.completed", { title: clipped }), () => {
      if (!skipPersist) void completionOutbox.cancelForTask(id).then(syncDiscordSettingsUi);
      restoreNode(id, { silent: true });
    });
  });
}

async function restoreNode(id, { silent = false } = {}) {
  const n = getNode(id);
  if (!n || !isCompleted(n)) return;
  if (animatingIds.has(id)) return;

  const records = await storage.getArchiveSubtree(id);
  if (!records.length) return;
  const revived = records.map((record) => ({
    ...record,
    completedAt: null,
    childIds: Array.isArray(record.childIds) ? [...record.childIds] : [],
    completedChildCount: 0,
  }));
  const revivedIds = new Set(revived.map((node) => node.id));

  const run = async () => {
    if (silent && !skipPersist) await completionOutbox.cancelForTask(id);
    pushHistory();
    for (const node of revived) {
      doc.nodes[node.id] = node;
      if (!node.parentId && !doc.rootIds.includes(node.id)) doc.rootIds.push(node.id);
      if (node.parentId && doc.nodes[node.parentId] && !revivedIds.has(node.parentId)) {
        doc.nodes[node.parentId].completedChildCount = Math.max(
          0,
          Number(doc.nodes[node.parentId].completedChildCount || 0) - 1
        );
      }
    }
    const change = { putNodes: [], removeIds: revived.map((node) => node.id), removedNodes: records };
    recordArchiveChange(change);
    await applyArchiveChange(change);
    doc.selectedId = id;
    rangeIds = [id];
    if (!silent) dismissActionToast();
    markEnter(revived.map((node) => node.id));
    render();
    focusSelectedTitleIfNeeded();
    saveDoc();
  };

  if (doc.ui.tab === "archive" && !silent) {
    const affected = revived.map((node) => node.id).filter((nodeId) => currentVisibleIds().includes(nodeId));
    withExitAnimation(affected, run);
    return;
  }
  run();
}

/**
 * Soft-delete with undo toast (no confirm). Snapshot is already in history via pushHistory.
 * @param {string[]} rootIdsToDelete
 */
async function deleteNodesWithUndo(rootIdsToDelete) {
  const roots = [...new Set(rootIdsToDelete)].filter((id) => getNode(id));
  if (!roots.length) return false;
  if (roots.some((id) => animatingIds.has(id))) return false;

  if (doc.ui.tab === "archive" && roots.some((id) => !doc.nodes[id])) {
    void deleteArchiveNodesWithUndo(roots);
    return true;
  }

  const archivedDescendants = [];
  if (doc.ui.tab === "active") {
    const seenArchivedIds = new Set();
    for (const rootId of roots) {
      for (const record of await storage.getArchiveDescendants(rootId)) {
        if (seenArchivedIds.has(record.id)) continue;
        seenArchivedIds.add(record.id);
        archivedDescendants.push(record);
      }
    }
  }

  const toRemove = new Set();
  for (const id of roots) {
    toRemove.add(id);
    for (const did of collectDescendants(id)) toRemove.add(did);
  }

  const labelId = roots[0];
  const { clipped } = clipTitle(getNode(labelId)?.title);
  const count = toRemove.size;
  const message =
    count > 1 ? t("toast.deletedMany", { title: clipped, count }) : t("toast.deleted", { title: clipped });

  const visibleBefore = currentVisibleIds();
  const exitIds = [...toRemove].filter((id) => visibleBefore.includes(id));

  withExitAnimation(exitIds, () => {
    pushHistory();
    // After pushHistory, undo() restores the pre-delete snapshot.
    const firstIdx = Math.min(
      ...[...toRemove].map((id) => visibleBefore.indexOf(id)).filter((i) => i >= 0),
      Infinity
    );

    for (const id of [...toRemove].sort((a, b) => depthOf(b) - depthOf(a))) {
      const n = getNode(id);
      if (!n) continue;
      if (!toRemove.has(n.parentId)) detachNode(id);
      delete doc.nodes[id];
    }

    if (archivedDescendants.length) {
      const change = {
        putNodes: [],
        removeIds: archivedDescendants.map((record) => record.id),
        removedNodes: archivedDescendants,
      };
      recordArchiveChange(change);
      applyArchiveChange(change);
    }

    if (doc.ui.zoomId && toRemove.has(doc.ui.zoomId)) doc.ui.zoomId = null;
    ensureZoomValid();
    ensureActiveRoot();
    const nextVisible = currentVisibleIds();
    const fallback =
      (Number.isFinite(firstIdx) && (nextVisible[firstIdx] || nextVisible[firstIdx - 1])) ||
      nextVisible[0] ||
      null;
    doc.selectedId = fallback;
    rangeIds = fallback ? [fallback] : [];
    rangeAnchorId = fallback;
    render();
    if (fallback && doc.ui.tab === "active") focusTitle(fallback, { selectAll: false });
    saveDoc();

    showActionToast(message, () => {
      undo();
    });
  });
  return true;
}

async function deleteArchiveNodesWithUndo(rootIdsToDelete) {
  const records = [];
  const seen = new Set();
  for (const rootId of rootIdsToDelete) {
    for (const record of await storage.getArchiveSubtree(rootId)) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
  }
  if (!records.length) return;

  const visibleBefore = currentVisibleIds();
  const exitIds = records.map((record) => record.id).filter((id) => visibleBefore.includes(id));
  const parentIds = new Map(
    rootIdsToDelete.map((rootId) => [rootId, getNode(rootId)?.parentId || null])
  );
  withExitAnimation(exitIds, () => {
    pushHistory();
    const change = { putNodes: [], removeIds: records.map((record) => record.id), removedNodes: records };
    recordArchiveChange(change);
    applyArchiveChange(change);
    for (const [rootId, parentId] of parentIds) {
      if (parentId && doc.nodes[parentId]) {
        doc.nodes[parentId].childIds = doc.nodes[parentId].childIds.filter((id) => id !== rootId);
      }
    }
    const nextVisible = currentVisibleIds();
    const fallback = nextVisible[0] || null;
    doc.selectedId = fallback;
    rangeIds = fallback ? [fallback] : [];
    rangeAnchorId = fallback;
    render();
    saveDoc();
    showActionToast(t("toast.deleted", { title: records[0].title || t("untitled") }), () => undo());
  });
}

function deleteNode(id) {
  if (!getNode(id)) return;
  deleteNodesWithUndo([id]);
}

function toggleCollapse(id) {
  const n = getNode(id);
  if (!n) return;
  const hasKids =
    doc.ui.tab === "active"
      ? activeChildrenOf(id).length > 0
      : archiveLoadedChildrenOf(id).some((c) => archiveState.displayIds.has(c.id));
  if (!hasKids) return;
  const beforeBlockHeights = captureRootBlocks();
  pushHistory();
  n.collapsed = !n.collapsed;
  render();
  // 行FLIP＋展開フェードは高さアニメとぶつかってがたつくので、枠の高さだけ動かす
  animateReorder(null, beforeBlockHeights);
  saveDoc();
}

function moveSelection(delta) {
  const ids = currentVisibleIds();
  if (!ids.length) return;
  const cur = doc.selectedId;
  let idx = ids.indexOf(cur);
  if (idx < 0) idx = 0;
  else idx = Math.max(0, Math.min(ids.length - 1, idx + delta));
  selectNode(ids[idx]);
  if (doc.ui.tab === "active") focusTitle(ids[idx], { selectAll: false });
}

function handleArrowLeft() {
  const id = doc.selectedId;
  const n = getNode(id);
  if (!n) return;
  const hasKids =
    doc.ui.tab === "active"
      ? activeChildrenOf(id).length > 0
      : archiveLoadedChildrenOf(id).some((c) => archiveState.displayIds.has(c.id));
  if (hasKids && !n.collapsed) {
    toggleCollapse(id);
    return;
  }
  if (n.parentId) {
    const parent = getNode(n.parentId);
    if (!parent) return;
    if (doc.ui.tab === "active" && !isActive(parent)) return;
    selectNode(parent.id);
    if (doc.ui.tab === "active") focusTitle(parent.id, { selectAll: false });
  }
}

function handleArrowRight() {
  const id = doc.selectedId;
  const n = getNode(id);
  if (!n) return;
  const kids =
    doc.ui.tab === "active"
      ? activeChildrenOf(id)
      : archiveLoadedChildrenOf(id).filter((c) => archiveState.displayIds.has(c.id));
  if (kids.length && n.collapsed) {
    toggleCollapse(id);
    return;
  }
  if (kids.length) {
    selectNode(kids[0].id);
    if (doc.ui.tab === "active") focusTitle(kids[0].id, { selectAll: false });
  }
}

function selectedIdsForCopy() {
  if (rangeIds.length) return rangeIds;
  if (doc.selectedId) return [doc.selectedId];
  return [];
}

function selectAllVisibleRows() {
  const ids = currentVisibleIds();
  if (!ids.length) return;
  rangeAnchorId = ids[0];
  rangeIds = [...ids];
  doc.selectedId = ids[ids.length - 1];
  syncSelectionClasses();
  renderDetail();
  saveDoc();
  focusSelectedTitleIfNeeded({ force: true });
}

function toMarkdown(ids) {
  const lines = [];
  for (const id of ids) {
    const n = getNode(id);
    if (!n) continue;
    lines.push({ depth: depthOf(id), title: n.title || "" });
  }
  if (!lines.length) return "";
  const min = Math.min(...lines.map((l) => l.depth));
  return lines.map((l) => `${"  ".repeat(l.depth - min)}- ${l.title}`).join("\n");
}

function setPlainTextMode(on) {
  const next = !!on;
  if (next === !!doc.ui.plainTextMode) return;
  doc.ui.plainTextMode = next;
  closeAllToolPops();
  render();
  saveDoc();
}

async function copySelectionMarkdown() {
  const md = toMarkdown(selectedIdsForCopy());
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = md;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function focusTitle(id, { selectAll = true } = {}) {
  if (isMobileSheet()) return;
  requestAnimationFrame(() => {
    const input = document.querySelector(`.title-input[data-id="${id}"]`);
    if (!input) return;
    input.focus();
    if (selectAll) input.select();
    else {
      const len = input.value.length;
      input.setSelectionRange(len, len);
    }
    input.closest(".row")?.scrollIntoView({ block: "nearest" });
  });
}

function focusSelectedTitleIfNeeded({ force = false } = {}) {
  if (isMobileSheet() || doc.ui.tab !== "active" || !doc.selectedId) return;
  const active = document.activeElement;
  if (!force && active?.matches?.("input, textarea, select, [contenteditable=\"true\"]")) return;
  focusTitle(doc.selectedId, { selectAll: false });
}

function syncSelectionClasses() {
  const selected = new Set(rangeIds.length ? rangeIds : doc.selectedId ? [doc.selectedId] : []);
  document.querySelectorAll(".row").forEach((row) => {
    const id = row.dataset.id;
    row.classList.toggle("is-selected", id === doc.selectedId);
    row.classList.toggle("is-range", selected.has(id));
  });
}

function resetDnd() {
  dnd = {
    dragId: null,
    parentId: null,
    index: 0,
    mode: null,
    overId: null,
    active: false,
  };
  clearDropIndicators();
}

function clearDropIndicators() {
  document.querySelectorAll(".row").forEach((row) => {
    row.classList.remove("is-drop-before", "is-drop-after", "is-drop-into", "is-dragging");
    row.style.removeProperty("--drop-bar-depth");
  });
}

function createMobileDragGhost(row, rect) {
  const ghost = row.cloneNode(true);
  ghost.classList.remove("is-dragging", "is-selected", "is-range");
  ghost.classList.add("mobile-drag-ghost");
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;

  const sourceTitle = row.querySelector(".title-input");
  const ghostTitle = ghost.querySelector(".title-input");
  if (sourceTitle && ghostTitle) ghostTitle.value = sourceTitle.value;
  const sourceMirror = row.querySelector(".title-mirror");
  const ghostMirror = ghost.querySelector(".title-mirror");
  if (sourceMirror && ghostMirror) ghostMirror.textContent = sourceMirror.textContent;

  document.body.appendChild(ghost);
  return ghost;
}

function bindMobileRowDrag(row, n) {
  if (doc.ui.activeSort === "due-asc") return;

  /** @type {{ pointerId: number, startX: number, startY: number, lastX: number, lastY: number, dragging: boolean } | null} */
  let ptr = null;
  let holdTimer = 0;
  let ghost = null;

  const clearHold = () => {
    if (!holdTimer) return;
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  };

  const paintFromY = (clientY) => {
    const target = resolveDropTarget(clientY);
    if (!target) {
      dnd.active = false;
      dnd.parentId = null;
      dnd.index = 0;
      dnd.mode = null;
      dnd.overId = null;
      clearDropIndicators();
      document.querySelector(`.row[data-id="${dnd.dragId}"]`)?.classList.add("is-dragging");
      return;
    }
    dnd.active = true;
    paintDropTarget(target);
  };

  const autoScrollOutline = (clientY) => {
    const outline = el.activeOutline;
    if (!outline) return;
    const rect = outline.getBoundingClientRect();
    const edge = 48;
    if (clientY < rect.top + edge) outline.scrollTop -= 14;
    else if (clientY > rect.bottom - edge) outline.scrollTop += 14;
  };

  const startDrag = () => {
    if (!ptr || ptr.dragging) return;
    ptr.dragging = true;
    dnd.dragId = n.id;
    dnd.active = false;
    dnd.parentId = null;
    dnd.index = 0;
    dnd.mode = null;
    dnd.overId = null;
    if (doc.selectedId || rangeIds.length) {
      clearSelection();
      sheetLevel = "closed";
      syncSheetUi();
      syncSelectionClasses();
    }
    document.getSelection?.()?.removeAllRanges();
    row.classList.add("is-dragging");
    document.body.classList.add("is-pointer-dragging");
    try {
      row.setPointerCapture?.(ptr.pointerId);
    } catch {
      // The pointer may have been cancelled between the timer and capture.
    }
    ghost = createMobileDragGhost(row, row.getBoundingClientRect());
    navigator.vibrate?.(14);
  };

  row.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest?.("button, input, textarea, select, a")) return;
    clearHold();
    ptr = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      dragging: false,
    };
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      if (!ptr || Math.hypot(ptr.lastX - ptr.startX, ptr.lastY - ptr.startY) > 10) return;
      startDrag();
    }, 440);
  });

  row.addEventListener("pointermove", (e) => {
    if (!ptr || e.pointerId !== ptr.pointerId) return;
    ptr.lastX = e.clientX;
    ptr.lastY = e.clientY;
    if (!ptr.dragging) {
      if (Math.hypot(e.clientX - ptr.startX, e.clientY - ptr.startY) > 10) {
        clearHold();
        ptr = null;
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    autoScrollOutline(e.clientY);
    if (ghost) {
      ghost.style.transform = `translate3d(${e.clientX - ptr.startX}px, ${e.clientY - ptr.startY}px, 0)`;
    }
    paintFromY(e.clientY);
  });

  const finishDrag = (e) => {
    if (!ptr || e.pointerId !== ptr.pointerId) return;
    const wasDragging = ptr.dragging;
    clearHold();
    ptr = null;
    if (!wasDragging) return;
    e.preventDefault();
    e.stopPropagation();
    suppressRowClickUntil = performance.now() + 300;
    document.body.classList.remove("is-pointer-dragging");
    ghost?.remove();
    ghost = null;
    if (dnd.active && dnd.dragId) applyDrop();
    else resetDnd();
  };

  row.addEventListener("pointerup", finishDrag);
  row.addEventListener("pointercancel", (e) => {
    if (!ptr || e.pointerId !== ptr.pointerId) return;
    const wasDragging = ptr.dragging;
    clearHold();
    ptr = null;
    if (!wasDragging) return;
    document.body.classList.remove("is-pointer-dragging");
    ghost?.remove();
    ghost = null;
    resetDnd();
  });
  row.addEventListener("contextmenu", (e) => {
    if (isMobileSheet()) e.preventDefault();
  });
}

/**
 * Standard tree DnD (Notion / VS Code style):
 * - top of row  → sibling before
 * - middle      → child of that row (highlight)
 * - bottom      → sibling after
 * Hovering the dragged row (or its descendants) = no drop target.
 */
function resolveDropTarget(clientY) {
  const dragId = dnd.dragId;
  if (!dragId) return null;
  const drag = getNode(dragId);
  if (!drag || !isActive(drag)) return null;

  const outline = el.activeOutline;
  const allVisible = visibleActiveIds();
  const allRows = allVisible
    .map((id) => ({ id, el: outline.querySelector(`.row[data-id="${id}"]`) }))
    .filter((x) => x.el);

  if (!allRows.length) return null;

  // Hit-test including the dragged row, so "drop on self" doesn't snap elsewhere.
  let hit = null;
  for (const row of allRows) {
    const rect = row.el.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      hit = { id: row.id, el: row.el, rect };
      break;
    }
  }

  if (!hit) {
    // Only snap when clearly above the first or below the last row.
    const firstRect = allRows[0].el.getBoundingClientRect();
    const lastRect = allRows[allRows.length - 1].el.getBoundingClientRect();
    if (clientY < firstRect.top) {
      hit = { id: allRows[0].id, el: allRows[0].el, rect: firstRect };
      // force before
      return dropAsSibling(hit.id, "before");
    }
    if (clientY > lastRect.bottom) {
      hit = { id: allRows[allRows.length - 1].id, el: allRows[allRows.length - 1].el, rect: lastRect };
      return dropAsSibling(hit.id, "after");
    }
    // In a gap between rows: pick the closer edge of the nearest row
    let best = null;
    let bestDist = Infinity;
    for (const row of allRows) {
      const rect = row.el.getBoundingClientRect();
      const mid = (rect.top + rect.bottom) / 2;
      const dist = Math.abs(clientY - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = { id: row.id, el: row.el, rect };
      }
    }
    if (!best) return null;
    hit = best;
  }

  // Dropping onto self / own subtree: ignore (keep current position)
  if (hit.id === dragId || isAncestor(dragId, hit.id)) return null;

  const over = getNode(hit.id);
  if (!over || !isActive(over)) return null;

  // When a child is dragged back onto its own parent, the intended target is
  // the first position inside that parent. Treating the parent row as a
  // normal sibling target would move the child out one level, which is
  // especially surprising when dropping just above the parent's row.
  if (over.id === drag.parentId) {
    return { parentId: over.id, index: 0, mode: "into", overId: over.id };
  }

  const ratio = (clientY - hit.rect.top) / Math.max(hit.rect.height, 1);
  /** @type {'before' | 'after' | 'into'} */
  let mode;
  if (ratio < 0.25) mode = "before";
  else if (ratio > 0.75) mode = "after";
  else mode = "into";

  if (mode === "into") {
    return { parentId: hit.id, index: over.childIds.length, mode, overId: hit.id };
  }
  return dropAsSibling(hit.id, mode);
}

/** @param {string} overId @param {'before' | 'after'} mode @param {string | null} [dragId] */
function dropAsSibling(overId, mode, dragId = dnd.dragId) {
  if (!dragId) return null;
  if (overId === dragId || isAncestor(dragId, overId)) return null;
  const over = getNode(overId);
  if (!over || !isActive(over)) return null;

  const parentId = over.parentId;
  const list = parentId ? getNode(parentId)?.childIds : doc.rootIds;
  if (!list) return null;
  const overPos = list.indexOf(overId);
  if (overPos < 0) return null;
  return {
    parentId,
    index: mode === "before" ? overPos : overPos + 1,
    mode,
    overId,
  };
}

function paintDropTarget(target) {
  clearDropIndicators();
  if (!target || !dnd.dragId) return;
  document.querySelector(`.row[data-id="${dnd.dragId}"]`)?.classList.add("is-dragging");

  if (target.overId) {
    const row = document.querySelector(`.row[data-id="${target.overId}"]`);
    if (row) {
      if (target.mode === "into") {
        row.classList.add("is-drop-into");
      } else {
        // Bar indent matches the sibling level being dropped into
        const barDepth =
          target.parentId == null ? 0 : depthOf(target.parentId) + 1;
        row.style.setProperty("--drop-bar-depth", String(barDepth));
        if (target.mode === "before") row.classList.add("is-drop-before");
        else if (target.mode === "after") row.classList.add("is-drop-after");
      }
    }
  }

  dnd.parentId = target.parentId;
  dnd.index = target.index;
  dnd.mode = target.mode;
  dnd.overId = target.overId;
}

function applyDrop() {
  const dragId = dnd.dragId;
  const parentId = dnd.parentId;
  const index = dnd.index;
  const hadTarget = dnd.active && dragId;
  resetDnd();
  if (!hadTarget || !dragId) return;
  relocateActiveNode(dragId, parentId, index);
}

/**
 * Move an active node in the outline tree.
 * @param {string} dragId
 * @param {string | null} parentId
 * @param {number} index
 */
function relocateActiveNode(dragId, parentId, index) {
  const drag = getNode(dragId);
  if (!drag || !canMoveOutlineNode(doc, dragId, parentId)) return false;

  const oldParent = drag.parentId;
  const oldList = outlineSiblingList(doc, dragId);
  const oldIndex = oldList ? oldList.indexOf(dragId) : -1;

  let nextIndex = index;
  if (oldParent === parentId && oldIndex === nextIndex) return false;
  if (oldParent === parentId && oldIndex >= 0 && nextIndex === oldIndex + 1) return false;

  const beforeTops = captureRowTops();
  pushHistory();
  const result = moveOutlineNode(doc, { id: dragId, parentId, index: nextIndex });
  if (!result.changed) return false;

  selectNode(dragId);
  render();
  animateReorder(beforeTops);
  focusTitle(dragId, { selectAll: false });
  saveDoc();
  return true;
}

function bindDrag(row, n) {
  if (doc.ui.tab !== "active" || !isActive(n)) return;
  if (isMobileSheet()) {
    bindMobileRowDrag(row, n);
    return;
  }
  const handle = row.querySelector(".drag-handle");
  if (!handle) return;

  // Pointer DnD on all viewports. HTML5 DnD on <button> is unreliable in Chromium.
  handle.draggable = false;

  /** @type {{ pointerId: number, startX: number, startY: number, dragging: boolean } | null} */
  let ptr = null;

  const paintFromY = (clientY) => {
    const target = resolveDropTarget(clientY);
    if (!target) {
      dnd.active = false;
      dnd.parentId = null;
      dnd.index = 0;
      dnd.mode = null;
      dnd.overId = null;
      clearDropIndicators();
      document.querySelector(`.row[data-id="${dnd.dragId}"]`)?.classList.add("is-dragging");
      return;
    }
    dnd.active = true;
    paintDropTarget(target);
  };

  const autoScrollOutline = (clientY) => {
    const outline = el.activeOutline;
    if (!outline) return;
    const rect = outline.getBoundingClientRect();
    const edge = 48;
    if (clientY < rect.top + edge) outline.scrollTop -= 14;
    else if (clientY > rect.bottom - edge) outline.scrollTop += 14;
  };

  handle.addEventListener("pointerdown", (e) => {
    if (doc.ui.activeSort === "due-asc") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    ptr = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
    };
    handle.setPointerCapture?.(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!ptr || e.pointerId !== ptr.pointerId) return;
    const dx = e.clientX - ptr.startX;
    const dy = e.clientY - ptr.startY;
    if (!ptr.dragging) {
      if (Math.hypot(dx, dy) < 6) return;
      ptr.dragging = true;
      dnd.dragId = n.id;
      dnd.active = false;
      if (doc.selectedId || rangeIds.length) {
        clearSelection();
        sheetLevel = "closed";
        syncSheetUi();
        syncSelectionClasses();
      }
      row.classList.add("is-dragging");
      document.body.classList.add("is-pointer-dragging");
    }
    e.preventDefault();
    autoScrollOutline(e.clientY);
    paintFromY(e.clientY);
  });

  const endPointerDrag = (e) => {
    if (!ptr || e.pointerId !== ptr.pointerId) return;
    const wasDragging = ptr.dragging;
    ptr = null;
    document.body.classList.remove("is-pointer-dragging");
    if (!wasDragging) {
      resetDnd();
      return;
    }
    if (dnd.active && dnd.dragId) applyDrop();
    else resetDnd();
  };

  handle.addEventListener("pointerup", endPointerDrag);
  handle.addEventListener("pointercancel", endPointerDrag);
}

/**
 * @param {Node} n
 * @param {{ displayDepth?: number, contextParent?: boolean, showCompletedMeta?: boolean, showDueMeta?: boolean, isZoomRoot?: boolean }} opts
 */
function renderRow(n, opts = {}) {
  const displayDepth = opts.displayDepth ?? depthOf(n.id);
  const contextParent = !!opts.contextParent;
  const showCompletedMeta = !!opts.showCompletedMeta;
  const showDueMeta = !!opts.showDueMeta;
  const isZoomRoot = !!opts.isZoomRoot;

  const kidsActive = activeChildrenOf(n.id);
  const kidsArchive = doc.ui.tab === "archive"
    ? archiveLoadedChildrenOf(n.id).filter((c) => archiveState.displayIds.has(c.id))
    : childrenOf(n.id).filter((c) => subtreeHasCompleted(c.id));
  const dueSort = doc.ui.tab === "active" && doc.ui.activeSort === "due-asc";
  const dueKeepTree = dueSort && !!doc.ui.dueKeepTree;
  const dueFlat = dueSort && !dueKeepTree;
  const plainText = doc.ui.tab === "active" && !!doc.ui.plainTextMode;
  const asCategory = isCategoryNode(n);
  let hasKids = false;
  if (doc.ui.tab === "active") {
    if (dueFlat && !asCategory) hasKids = false;
    else if (dueFlat && asCategory) hasKids = kidsActive.some((c) => subtreeHasDueSortMatch(c.id));
    else if (dueSort) hasKids = kidsActive.some((c) => subtreeHasDueSortMatch(c.id));
    else hasKids = kidsActive.length > 0;
  } else {
    hasKids = kidsArchive.length > 0;
  }
  const progress = doc.ui.tab === "archive"
    ? (kidsArchive.length ? { done: kidsArchive.filter(isCompleted).length, total: kidsArchive.length } : null)
    : (childrenOf(n.id).length || n.completedChildCount ? childProgress(n.id) : null);
  const progressMode = normalizeProgressMode(doc.ui.progressMode);
  const hideThisProgress = progressMode === "off" || asCategory;
  const showProgress =
    !hideThisProgress &&
    !dueFlat &&
    !plainText &&
    progress &&
    progress.total > 0 &&
    (doc.ui.tab === "active" || contextParent || isCompleted(n));

  const row = document.createElement("div");
  row.className = "row";
  // 期限順の葉はルート強調しない。カテゴリーは期限順でも枠付きルート。
  if (displayDepth === 0) {
    if (asCategory) row.classList.add("is-root");
    else if (!dueFlat && !(dueSort && !hasKids)) row.classList.add("is-root");
  }
  if (dueFlat && !asCategory) row.classList.add("is-due-flat");
  if ((!hasKids || (dueFlat && !asCategory))) row.classList.add("is-leaf");
  if (contextParent) row.classList.add("is-context-parent");
  if (isZoomRoot) row.classList.add("is-zoom-root");
  row.dataset.id = n.id;
  row.dataset.depth = String(displayDepth);
  row.style.setProperty("--depth", String(displayDepth));
  if (n.id === doc.selectedId) row.classList.add("is-selected");
  if (rangeIds.includes(n.id)) row.classList.add("is-range");

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.tabIndex = -1;
  handle.textContent = "⠿";
  handle.title = t("drag");
  if (doc.ui.tab !== "active" || contextParent || !isActive(n) || dueSort) {
    handle.style.visibility = "hidden";
  }

  /** @type {HTMLButtonElement | HTMLSpanElement | null} */
  let toggle = null;
  if (hasKids) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "toggle";
    toggle.tabIndex = -1;
    toggle.textContent = n.collapsed ? "▶" : "▼";
    toggle.title = n.collapsed ? t("expand") : t("collapse");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse(n.id);
    });
  } else if (plainText) {
    // テキストモード: ガター列を揃える（箇条書き記号は本文側）
    toggle = document.createElement("span");
    toggle.className = "toggle toggle-spacer";
    toggle.setAttribute("aria-hidden", "true");
  } else if (dueSort) {
    toggle = document.createElement("span");
    toggle.className = "toggle leaf-mark";
    toggle.setAttribute("aria-hidden", "true");
    toggle.textContent = "・";
  } else if (doc.ui.tab === "archive") {
    toggle = document.createElement("span");
    toggle.className = "toggle toggle-spacer";
    toggle.setAttribute("aria-hidden", "true");
  }

  const titleCell = document.createElement("div");
  titleCell.className = plainText ? "plain-text-line" : "title-cell";
  if (showProgress) titleCell.classList.add("has-progress");

  if (plainText) {
    const prefix = document.createElement("span");
    prefix.className = "plain-prefix";
    prefix.setAttribute("aria-hidden", "true");
    prefix.textContent = "- ";
    titleCell.appendChild(prefix);
  }

  const titleGrow = document.createElement("div");
  titleGrow.className = "title-grow";

  const mirror = document.createElement("span");
  mirror.className = "title-mirror";
  mirror.setAttribute("aria-hidden", "true");
  mirror.textContent = n.title || t("untitled");

  const titleWrap = !!doc.ui.titleWrap;
  /** @type {HTMLInputElement | HTMLTextAreaElement} */
  const title = document.createElement(titleWrap ? "textarea" : "input");
  title.className = "title-input";
  if (!titleWrap) {
    /** @type {HTMLInputElement} */ (title).type = "text";
  } else {
    /** @type {HTMLTextAreaElement} */ (title).rows = 1;
  }
  title.value = n.title;
  title.dataset.id = n.id;
  title.placeholder = t("untitled");
  title.readOnly = doc.ui.tab === "archive" || contextParent || isMobileSheet();
  if (isMobileSheet()) title.tabIndex = -1;
  title.addEventListener("focus", () => {
    if (rangeIds.length > 1 && rangeIds.includes(n.id)) {
      doc.selectedId = n.id;
      syncSelectionClasses();
      renderDetail();
      saveDoc();
    } else if (doc.selectedId !== n.id) {
      selectNode(n.id);
    }
  });
  title.addEventListener("blur", () => endCoalesce());
  title.addEventListener("mousedown", (e) => {
    if (e.shiftKey) {
      e.preventDefault();
      selectNode(n.id, { extend: true });
    }
  });
  title.addEventListener("input", () => {
    beginCoalesce();
    if (titleWrap && /\n/.test(title.value)) {
      const pos = title.selectionStart ?? title.value.length;
      title.value = title.value.replace(/\n/g, "");
      const next = Math.min(pos, title.value.length);
      title.setSelectionRange(next, next);
    }
    n.title = title.value;
    mirror.textContent = title.value || t("untitled");
    if (doc.selectedId === n.id) el.detailTitle.value = n.title;
    saveDoc();
  });
  title.addEventListener("keydown", onTitleKeydown);
  title.addEventListener("paste", onTitlePaste);
  titleGrow.append(mirror, title);

  const submeta = document.createElement("div");
  submeta.className = "row-submeta";
  if (!contextParent && showCompletedMeta && n.completedAt != null) {
    submeta.textContent = t("completedStamp", { date: formatDateCompact(n.completedAt) });
    submeta.classList.add("is-completed");
  } else if (!contextParent && showDueMeta && n.dueAt != null) {
    submeta.textContent = t("dueStamp", { date: formatDateCompact(n.dueAt) });
    submeta.classList.add("is-due");
    if (isDueOverdue(n.dueAt)) submeta.classList.add("is-overdue");
    else if (isDueToday(n.dueAt)) submeta.classList.add("is-today");
  } else {
    submeta.hidden = true;
  }

  const titleStack = document.createElement("div");
  titleStack.className = "title-stack";
  titleStack.append(titleGrow, submeta);
  titleCell.appendChild(titleStack);

  if ((n.note || "").trim()) {
    titleCell.classList.add("has-note");
    titleCell.appendChild(createNoteIndicator());
  }

  if (isMobileSheet() && doc.ui.tab === "archive" && isCompleted(n) && !contextParent) {
    titleCell.classList.add("has-mobile-restore");
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "mobile-archive-restore-btn";
    restoreBtn.setAttribute("aria-label", t("restore"));
    restoreBtn.title = t("restore");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M9 7H5v4M5 11a7 7 0 1 0 2-4.9");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    icon.appendChild(path);
    restoreBtn.appendChild(icon);
    restoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      restoreNode(n.id);
    });
    titleCell.appendChild(restoreBtn);
  }

  if (showProgress) {
    const pct = Math.round((progress.done / progress.total) * 100);
    const prog = document.createElement("span");
    prog.className = "progress-wrap";
    prog.title = t("progressTitle", { done: progress.done, total: progress.total });
    const gauge = document.createElement("span");
    gauge.className = "progress-gauge";
    gauge.setAttribute("aria-hidden", "true");
    const fill = document.createElement("span");
    fill.className = "progress-fill";
    fill.style.width = `${pct}%`;
    if (pct >= 100) fill.classList.add("is-done");
    gauge.appendChild(fill);
    const label = document.createElement("span");
    label.className = "progress-label";
    label.textContent = `${progress.done}/${progress.total}`;
    prog.append(gauge, label);
    titleCell.appendChild(prog);
  }

  const meta = document.createElement("div");
  meta.className = "row-meta";

  if (!contextParent && showCompletedMeta && n.completedAt != null) {
    const stamp = document.createElement("span");
    stamp.className = "date-stamp is-completed";
    const tag = document.createElement("span");
    tag.className = "date-stamp-tag";
    tag.textContent = t("done");
    const val = document.createElement("span");
    val.className = "date-stamp-val";
    val.textContent = formatDate(n.completedAt);
    stamp.append(tag, val);
    meta.appendChild(stamp);
  } else if (!contextParent && showDueMeta && n.dueAt != null) {
    const stamp = document.createElement("span");
    stamp.className = "date-stamp is-due";
    if (isDueOverdue(n.dueAt)) stamp.classList.add("is-overdue");
    else if (isDueToday(n.dueAt)) stamp.classList.add("is-today");
    const tag = document.createElement("span");
    tag.className = "date-stamp-tag";
    tag.textContent = t("due");
    const val = document.createElement("span");
    val.className = "date-stamp-val";
    val.textContent = formatDateShort(n.dueAt);
    stamp.append(tag, val);
    meta.appendChild(stamp);
  }

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = `done-btn${isCompleted(n) ? " is-restore" : ""}`;
  doneBtn.tabIndex = -1;
  if (contextParent || (isCategoryNode(n) && !isCompleted(n))) {
    doneBtn.style.visibility = "hidden";
  } else {
    doneBtn.textContent = isCompleted(n) ? t("restore") : t("done");
    doneBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isCompleted(n)) restoreNode(n.id);
      else completeNode(n.id);
    });
  }

  if (toggle) row.append(handle, toggle, titleCell, meta, doneBtn);
  else row.append(handle, titleCell, meta, doneBtn);
  if (plainText) row.classList.add("is-plain-row");
  row.addEventListener("click", (e) => {
    if (performance.now() < suppressRowClickUntil) return;
    if (e.target === title || e.target === toggle || e.target === doneBtn || e.target === handle) return;
    if (e.target.closest?.(".leaf-mark")) return;
    if (e.target.closest?.(".plain-prefix")) return;
    if (e.target.closest?.(".progress-wrap")) return;
    selectNode(n.id, { extend: e.shiftKey });
    if (!isMobileSheet() && doc.ui.tab === "active" && isActive(n)) {
      focusTitle(n.id, { selectAll: false });
    }
  });
  row.addEventListener("dblclick", (e) => {
    if (isMobileSheet()) return;
    if (doc.ui.tab !== "active" || !isActive(n) || contextParent) return;
    if (e.target === handle || e.target === doneBtn || e.target === toggle) return;
    if (e.target.closest?.(".progress-wrap")) return;
    // Zoom on double-click of row chrome / title with Alt
    if (e.altKey || e.target !== title) {
      e.preventDefault();
      setZoom(n.id);
    }
  });

  bindDrag(row, n);
  return row;
}

function createNoteIndicator() {
  const noteIndicator = document.createElement("span");
  noteIndicator.className = "note-indicator";
  noteIndicator.title = t("detail.note");
  noteIndicator.setAttribute("aria-label", t("detail.note"));

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const sheet = document.createElementNS("http://www.w3.org/2000/svg", "path");
  sheet.setAttribute("d", "M6 3.75h8.5L19 8.25v12H6zM14.5 3.75v4.5H19M9 12h6M9 15h6");
  icon.appendChild(sheet);
  noteIndicator.appendChild(icon);
  return noteIndicator;
}

function renderZoomBar() {
  if (!el.zoomBar) return;
  const zoomId = doc.ui.zoomId;
  const show = doc.ui.tab === "active" && !!zoomId && !!getNode(zoomId);
  el.zoomBar.hidden = !show;
  if (!show) {
    el.zoomCrumbs.innerHTML = "";
    return;
  }
  el.zoomCrumbs.innerHTML = "";
  const chain = ancestorChain(zoomId);
  chain.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "zoom-sep";
      sep.textContent = "/";
      el.zoomCrumbs.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zoom-crumb";
    if (i === chain.length - 1) btn.classList.add("is-current");
    btn.textContent = (node.title || t("untitled")).trim() || t("untitled");
    btn.title = btn.textContent;
    btn.addEventListener("click", () => {
      if (i === chain.length - 1) return;
      if (i === 0 && !node.parentId) {
        // clicking top ancestor zooms to that node (or root if already top)
        pushHistory();
        doc.ui.zoomId = node.id;
        render();
        saveDoc();
        return;
      }
      pushHistory();
      doc.ui.zoomId = node.id;
      render();
      saveDoc();
    });
    el.zoomCrumbs.appendChild(btn);
  });
}

function closeToolPopLeaf(pop) {
  if (!pop) return;
  const btn = pop.querySelector(":scope > .tool-icon-btn");
  const panel = pop.querySelector(":scope > .tool-panel");
  if (btn) btn.setAttribute("aria-expanded", "false");
  // topbar actions stay visible on desktop; mobile hides via .is-open CSS
  if (panel && !panel.classList.contains("tool-panel--topbar")) panel.hidden = true;
  pop.classList.remove("is-open");
}

function closeAllToolPops({ except = null } = {}) {
  for (const pop of document.querySelectorAll(".tool-pop")) {
    if (except && (pop === except || pop.contains(except))) continue;
    closeToolPopLeaf(pop);
  }
}

function toggleToolPop(pop) {
  if (!pop) return;
  const willOpen = !pop.classList.contains("is-open");
  if (!willOpen) {
    closeToolPopLeaf(pop);
    for (const child of pop.querySelectorAll(".tool-pop")) closeToolPopLeaf(child);
    return;
  }
  closeAllToolPops({ except: pop });
  const btn = pop.querySelector(":scope > .tool-icon-btn");
  const panel = pop.querySelector(":scope > .tool-panel");
  pop.classList.add("is-open");
  if (btn) btn.setAttribute("aria-expanded", "true");
  if (panel && !panel.classList.contains("tool-panel--topbar")) panel.hidden = false;
}

function setInlineSearchOpen(wrap, open) {
  if (!wrap) return;
  const btn = wrap.querySelector(".tool-icon-btn");
  const input = wrap.querySelector(".inline-search-input");
  wrap.classList.toggle("is-open", open);
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (input) {
    input.tabIndex = open ? 0 : -1;
    if (open) requestAnimationFrame(() => input.focus());
  }
}

function closeInlineSearches({ except = null } = {}) {
  for (const wrap of document.querySelectorAll(".inline-search")) {
    if (except && wrap === except) continue;
    const input = wrap.querySelector(".inline-search-input");
    const hasQuery = !!(input?.value || "").trim();
    // Keep open while a query is active so the field stays visible
    if (hasQuery && wrap.classList.contains("is-open")) continue;
    if (!hasQuery) setInlineSearchOpen(wrap, false);
  }
}

function clearSearchFromWrap(wrap) {
  const input = wrap?.querySelector(".inline-search-input");
  if (!input) return;
  input.value = "";
  if (wrap.dataset.search === "active") {
    doc.ui.activeQuery = "";
    setInlineSearchOpen(wrap, false);
    renderActive();
  } else {
    doc.ui.archiveQuery = "";
    setInlineSearchOpen(wrap, false);
    renderArchive();
  }
  saveDoc();
}

function toggleInlineSearch(wrap) {
  if (!wrap) return;
  closeAllToolPops();
  const input = wrap.querySelector(".inline-search-input");
  const hasQuery = !!(input?.value || "").trim() || !!(
    wrap.dataset.search === "active" ? doc.ui.activeQuery : doc.ui.archiveQuery
  )?.trim();
  const isOpen = wrap.classList.contains("is-open");

  // Icon click while searching / open → clear and turn off
  if (isOpen || hasQuery) {
    clearSearchFromWrap(wrap);
    return;
  }
  setInlineSearchOpen(wrap, true);
}

function syncActiveFilterUi() {
  if (!el.activeQuery) return;
  const q = doc.ui.activeQuery || "";
  if (document.activeElement !== el.activeQuery) {
    el.activeQuery.value = q;
  }
  const hasQuery = !!q.trim();
  const dueSort = doc.ui.activeSort === "due-asc";
  const progressMode = normalizeProgressMode(doc.ui.progressMode);
  const activeWrap = el.btnActiveSearch?.closest(".inline-search");
  // is-on only while a query is active (not merely while the field is open)
  el.btnActiveSearch?.classList.toggle("is-on", hasQuery);
  if (hasQuery && activeWrap && !activeWrap.classList.contains("is-open")) {
    setInlineSearchOpen(activeWrap, true);
  }
  if (!hasQuery && activeWrap && !activeWrap.classList.contains("is-open")) {
    el.btnActiveSearch?.setAttribute("aria-expanded", "false");
  }
  if (el.btnActiveDueSort) {
    el.btnActiveDueSort.classList.toggle("is-on", dueSort);
    el.btnActiveDueSort.setAttribute("aria-pressed", dueSort ? "true" : "false");
    el.btnActiveDueSort.title = dueSort ? t("dueSort.off") : t("dueSort.on");
    el.btnActiveDueSort.setAttribute("aria-label", dueSort ? t("dueSort.off") : t("dueSort.on"));
  }
  const plainText = !!doc.ui.plainTextMode;
  if (el.btnActivePlainText) {
    el.btnActivePlainText.classList.toggle("is-on", plainText);
    el.btnActivePlainText.setAttribute("aria-pressed", plainText ? "true" : "false");
    el.btnActivePlainText.title = plainText ? t("plainText.off") : t("plainText.on");
    el.btnActivePlainText.setAttribute(
      "aria-label",
      plainText ? t("plainText.off") : t("plainText.on")
    );
  }
  if (el.progressModeSelect) {
    el.progressModeSelect.value = progressMode;
  }
  if (el.categoryMode) el.categoryMode.checked = !!doc.ui.categoryMode;
  if (el.dueKeepTree) el.dueKeepTree.checked = !!doc.ui.dueKeepTree;
  if (el.dueShowUndated) el.dueShowUndated.checked = !!doc.ui.dueShowUndated;
  if (el.titleWrap) el.titleWrap.checked = !!doc.ui.titleWrap;
  if (el.activeToolHint) {
    const bits = [];
    if (hasQuery) bits.push(t("hint.searching"));
    if (dueSort) bits.push(t("hint.dueSort"));
    if (plainText) bits.push(t("hint.plainText"));
    el.activeToolHint.hidden = !bits.length;
    el.activeToolHint.textContent = bits.join(" · ");
  }
}

function syncArchiveToolHint() {
  if (!el.archiveToolHint) return;
  const bits = [];
  const hasQuery = !!(doc.ui.archiveQuery || "").trim();
  const periodOn = (doc.ui.archivePeriod || "all") !== "all";
  const sortOn = doc.ui.archiveSort && doc.ui.archiveSort !== "completed-desc";
  if (hasQuery) bits.push(t("hint.searching"));
  if (periodOn) bits.push(t("hint.filtering"));
  if (sortOn) {
    const labels = {
      "completed-asc": t("hint.sort.completedAsc"),
      "title-asc": t("hint.sort.titleAsc"),
    };
    bits.push(labels[doc.ui.archiveSort] || t("hint.sorting"));
  }
  el.archiveToolHint.hidden = !bits.length;
  el.archiveToolHint.textContent = bits.join(" · ");
  const archiveWrap = el.btnArchiveSearch?.closest(".inline-search");
  el.btnArchiveSearch?.classList.toggle("is-on", hasQuery);
  if (hasQuery && archiveWrap && !archiveWrap.classList.contains("is-open")) {
    setInlineSearchOpen(archiveWrap, true);
  }
  el.btnArchiveFilter?.classList.toggle("is-on", periodOn || sortOn);
}

function discordReason(result) {
  if (result?.code === "http") return t("discord.reason.http", { status: result.status || "?" });
  return t(`discord.reason.${result?.code || "network"}`);
}

function setDiscordStatus(message, kind = "") {
  if (!el.discordStatus) return;
  el.discordStatus.textContent = message;
  el.discordStatus.classList.toggle("is-success", kind === "success");
  el.discordStatus.classList.toggle("is-error", kind === "error");
}

function validateEncryptedDiscordSetting(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["enabled", "webhookUrl", "visibility", "automaticPost", "displayName"];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return false;
  const normalized = normalizeDiscordSettings(value);
  if (normalized.webhookUrl && !validateDiscordWebhookUrl(normalized.webhookUrl)) return false;
  return keys.every((key) => normalized[key] === value[key]);
}

async function applyEncryptedDiscordSetting(value) {
  const current = await integrationSettings.readDiscord({ fresh: true });
  const next = value == null ? normalizeDiscordSettings() : normalizeDiscordSettings(value);
  const endpointChanged = shouldDiscardDiscordOutbox(current, value == null ? null : next);
  if (value == null) await integrationSettings.clearDiscord();
  else await integrationSettings.writeDiscord(next);
  if (endpointChanged) await completionOutbox.clear();
  await syncDiscordSettingsUi();
}

function syncDiscordSettingToDrive(value) {
  if (!syncV3Enabled || typeof driveSync.pushSharedSetting !== "function") return;
  void syncOperations.run(() => driveSync.pushSharedSetting(value)).catch((error) => updateSyncUi(error));
}

async function syncDiscordSettingsUi() {
  if (!el.discordEnabled) return;
  const settings = await integrationSettings.readDiscord();
  el.discordEnabled.checked = settings.enabled;
  el.discordVisibility.value = settings.visibility;
  el.discordDisplayName.value = settings.displayName;
  el.discordAutomatic.checked = settings.automaticPost;
  if (document.activeElement !== el.discordWebhookUrl) {
    el.discordWebhookUrl.value = settings.webhookUrl;
  }
  const masked = maskDiscordWebhookUrl(settings.webhookUrl);
  if (el.discordOptions) {
    el.discordOptions.hidden = !validateDiscordWebhookUrl(settings.webhookUrl);
  }
  setDiscordStatus(masked ? `${t("discord.connected")} · ${masked}` : "");
  const counts = await completionOutbox.status();
  if (el.discordCounts) {
    el.discordCounts.textContent = t("discord.counts", counts);
  }
}

async function saveDiscordSettingsPatch(patch) {
  const current = await integrationSettings.readDiscord({ fresh: true });
  const next = await integrationSettings.writeDiscord({ ...current, ...patch });
  syncDiscordSettingToDrive(next);
  await syncDiscordSettingsUi();
  void completionOutbox.process().then(syncDiscordSettingsUi);
}

async function testDiscordConnection() {
  const url = el.discordWebhookUrl?.value.trim() || "";
  if (!validateDiscordWebhookUrl(url)) {
    setDiscordStatus(t("discord.invalidUrl"), "error");
    return;
  }
  el.discordTest.disabled = true;
  const result = await testDiscordWebhook(url);
  el.discordTest.disabled = false;
  if (!result.ok) {
    setDiscordStatus(t("discord.testFailed", { reason: discordReason(result) }), "error");
    return;
  }
  const current = await integrationSettings.readDiscord({ fresh: true });
  const next = await integrationSettings.writeDiscord({ ...current, webhookUrl: url });
  syncDiscordSettingToDrive(next);
  setDiscordStatus(t("discord.connected"), "success");
  await syncDiscordSettingsUi();
}

if (el.discordEnabled) {
  el.discordEnabled.addEventListener("change", () => {
    void saveDiscordSettingsPatch({ enabled: el.discordEnabled.checked });
  });
  el.discordVisibility.addEventListener("change", () => {
    void saveDiscordSettingsPatch({ visibility: el.discordVisibility.value });
  });
  el.discordDisplayName.addEventListener("change", () => {
    void saveDiscordSettingsPatch({ displayName: el.discordDisplayName.value });
  });
  el.discordAutomatic.addEventListener("change", () => {
    void saveDiscordSettingsPatch({ automaticPost: el.discordAutomatic.checked });
  });
  el.discordTest.addEventListener("click", () => void testDiscordConnection());
  el.discordRetry.addEventListener("click", async () => {
    await completionOutbox.retryFailed();
    await syncDiscordSettingsUi();
  });
  el.discordDisconnect.addEventListener("click", async () => {
    if (!window.confirm(t("discord.disconnectConfirm"))) return;
    await completionOutbox.clear();
    await integrationSettings.clearDiscord();
    syncDiscordSettingToDrive(null);
    el.discordWebhookUrl.value = "";
    await syncDiscordSettingsUi();
    setDiscordStatus(t("discord.disconnected"), "success");
  });
}

window.addEventListener("online", () => {
  if (!skipPersist) void completionOutbox.process().then(syncDiscordSettingsUi);
});
window.addEventListener("focus", () => {
  if (!skipPersist) void completionOutbox.process().then(syncDiscordSettingsUi);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !skipPersist) {
    void completionOutbox.process().then(syncDiscordSettingsUi);
  }
});

/**
 * Append outline rows into `container`.
 * - groupRoots: wrap each depth-0 tree in `.root-block`
 * - groupAll: wrap the whole list in one `.root-block` (due-sort)
 * @param {HTMLElement} container
 * @param {{ id: string, displayDepth: number, contextParent?: boolean, isZoomRoot?: boolean }[]} rows
 * @param {(row: any) => HTMLElement} makeRow
 * @param {{ groupRoots?: boolean, groupAll?: boolean }} [opts]
 */
function appendOutlineRows(container, rows, makeRow, opts = {}) {
  const groupAll = !!opts.groupAll;
  const groupRoots = !groupAll && opts.groupRoots !== false;

  if (groupAll) {
    const block = document.createElement("div");
    block.className = "root-block";
    container.appendChild(block);
    for (const row of rows) block.appendChild(makeRow(row));
    return;
  }

  /** @type {HTMLElement | null} */
  let block = null;
  for (const row of rows) {
    const elRow = makeRow(row);
    if (!groupRoots) {
      container.appendChild(elRow);
      continue;
    }
    if (row.displayDepth === 0) {
      block = document.createElement("div");
      block.className = "root-block";
      container.appendChild(block);
    }
    (block || container).appendChild(elRow);
  }
}

function mobileNodeTitle(node) {
  return (node?.title || "").trim() || t("untitled");
}

function normalizeMobileUiState() {
  const navRoot = mobileUi.navRootId ? doc.nodes[mobileUi.navRootId] : null;
  if (mobileUi.navRootId && !isActive(navRoot)) mobileUi.navRootId = null;
  if (mobileUi.inlineEditor && !isActive(doc.nodes[mobileUi.inlineEditor.id])) {
    mobileUi.inlineEditor = null;
  }
}

function syncMobileSurfaceVisibility() {
  const mobile = isMobileSheet() && doc.ui.tab === "active";
  document.body.classList.toggle("has-mobile-v2", mobile);
  if (el.mobileActiveSurface) {
    el.mobileActiveSurface.hidden = !mobile;
    el.mobileActiveSurface.inert = !mobile;
  }
  if (el.activeDesktopSurface) {
    el.activeDesktopSurface.hidden = mobile;
    el.activeDesktopSurface.inert = mobile;
  }
  if (mobile && !mobileUi.detailsOpen) {
    sheetLevel = "closed";
  }
  syncSheetUi();
  return mobile;
}

function mobilePathText(id, { includeSelf = false } = {}) {
  const chain = outlineAncestorChain(doc, id);
  const nodes = includeSelf ? chain : chain.slice(0, -1);
  return nodes.map(mobileNodeTitle).join(" / ");
}

function mobileRows() {
  const query = doc.ui.activeQuery.trim();
  if (query) {
    return Object.values(doc.nodes)
      .filter(nodePassesActiveFilters)
      .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
      .map((node) => ({ id: node.id, displayDepth: 0, path: mobilePathText(node.id) }));
  }

  if (doc.ui.activeSort === "due-asc") {
    const roots = mobileUi.navRootId
      ? [mobileUi.navRootId]
      : doc.rootIds.filter((id) => isActive(doc.nodes[id]));
    /** @type {ReturnType<typeof getNode>[]} */
    const flat = [];
    for (const rootId of roots) {
      for (const node of collectDueSortMatchesFlat(rootId)) {
        if (mobileUi.navRootId && node.id === mobileUi.navRootId) continue;
        flat.push(node);
      }
    }
    flat.sort((left, right) => compareDue(left, right, false));
    return flat.map((node) => ({
      id: node.id,
      displayDepth: 0,
      path: mobilePathText(node.id),
    }));
  }

  const rootIds = mobileUi.navRootId
    ? activeOutlineChildrenOf(doc, mobileUi.navRootId).map((node) => node.id)
    : doc.rootIds.filter((id) => isActive(doc.nodes[id]));
  if (mobileUi.displayMode === "branch") {
    return rootIds.map((id) => ({ id, displayDepth: 0 }));
  }

  const rows = [];
  const walk = (id, displayDepth) => {
    const node = doc.nodes[id];
    if (!isActive(node)) return;
    rows.push({ id, displayDepth });
    if (node.collapsed) return;
    for (const child of activeOutlineChildrenOf(doc, id)) walk(child.id, displayDepth + 1);
  };
  for (const id of rootIds) walk(id, 0);
  return rows;
}

function mobileRowMeta(node, row) {
  const parts = [];
  if (row.path) parts.push(row.path);
  if (doc.ui.activeSort === "due-asc" && node.dueAt != null) {
    parts.push(t("mobile.due", { date: formatDateShort(node.dueAt) }));
  }
  // Full-tree outline already shows nesting visually; skip progress/child counts there.
  if (mobileUi.displayMode !== "outline") {
    const progress = childProgress(node.id);
    if (progress?.total && !isCategoryNode(node)) {
      parts.push(t("mobile.progress", { done: progress.done, total: progress.total }));
    } else {
      const childCount = activeOutlineChildrenOf(doc, node.id).length;
      if (childCount) parts.push(t("mobile.children", { count: childCount }));
    }
  }
  return parts.join(" · ");
}

function closeMobileInlineEditor() {
  requestMobileV2Back();
}

function saveMobileInlineEditor(id) {
  const editor = mobileUi.inlineEditor;
  const node = doc.nodes[id];
  if (!editor || editor.id !== id || !isActive(node)) return;
  if (node.title !== editor.baseTitle) {
    const useMine = window.confirm(t("mobile.editorConflict"));
    if (!useMine) return;
  }
  if (node.title === editor.draft) {
    mobileUi.inlineEditor = null;
    renderMobileActive();
    return;
  }
  pushHistory();
  const result = renameOutlineNode(doc, { id, title: editor.draft });
  mobileUi.inlineEditor = null;
  renderMobileActive();
  replaceMobileHistoryState();
  if (result.changed) saveDoc();
}

function openMobileBranch(id, { replaceHistory = false } = {}) {
  const node = doc.nodes[id];
  if (!isActive(node) || mobileUi.reorderMode || mobileUi.transitioning) return;
  mobileUi.navRootId = id;
  mobileUi.inlineEditor = null;
  mobileUi.reorderMode = false;
  if (doc.ui.activeQuery) {
    doc.ui.activeQuery = "";
    saveDoc();
  }
  renderMobileActive({ transition: "forward" });
  if (replaceHistory) replaceMobileHistoryState();
  else pushMobileHistoryState();
  requestAnimationFrame(() => el.mobileCurrentHeading?.focus?.());
}

function closeMobileRowMenu({ restoreFocus = true } = {}) {
  const id = mobileUi.rowMenuId;
  mobileUi.rowMenuId = null;
  const sheet = el.mobileRowMenuDialog;
  const backdrop = el.mobileRowMenuBackdrop;
  const finish = () => {
    if (sheet) {
      sheet.hidden = true;
      sheet.classList.remove("is-open", "is-closing");
    }
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove("is-open", "is-closing");
    }
    document.body.classList.remove("has-mobile-row-sheet");
  };
  if (!sheet || sheet.hidden || prefersReducedMotion()) {
    finish();
  } else {
    sheet.classList.add("is-closing");
    sheet.classList.remove("is-open");
    backdrop?.classList.add("is-closing");
    backdrop?.classList.remove("is-open");
    const onEnd = () => {
      sheet.removeEventListener("transitionend", onEnd);
      finish();
    };
    sheet.addEventListener("transitionend", onEnd);
    window.setTimeout(onEnd, 280);
  }
  if (!restoreFocus) return;
  requestAnimationFrame(() => {
    document.querySelector(`.mobile-task-row[data-id="${id}"] .mobile-row-menu-btn, .mobile-task-row[data-id="${id}"] .mobile-task-main`)?.focus();
  });
}

function openMobileRowMenu(id) {
  const node = doc.nodes[id];
  if (!isActive(node) || !el.mobileRowMenuDialog) return;
  mobileUi.rowMenuId = id;
  if (el.mobileRowMenuTitle) el.mobileRowMenuTitle.textContent = mobileNodeTitle(node);
  const completeAction = el.mobileRowMenuDialog.querySelector('[data-mobile-row-action="complete"]');
  if (completeAction) completeAction.hidden = isCategoryNode(node);
  el.mobileRowMenuDialog.hidden = false;
  el.mobileRowMenuDialog.classList.remove("is-closing");
  if (el.mobileRowMenuBackdrop) {
    el.mobileRowMenuBackdrop.hidden = false;
    el.mobileRowMenuBackdrop.classList.remove("is-closing");
  }
  document.body.classList.add("has-mobile-row-sheet");
  pushMobileHistoryState({ transient: true });
  void el.mobileRowMenuDialog.offsetWidth;
  requestAnimationFrame(() => {
    el.mobileRowMenuDialog?.classList.add("is-open");
    el.mobileRowMenuBackdrop?.classList.add("is-open");
    el.mobileRowMenuDialog
      ?.querySelector(".mobile-action-list > button:not([hidden])")
      ?.focus();
  });
}

function closeMobileMovePicker() {
  mobileUi.movePicker = null;
  if (el.mobileMoveDialog?.open) el.mobileMoveDialog.close();
}

function renderMobileMoveList() {
  if (!el.mobileMoveList || !mobileUi.movePicker) return;
  const { nodeId, query, purpose } = mobileUi.movePicker;
  const adding = purpose === "add-parent";
  const moving = adding ? null : doc.nodes[nodeId];
  if (!adding && !isActive(moving)) {
    closeMobileMovePicker();
    return;
  }
  const normalizedQuery = query.trim().toLowerCase();
  const candidates = Object.values(doc.nodes)
    .filter((candidate) => {
      if (!isActive(candidate)) return false;
      if (adding) return true;
      return canMoveOutlineNode(doc, nodeId, candidate.id);
    })
    .map((candidate) => ({ candidate, path: mobilePathText(candidate.id, { includeSelf: true }) }))
    .filter(({ path }) => !normalizedQuery || path.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => left.path.localeCompare(right.path, getLocaleTag()))
    .slice(0, 200);

  el.mobileMoveList.innerHTML = "";
  const top = document.createElement("button");
  top.type = "button";
  top.className = "mobile-move-option";
  top.textContent = t("mobile.moveTopLevel");
  if (adding) {
    top.addEventListener("click", () => beginMobileQuickAdd(null));
  } else {
    top.disabled = moving.parentId == null;
    top.addEventListener("click", () => moveMobileNodeTo(nodeId, null));
  }
  el.mobileMoveList.appendChild(top);

  for (const { candidate, path } of candidates) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "mobile-move-option";
    option.textContent = path;
    if (adding) {
      option.addEventListener("click", () => beginMobileQuickAdd(candidate.id));
    } else {
      option.disabled = moving.parentId === candidate.id;
      option.addEventListener("click", () => moveMobileNodeTo(nodeId, candidate.id));
    }
    el.mobileMoveList.appendChild(option);
  }

  if (!candidates.length && normalizedQuery) {
    const empty = document.createElement("div");
    empty.className = "mobile-move-empty";
    empty.textContent = adding ? t("mobile.addParentNoResults") : t("mobile.moveNoResults");
    el.mobileMoveList.appendChild(empty);
  }
}

function openMobileMovePicker(id) {
  const node = doc.nodes[id];
  if (!isActive(node) || !el.mobileMoveDialog) return;
  mobileUi.movePicker = { nodeId: id, query: "", purpose: "move" };
  if (el.mobileMoveTitle) el.mobileMoveTitle.textContent = t("mobile.moveNamed", { title: mobileNodeTitle(node) });
  if (el.mobileMoveSearch) {
    el.mobileMoveSearch.value = "";
    el.mobileMoveSearch.placeholder = t("mobile.moveSearchPlaceholder");
  }
  renderMobileMoveList();
  el.mobileMoveDialog.showModal();
  requestAnimationFrame(() => el.mobileMoveSearch?.focus());
}

function openMobileAddParentPicker() {
  mobileUi.addParentPick = true;
  mobileUi.inlineEditor = null;
  mobileUi.reorderMode = false;
  mobileUi.quickAdd.open = false;
  renderMobileActive();
  pushMobileHistoryState({ transient: true });
}

function beginMobileQuickAdd(parentId) {
  closeMobileMovePicker();
  mobileUi.inlineEditor = null;
  const openQuickAdd = () => {
    mobileUi.addParentPick = false;
    mobileUi.quickAdd.open = true;
    mobileUi.quickAdd.parentId = parentId;
    mobileUi.quickAdd.draft = "";
    if (el.mobileQuickAddInput) el.mobileQuickAddInput.value = "";
    renderMobileActive();
    pushMobileHistoryState({ transient: true });
    requestAnimationFrame(() => {
      el.mobileQuickAddInput?.focus();
      el.mobileQuickAddInput?.select?.();
    });
  };
  if (mobileUi.addParentPick && el.mobileAddParentBar && !el.mobileAddParentBar.hidden) {
    animateMobilePanelDismiss(el.mobileAddParentBar, { duration: 160, onDone: openQuickAdd });
    return;
  }
  openQuickAdd();
}

function focusMobileInlineInput(input) {
  if (!input) return;
  input.focus({ preventScroll: true });
  try {
    const len = input.value.length;
    input.setSelectionRange(0, len);
  } catch {
    input.select?.();
  }
}

function handleMobileV2Back() {
  if (!isMobileSheet() || el.mobileActiveSurface?.hidden) return false;
  if (el.mobileRowMenuDialog && !el.mobileRowMenuDialog.hidden) {
    closeMobileRowMenu({ restoreFocus: true });
    return true;
  }
  if (el.mobileMoveDialog?.open) {
    closeMobileMovePicker();
    return true;
  }
  if (el.mobileRowMenuDialog?.open) {
    closeMobileRowMenu({ restoreFocus: false });
    return true;
  }
  if (mobileUi.detailsOpen) {
    closeMobileDetails();
    return true;
  }
  if (el.mobileSearchBar && !el.mobileSearchBar.hidden) {
    closeMobileSearchBar();
    return true;
  }
  if (mobileUi.addParentPick) {
    closeMobileAddParentPicker();
    return true;
  }
  if (mobileUi.quickAdd.open) {
    if (mobileUi.quickAdd.draft.trim() && !window.confirm(t("mobile.discardDraft"))) return "blocked";
    closeMobileQuickAdd();
    return true;
  }
  if (mobileUi.inlineEditor) {
    const changed = mobileUi.inlineEditor.draft !== mobileUi.inlineEditor.baseTitle;
    if (changed && !window.confirm(t("mobile.discardDraft"))) return "blocked";
    mobileUi.inlineEditor = null;
    renderMobileActive();
    return true;
  }
  if (mobileUi.reorderMode) {
    mobileUi.reorderMode = false;
    renderMobileActive();
    return true;
  }
  if (mobileUi.navRootId) {
    const current = doc.nodes[mobileUi.navRootId];
    mobileUi.navRootId = current?.parentId || null;
    renderMobileActive({ transition: "back" });
    requestAnimationFrame(() => el.mobileCurrentHeading?.focus?.());
    return true;
  }
  return false;
}

function requestMobileV2Back() {
  const marker = window.history.state?.[MOBILE_HISTORY_STATE_KEY];
  if (marker && (marker.transient || mobileUi.navRootId)) {
    window.history.back();
    return;
  }
  handleMobileV2Back();
}

function reorderMobileNodeTo(id, targetId, after) {
  const siblings = outlineSiblingList(doc, id);
  if (!siblings || id === targetId) return;
  const withoutMoving = siblings.filter((siblingId) => siblingId !== id);
  const targetIndex = withoutMoving.indexOf(targetId);
  if (targetIndex < 0) return;
  const toIndex = targetIndex + (after ? 1 : 0);
  if (siblings.indexOf(id) === toIndex) return;
  pushHistory();
  const result = reorderOutlineNode(doc, { id, toIndex });
  if (!result.changed) return;
  renderMobileActive();
  saveDoc();
}

function moveMobileNodeTo(id, parentId) {
  const node = doc.nodes[id];
  if (!isActive(node)) return;
  if (node.parentId === parentId) {
    closeMobileMovePicker();
    return;
  }
  const changesCategoryStatus = isCategoryMode() && ((node.parentId == null) !== (parentId == null));
  if (changesCategoryStatus && !window.confirm(t("mobile.moveCategoryConfirm"))) return;
  pushHistory();
  const result = moveOutlineNode(doc, { id, parentId, index: "end" });
  if (!result.changed) return;
  closeMobileMovePicker();
  renderMobileActive();
  saveDoc();
  const destination = parentId ? mobilePathText(parentId, { includeSelf: true }) : t("mobile.moveTopLevel");
  showNoticeToast(t("mobile.moved", { destination }));
}

function closeMobileSearchBar({ render = true } = {}) {
  const bar = el.mobileSearchBar;
  const finish = () => {
    if (bar) bar.hidden = true;
    if (doc.ui.activeQuery) {
      doc.ui.activeQuery = "";
      saveDoc();
    }
    if (render) renderMobileActive();
  };
  if (!bar || bar.hidden) {
    finish();
    return;
  }
  animateMobilePanelDismiss(bar, { duration: 160, onDone: finish });
}

function closeMobileAddParentPicker({ render = true } = {}) {
  const bar = el.mobileAddParentBar;
  const finish = () => {
    mobileUi.addParentPick = false;
    if (bar) bar.hidden = true;
    if (render) renderMobileActive();
  };
  if (!bar || bar.hidden || !mobileUi.addParentPick) {
    finish();
    return;
  }
  animateMobilePanelDismiss(bar, { duration: 160, onDone: finish });
}

function closeMobileQuickAdd({ render = true } = {}) {
  const sheet = el.mobileQuickAdd;
  const finish = () => {
    mobileUi.quickAdd.open = false;
    mobileUi.quickAdd.draft = "";
    if (sheet) sheet.hidden = true;
    if (render) renderMobileActive();
  };
  if (!sheet || sheet.hidden || !mobileUi.quickAdd.open) {
    finish();
    return;
  }
  animateMobilePanelDismiss(sheet, { duration: 220, onDone: finish });
}

function closeMobileDetails({ restoreFocus = true } = {}) {
  if (!mobileUi.detailsOpen) return;
  const originId = mobileUi.detailOriginId;
  const pane = el.detailPane;
  const backdrop = el.detailSheetBackdrop;
  const mobileV2 = isMobileSheet() && !el.mobileActiveSurface?.hidden;

  const finish = () => {
    mobileUi.detailsOpen = false;
    mobileUi.detailOriginId = null;
    mobileUi.detailSheetAnim = null;
    sheetLevel = "closed";
    clearInputAndSelection();
    pane?.classList.remove("is-sheet-expanded", "is-sheet-closing");
    backdrop?.classList.remove("is-visible");
    if (backdrop) backdrop.hidden = true;
    if (restoreFocus && originId) {
      requestAnimationFrame(() => {
        document.querySelector(
          `.mobile-task-row[data-id="${originId}"] .mobile-row-menu-btn, .mobile-task-row[data-id="${originId}"] .mobile-task-main`
        )?.focus();
      });
    }
  };

  if (!mobileV2 || !pane || prefersReducedMotion()) {
    finish();
    return;
  }

  mobileUi.detailSheetAnim = "closing";
  pane.classList.add("is-sheet-closing");
  pane.classList.remove("is-sheet-expanded");
  backdrop?.classList.remove("is-visible");
  const onEnd = () => {
    pane.removeEventListener("transitionend", onEnd);
    finish();
  };
  pane.addEventListener("transitionend", onEnd);
  window.setTimeout(onEnd, 300);
}

function openMobileDetails(id) {
  const node = getNode(id);
  if (!node) return;
  mobileUi.detailOriginId = id;
  mobileUi.detailsOpen = true;
  selectNode(id);
  const mobileV2 = isMobileSheet() && !el.mobileActiveSurface?.hidden;
  if (!mobileV2) {
    setSheetLevel("expanded");
    return;
  }

  sheetLevel = "expanded";
  const pane = el.detailPane;
  const backdrop = el.detailSheetBackdrop;
  pane?.classList.remove("is-sheet-closing", "is-mobile-v2-hidden", "is-sheet-closed", "is-sheet-peek");
  if (backdrop) backdrop.hidden = false;

  if (prefersReducedMotion()) {
    mobileUi.detailSheetAnim = null;
    pane?.classList.add("is-sheet-expanded");
    backdrop?.classList.add("is-visible");
    syncSheetUi();
    return;
  }

  mobileUi.detailSheetAnim = "opening";
  pane?.classList.remove("is-sheet-expanded");
  backdrop?.classList.remove("is-visible");
  syncSheetUi();
  void pane?.offsetWidth;
  requestAnimationFrame(() => {
    mobileUi.detailSheetAnim = null;
    pane?.classList.add("is-sheet-expanded");
    backdrop?.classList.add("is-visible");
    syncSheetUi();
  });
}

function renderMobileTaskRow(row) {
  const node = doc.nodes[row.id];
  if (!isActive(node)) return null;
  const title = mobileNodeTitle(node);
  const wrapper = document.createElement("div");
  wrapper.className = "mobile-task-row";
  wrapper.dataset.id = node.id;
  wrapper.setAttribute("role", "listitem");
  if (mobileUi.displayMode === "outline" || doc.ui.activeSort === "due-asc") {
    wrapper.classList.add("is-outline-row");
    wrapper.style.setProperty("--mobile-depth", String(row.displayDepth || 0));
  }
  if (row.contextParent) wrapper.classList.add("is-context-row");

  if (mobileUi.inlineEditor?.id === node.id) {
    wrapper.classList.add("is-editing");
    const form = document.createElement("form");
    form.className = "mobile-inline-editor";
    const input = document.createElement("input");
    input.className = "pop-input input-white mobile-inline-input";
    input.type = "text";
    input.enterKeyHint = "done";
    input.value = mobileUi.inlineEditor.draft;
    input.addEventListener("input", () => {
      if (mobileUi.inlineEditor?.id === node.id) mobileUi.inlineEditor.draft = input.value;
    });
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "pop-btn pop-btn--cta pop-btn--sm";
    save.textContent = t("mobile.editorSave");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pop-btn pop-btn--sm";
    cancel.textContent = t("mobile.editorCancel");
    cancel.addEventListener("click", closeMobileInlineEditor);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (event.isComposing) return;
      saveMobileInlineEditor(node.id);
    });
    form.append(input, save, cancel);
    wrapper.appendChild(form);
    // Focus in the same turn as the pencil tap so iOS shows the keyboard.
    focusMobileInlineInput(input);
    return wrapper;
  }

  if (mobileUi.reorderMode) {
    wrapper.classList.add("is-reorder-row");
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "mobile-reorder-handle";
    handle.textContent = "☰";
    handle.setAttribute("aria-label", t("mobile.reorderHandle", { title }));
    let dragPointerId = null;
    let dragTargetId = null;
    let dragAfter = false;
    const clearDropTarget = () => {
      el.mobileActiveList
        ?.querySelectorAll(".is-drop-before, .is-drop-after")
        .forEach((element) => element.classList.remove("is-drop-before", "is-drop-after"));
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      dragPointerId = event.pointerId;
      dragTargetId = null;
      dragAfter = false;
      wrapper.classList.add("is-dragging");
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (dragPointerId !== event.pointerId) return;
      event.preventDefault();
      const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".mobile-task-row");
      const targetId = targetRow?.dataset?.id;
      clearDropTarget();
      if (!targetId || targetId === node.id) {
        dragTargetId = null;
        return;
      }
      const rect = targetRow.getBoundingClientRect();
      dragTargetId = targetId;
      dragAfter = event.clientY >= rect.top + rect.height / 2;
      targetRow.classList.add(dragAfter ? "is-drop-after" : "is-drop-before");
    });
    const finishDrag = (event) => {
      if (dragPointerId !== event.pointerId) return;
      if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      wrapper.classList.remove("is-dragging");
      clearDropTarget();
      if (dragTargetId) {
        const beforeTops = captureMobileRowTops();
        const siblings = outlineSiblingList(doc, node.id);
        if (siblings && dragTargetId !== node.id) {
          const withoutMoving = siblings.filter((siblingId) => siblingId !== node.id);
          const targetIndex = withoutMoving.indexOf(dragTargetId);
          if (targetIndex >= 0) {
            const toIndex = targetIndex + (dragAfter ? 1 : 0);
            if (siblings.indexOf(node.id) !== toIndex) {
              pushHistory();
              const result = reorderOutlineNode(doc, { id: node.id, toIndex });
              if (result.changed) {
                renderMobileActive();
                animateMobileReorder(beforeTops);
                saveDoc();
              }
            }
          }
        }
      }
      dragPointerId = null;
      dragTargetId = null;
    };
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", (event) => {
      if (dragPointerId !== event.pointerId) return;
      wrapper.classList.remove("is-dragging");
      clearDropTarget();
      dragPointerId = null;
      dragTargetId = null;
    });
    const left = document.createElement("button");
    left.type = "button";
    left.className = "mobile-reorder-step-btn";
    left.textContent = "←";
    left.setAttribute("aria-label", `${t("mobile.outdent")}: ${title}`);
    left.disabled = !canOutdentOutlineNode(doc, node.id);
    left.addEventListener("click", () => outdentMobileNode(node.id));
    const right = document.createElement("button");
    right.type = "button";
    right.className = "mobile-reorder-step-btn";
    right.textContent = "→";
    right.setAttribute("aria-label", `${t("mobile.indent")}: ${title}`);
    right.disabled = !canIndentOutlineNode(doc, node.id);
    right.addEventListener("click", () => indentMobileNode(node.id));
    const up = document.createElement("button");
    up.type = "button";
    up.className = "mobile-reorder-step-btn";
    up.textContent = "↑";
    up.setAttribute("aria-label", `${t("mobile.moveUp")}: ${title}`);
    up.disabled = !canReorderOutlineNode(doc, node.id, -1);
    up.addEventListener("click", () => reorderAmongSiblings(node.id, -1));
    const main = document.createElement("div");
    main.className = "mobile-task-main";
    const titleEl = document.createElement("div");
    titleEl.className = "mobile-task-title";
    titleEl.textContent = title;
    main.appendChild(titleEl);
    const down = document.createElement("button");
    down.type = "button";
    down.className = "mobile-reorder-step-btn";
    down.textContent = "↓";
    down.setAttribute("aria-label", `${t("mobile.moveDown")}: ${title}`);
    down.disabled = !canReorderOutlineNode(doc, node.id, 1);
    down.addEventListener("click", () => reorderAmongSiblings(node.id, 1));
    const controls = document.createElement("div");
    controls.className = "mobile-reorder-step-controls";
    controls.append(left, right, up, down);
    wrapper.append(handle, main, controls);
    return wrapper;
  }

  if (mobileUi.addParentPick) {
    wrapper.classList.add("is-add-parent-option");
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "mobile-task-main";
    pick.setAttribute("aria-label", t("mobile.addParentPickNamed", { title }));
    const titleEl = document.createElement("span");
    titleEl.className = "mobile-task-title";
    titleEl.textContent = title;
    pick.appendChild(titleEl);
    pick.addEventListener("click", () => beginMobileQuickAdd(node.id));
    wrapper.appendChild(pick);
    return wrapper;
  }

  const complete = document.createElement("button");
  complete.type = "button";
  complete.className = "mobile-complete-btn";
  complete.setAttribute("aria-label", t("mobile.complete", { title }));
  complete.hidden = isCategoryNode(node) || !!row.contextParent;
  if (complete.hidden) wrapper.classList.add("is-category-row");
  complete.addEventListener("click", () => completeNode(node.id));

  const main = document.createElement("button");
  main.type = "button";
  main.className = "mobile-task-main";
  main.setAttribute("aria-label", t("mobile.openBranch", { title }));
  const titleRow = document.createElement("span");
  titleRow.className = "mobile-task-title-row";
  const titleEl = document.createElement("span");
  titleEl.className = "mobile-task-title";
  titleEl.textContent = title;
  titleRow.appendChild(titleEl);
  if ((node.note || "").trim()) {
    titleRow.classList.add("has-note");
    titleRow.appendChild(createNoteIndicator());
  }
  const meta = document.createElement("span");
  meta.className = "mobile-task-submeta";
  meta.textContent = mobileRowMeta(node, row);
  meta.hidden = !meta.textContent;
  main.append(titleRow, meta);
  main.addEventListener("click", (event) => {
    if (performance.now() < suppressRowClickUntil) {
      event.preventDefault();
      return;
    }
    if (mobileUi.addParentPick) {
      beginMobileQuickAdd(node.id);
      return;
    }
    openMobileBranch(node.id);
  });

  const actions = document.createElement("div");
  actions.className = "mobile-row-actions";

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "mobile-row-edit-btn";
  edit.textContent = "✎";
  edit.setAttribute("aria-label", t("mobile.edit", { title }));
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    if (mobileUi.transitioning || mobileUi.reorderMode || mobileUi.addParentPick) return;
    mobileUi.inlineEditor = { id: node.id, baseTitle: node.title, draft: node.title };
    renderMobileActive();
    focusMobileInlineInput(el.mobileActiveList?.querySelector(".mobile-inline-input"));
    pushMobileHistoryState({ transient: true });
  });

  const menu = document.createElement("button");
  menu.type = "button";
  menu.className = "mobile-row-menu-btn";
  menu.textContent = "⋯";
  menu.setAttribute("aria-label", t("mobile.moreActions", { title }));
  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    openMobileRowMenu(node.id);
  });
  actions.append(edit, menu);
  wrapper.append(complete, main, actions);

  let longPressTimer = null;
  let longPressStart = null;
  let longPressTriggered = false;
  const cancelLongPress = () => {
    if (longPressTimer != null) window.clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressStart = null;
  };
  const allowsLongPress = (event) => {
    const interactive = event.target.closest?.("button, input, textarea, select");
    return !interactive || interactive.classList.contains("mobile-task-main");
  };
  wrapper.addEventListener("pointerdown", (event) => {
    if (
      !isMobileSheet() ||
      mobileUi.inlineEditor ||
      mobileUi.reorderMode ||
      mobileUi.addParentPick ||
      mobileUi.transitioning ||
      mobileUi.rowMenuId ||
      !allowsLongPress(event)
    ) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    longPressStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    longPressTriggered = false;
    longPressTimer = window.setTimeout(() => {
      if (!longPressStart) return;
      longPressTriggered = true;
      suppressRowClickUntil = performance.now() + 700;
      cancelLongPress();
      openMobileRowMenu(node.id);
    }, 500);
  });
  wrapper.addEventListener("pointermove", (event) => {
    if (!longPressStart || event.pointerId !== longPressStart.pointerId) return;
    if (Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 8) cancelLongPress();
  });
  wrapper.addEventListener("pointerup", (event) => {
    if (longPressStart?.pointerId === event.pointerId) cancelLongPress();
  });
  wrapper.addEventListener("pointercancel", cancelLongPress);
  wrapper.addEventListener("click", (event) => {
    if (longPressTriggered || performance.now() < suppressRowClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      longPressTriggered = false;
    }
  }, true);
  return wrapper;
}

function renderMobileBreadcrumbs() {
  if (!el.mobileBreadcrumbs) return;
  el.mobileBreadcrumbs.innerHTML = "";
  el.mobileBreadcrumbs.hidden = !mobileUi.navRootId;
  if (!mobileUi.navRootId) return;
  const entries = [{ id: null, title: t("mobile.allItems") }];
  for (const node of outlineAncestorChain(doc, mobileUi.navRootId)) {
    entries.push({ id: node.id, title: mobileNodeTitle(node) });
  }
  entries.forEach((entry, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "mobile-breadcrumb-separator";
      separator.textContent = "/";
      el.mobileBreadcrumbs.appendChild(separator);
    }
    if (index === entries.length - 1) {
      const current = document.createElement("span");
      current.textContent = entry.title;
      current.setAttribute("aria-current", "page");
      el.mobileBreadcrumbs.appendChild(current);
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mobile-breadcrumb-btn";
      button.textContent = entry.title;
      button.addEventListener("click", () => {
        if (mobileUi.transitioning) return;
        mobileUi.navRootId = entry.id;
        mobileUi.inlineEditor = null;
        mobileUi.reorderMode = false;
        renderMobileActive({ transition: "back" });
        pushMobileHistoryState();
      });
      el.mobileBreadcrumbs.appendChild(button);
    }
  });
}

function createMobileScreen() {
  const screen = document.createElement("div");
  screen.className = "mobile-active-list mobile-screen";
  screen.setAttribute("role", "list");
  return screen;
}

function renderMobileActive({ transition = null } = {}) {
  if (!el.mobileActiveList) return;
  const stack = el.mobileScreenStack;
  if (transition && stack && !mobileUi.transitioning) {
    const oldScreen = el.mobileActiveList;
    const nextScreen = createMobileScreen();
    oldScreen.id = "";
    nextScreen.id = "mobile-active-list";
    stack.appendChild(nextScreen);
    el.mobileActiveList = nextScreen;
    mobileUi.transitioning = true;
    const token = ++mobileTransitionToken;
    oldScreen.classList.add("mobile-screen-old");
    nextScreen.classList.add("mobile-screen-new");
    stack.classList.add("is-mobile-screen-transition", `is-mobile-screen-transition-${transition}`);
    const finish = () => {
      if (token !== mobileTransitionToken) return;
      oldScreen.remove();
      nextScreen.classList.remove("mobile-screen-new");
      stack.classList.remove(
        "is-mobile-screen-transition",
        "is-mobile-screen-transition-running",
        `is-mobile-screen-transition-${transition}`
      );
      mobileUi.transitioning = false;
    };
    nextScreen.addEventListener("transitionend", finish, { once: true });
    if (prefersReducedMotion()) {
      finish();
    } else {
      window.setTimeout(finish, 340);
      requestAnimationFrame(() => stack.classList.add("is-mobile-screen-transition-running"));
    }
  }
  normalizeMobileUiState();
  const navRoot = mobileUi.navRootId ? doc.nodes[mobileUi.navRootId] : null;
  const dueSort = doc.ui.activeSort === "due-asc";
  const searching = !!doc.ui.activeQuery.trim();
  if (el.mobileCurrentHeading) {
    if (navRoot) {
      el.mobileCurrentHeading.hidden = false;
      el.mobileCurrentHeading.textContent = mobileNodeTitle(navRoot);
    } else {
      el.mobileCurrentHeading.hidden = true;
      el.mobileCurrentHeading.textContent = "";
    }
    el.mobileCurrentHeading.tabIndex = -1;
  }
  if (el.btnMobileBack) el.btnMobileBack.hidden = !mobileUi.navRootId;
  if (el.mobileActiveSurface) {
    if (navRoot) {
      el.mobileActiveSurface.setAttribute("aria-labelledby", "mobile-current-heading");
      el.mobileActiveSurface.removeAttribute("aria-label");
    } else {
      el.mobileActiveSurface.removeAttribute("aria-labelledby");
      el.mobileActiveSurface.setAttribute("aria-label", t("mobile.allItems"));
    }
  }
  renderMobileBreadcrumbs();

  if (el.btnMobileDisplayMode) {
    const outline = mobileUi.displayMode === "outline";
    el.btnMobileDisplayMode.hidden = dueSort || searching || mobileUi.addParentPick;
    el.btnMobileDisplayMode.setAttribute("aria-pressed", outline ? "false" : "true");
    el.btnMobileDisplayMode.setAttribute(
      "aria-label",
      t(outline ? "mobile.displayBranch" : "mobile.displayOutline")
    );
    const outlineIcon = el.btnMobileDisplayMode.querySelector(".mobile-display-icon--outline");
    const branchIcon = el.btnMobileDisplayMode.querySelector(".mobile-display-icon--branch");
    if (outlineIcon) outlineIcon.hidden = !outline;
    if (branchIcon) branchIcon.hidden = outline;
  }
  if (el.btnMobileDueSort) {
    el.btnMobileDueSort.classList.toggle("is-on", dueSort);
    el.btnMobileDueSort.setAttribute("aria-pressed", dueSort ? "true" : "false");
    el.btnMobileDueSort.setAttribute("aria-label", dueSort ? t("dueSort.off") : t("dueSort.on"));
    el.btnMobileDueSort.hidden = searching || mobileUi.addParentPick;
  }
  if (el.btnMobileSearch) {
    const searchOpen = el.mobileSearchBar && !el.mobileSearchBar.hidden;
    el.btnMobileSearch.hidden = mobileUi.addParentPick;
    el.btnMobileSearch.classList.toggle("is-on", searchOpen);
    el.btnMobileSearch.setAttribute("aria-pressed", searchOpen ? "true" : "false");
  }
  if (el.mobileSearchQuery && document.activeElement !== el.mobileSearchQuery) {
    el.mobileSearchQuery.value = doc.ui.activeQuery || "";
  }
  if (el.mobileReorderHeader) el.mobileReorderHeader.hidden = !mobileUi.reorderMode;
  if (el.mobileAddParentBar) el.mobileAddParentBar.hidden = !mobileUi.addParentPick;
  if (el.btnMobileReorder) {
    el.btnMobileReorder.hidden = searching || dueSort || mobileUi.addParentPick;
    el.btnMobileReorder.classList.toggle("is-on", mobileUi.reorderMode);
    el.btnMobileReorder.setAttribute("aria-pressed", mobileUi.reorderMode ? "true" : "false");
  }

  const parentId = mobileUi.quickAdd.parentId;
  const parent = parentId ? doc.nodes[parentId] : null;
  if (el.mobileAddUnder) {
    el.mobileAddUnder.textContent = t("mobile.addUnder", {
      name: parentId && !parent ? t("mobile.parentUnavailable") : parent ? mobileNodeTitle(parent) : t("mobile.allItems"),
    });
  }
  if (el.mobileQuickAdd) el.mobileQuickAdd.hidden = !mobileUi.quickAdd.open;
  if (el.btnMobileV2Add) {
    el.btnMobileV2Add.hidden =
      mobileUi.quickAdd.open || mobileUi.reorderMode || mobileUi.addParentPick || searching;
    el.btnMobileV2Add.textContent =
      !mobileUi.navRootId && isCategoryMode() && mobileUi.displayMode === "branch"
        ? t("mobile.addCategory")
        : t("mobile.addItem");
  }

  if (el.mobileActiveList) {
    el.mobileActiveList.classList.toggle("is-add-parent-pick", mobileUi.addParentPick);
  }

  el.mobileActiveList.innerHTML = "";
  const rows = mobileRows();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "mobile-empty-state";
    const message = document.createElement("strong");
    message.textContent = mobileUi.navRootId ? t("mobile.emptyBranch") : t("mobile.emptyRoot");
    empty.appendChild(message);
    if (navRoot) {
      const hint = document.createElement("span");
      hint.textContent = t("mobile.emptyBranchHint", { title: mobileNodeTitle(navRoot) });
      empty.appendChild(hint);
    }
    el.mobileActiveList.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const rowElement = renderMobileTaskRow(row);
    if (rowElement) el.mobileActiveList.appendChild(rowElement);
  }
}

function renderActive() {
  syncActiveFilterUi();
  syncBodyUiClasses();
  renderZoomBar();
  if (syncMobileSurfaceVisibility()) {
    renderMobileActive();
    return;
  }
  if (el.activeOutline) el.activeOutline.hidden = false;
  el.activeOutline.innerHTML = "";
  const dueSort = doc.ui.activeSort === "due-asc";
  const rows = visibleActiveRows();
  const paint = (list) => {
    // Due-sort + categories: one frame per category. Due-sort alone: one shared frame.
    const categoryDue = dueSort && isCategoryMode();
    appendOutlineRows(
      el.activeOutline,
      list,
      (row) =>
        renderRow(getNode(row.id), {
          displayDepth: row.displayDepth,
          showDueMeta: dueSort,
          isZoomRoot: row.isZoomRoot,
          contextParent: row.contextParent,
        }),
      { groupAll: dueSort && !categoryDue, groupRoots: !dueSort || categoryDue }
    );
  };
  if (!rows.length) {
    ensureActiveRoot();
    const again = visibleActiveRows();
    if (!again.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      if (activeFiltersActive()) {
        empty.textContent = t("empty.activeSearch");
      } else if (dueSort && !doc.ui.dueShowUndated) {
        empty.textContent = t("empty.activeDue");
      } else if (doc.ui.zoomId) {
        empty.textContent = t("empty.activeZoom");
      } else {
        empty.textContent = t("empty.active");
      }
      el.activeOutline.appendChild(empty);
      return;
    }
    paint(again);
    return;
  }
  paint(rows);
}

function renderArchive() {
  syncArchiveFilterUi();
  syncArchiveToolHint();
  el.archiveOutline.innerHTML = "";
  const signature = archiveViewSignature();
  if (archiveState.signature !== signature && !archiveState.loading) {
    void loadArchivePage({ reset: true });
    return;
  }
  if (archiveState.loading) {
    const loading = document.createElement("div");
    loading.className = "empty-state";
    loading.textContent = "…";
    el.archiveOutline.appendChild(loading);
    if (el.archiveLoadMore) el.archiveLoadMore.hidden = true;
    return;
  }
  const rows = visibleArchiveIds();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    if (!countAllCompleted()) {
      empty.textContent = t("empty.archive");
    } else if (archiveFiltersActive()) {
      empty.innerHTML =
        t("empty.archiveSearch") + '<br><button type="button" class="pop-btn pop-btn--sm" id="empty-clear-filters">' + t("empty.archiveClear") + "</button>";
      el.archiveOutline.appendChild(empty);
      empty.querySelector("#empty-clear-filters")?.addEventListener("click", clearArchiveFilters);
      if (el.archiveLoadMore) el.archiveLoadMore.hidden = true;
      return;
    } else {
      empty.textContent = t("empty.generic");
    }
    el.archiveOutline.appendChild(empty);
    if (el.archiveLoadMore) el.archiveLoadMore.hidden = true;
    return;
  }
  appendOutlineRows(el.archiveOutline, rows, (row) =>
    renderRow(getNode(row.id), {
      displayDepth: row.displayDepth,
      contextParent: row.contextParent,
      showCompletedMeta: !row.contextParent,
    })
  );
  if (el.archiveLoadMore) {
    el.archiveLoadMore.hidden = !archiveState.hasMore;
    el.archiveLoadMore.disabled = archiveState.loading;
  }
}

function isMobileSheet() {
  return window.matchMedia?.(MOBILE_SHEET_MQ)?.matches === true;
}

function setSheetLevel(level) {
  if (level !== "closed" && level !== "peek" && level !== "expanded") return;
  sheetLevel = level;
  syncSheetUi();
}

function syncSheetUi() {
  const pane = el.detailPane;
  const backdrop = el.detailSheetBackdrop;
  const handle = el.detailSheetHandle;
  if (!pane) return;

  const mobile = isMobileSheet();
  const mobileV2Active = mobile && !el.mobileActiveSurface?.hidden;
  const open = mobile && !!doc.selectedId && (mobileV2Active ? mobileUi.detailsOpen : sheetLevel !== "closed");
  document.body.classList.toggle("has-mobile-sheet", open);

  // Mobile v2 never uses peek; details are expanded-only.
  if (mobileV2Active && !mobileUi.detailsOpen && sheetLevel !== "closed") {
    sheetLevel = "closed";
  }
  const level = mobileV2Active && open ? "expanded" : sheetLevel;
  const detailAnim = mobileUi.detailSheetAnim;
  const showExpanded =
    open && level === "expanded" && detailAnim !== "opening" && detailAnim !== "closing";
  pane.classList.toggle("is-sheet-peek", open && level === "peek");
  pane.classList.toggle("is-sheet-expanded", showExpanded);
  pane.classList.toggle("is-sheet-closed", mobile && (!open || level === "closed"));
  pane.classList.toggle("is-mobile-v2-hidden", mobileV2Active && !open && detailAnim !== "closing");

  if (handle) {
    handle.hidden = !open || (mobileV2Active && open);
    handle.setAttribute(
      "aria-label",
      level === "expanded" ? t("detail.sheetCollapse") : t("detail.sheetExpand")
    );
  }

  if (backdrop) {
    const showBackdrop = open && level === "expanded" && detailAnim !== "opening";
    backdrop.hidden = !showBackdrop && detailAnim !== "closing";
    backdrop.classList.toggle("is-visible", showBackdrop);
  }

  if (!mobile) {
    document.body.classList.remove("has-mobile-sheet");
    pane.classList.remove("is-sheet-peek", "is-sheet-expanded", "is-sheet-closed", "is-sheet-dragging");
    pane.style.transform = "";
    if (handle) handle.hidden = true;
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove("is-visible");
    }
  }
}

function collapseOrCloseSheet() {
  if (!isMobileSheet() || sheetLevel === "closed") {
    clearInputAndSelection();
    return;
  }
  if (!el.mobileActiveSurface?.hidden) {
    requestMobileV2Back();
    return;
  }
  if (sheetLevel === "expanded") {
    setSheetLevel("peek");
    return;
  }
  clearInputAndSelection();
}

let archiveDetailRequestId = 0;

async function loadArchiveDetail(id) {
  const requestId = ++archiveDetailRequestId;
  const node = await storage.getArchiveNode(id);
  if (!node || requestId !== archiveDetailRequestId) return;
  archiveState.payloads.set(id, node);
  archiveState.nodes[id] = { ...node, archivePayloadLoaded: true };
  if (doc.ui.tab === "archive" && doc.selectedId === id) renderDetail();
}

function renderDetail() {
  const n = getNode(doc.selectedId);
  if (!n) {
    syncMobileMoveActions(null);
    el.detailEmpty.hidden = false;
    el.detailBody.hidden = true;
    el.detailPane?.classList.add("is-empty");
    el.detailTitle.value = "";
    el.detailNote.value = "";
    el.detailMeta.replaceChildren();
    if (el.detailCategory) {
      el.detailCategory.hidden = true;
      el.detailCategory.textContent = "";
    }
    if (el.detailDue) {
      el.detailDue.value = "";
      el.detailDue.disabled = true;
      syncDetailDuePickerState("", true);
    }
    if (el.detailDueClear) el.detailDueClear.hidden = true;
    if (el.btnZoomIn) el.btnZoomIn.hidden = true;
    if (el.btnToggleDone) el.btnToggleDone.hidden = false;
    sheetLevel = "closed";
    syncSheetUi();
    return;
  }
  if (doc.ui.tab === "archive" && isCompleted(n) && !n.archivePayloadLoaded && !archiveState.payloads.has(n.id)) {
    void loadArchiveDetail(n.id);
  }
  el.detailEmpty.hidden = true;
  el.detailBody.hidden = false;
  el.detailPane?.classList.remove("is-empty");
  el.detailTitle.value = n.title;
  el.detailNote.value = n.note;
  el.detailNote.disabled = isCompleted(n);
  if (el.detailDue) {
    const dueValue = dueAtToDateInput(n.dueAt);
    el.detailDue.value = dueValue;
    el.detailDue.disabled = isCompleted(n);
    syncDetailDuePickerState(dueValue, isCompleted(n));
  }
  if (el.detailDueClear) {
    el.detailDueClear.hidden = n.dueAt == null || isCompleted(n);
  }

  const category = categoryRootOf(n.id);
  if (el.detailCategory) {
    if (category) {
      el.detailCategory.hidden = false;
      el.detailCategory.textContent = category.title || t("untitledParen");
    } else {
      el.detailCategory.hidden = true;
      el.detailCategory.textContent = "";
    }
  }

  const parent = n.parentId ? getNode(n.parentId) : null;
  const progress = childProgress(n.id);
  const metaLines = [
    t("detail.parent", { name: parent ? parent.title || t("untitledParen") : t("detail.none") }),
    t("detail.created", { date: formatDate(n.createdAt) }),
  ];
  if (n.dueAt != null) {
    metaLines.push(t("detail.dueMeta", { date: formatDateShort(n.dueAt) }));
  }
  if (progress && progress.total > 0 && !isCategoryNode(n)) {
    metaLines.push(t("detail.childProgress", { done: progress.done, total: progress.total }));
  }
  if (doc.ui.tab === "archive" || isCompleted(n)) {
    metaLines.push(t("detail.completedAt", { date: formatDate(n.completedAt) }));
  }
  el.detailMeta.replaceChildren();
  metaLines.forEach((line, index) => {
    if (index > 0) el.detailMeta.appendChild(document.createElement("br"));
    el.detailMeta.appendChild(document.createTextNode(line));
  });

  const asCategory = isCategoryNode(n) && !isCompleted(n);
  if (el.btnToggleDone) {
    el.btnToggleDone.hidden = asCategory;
    el.btnToggleDone.textContent = isCompleted(n) ? t("detail.restore") : t("detail.complete");
  }
  syncMobileMoveActions(n);
  el.detailTitle.readOnly = isCompleted(n);
  const mobileV2Active = isMobileSheet() && !el.mobileActiveSurface?.hidden;
  if (el.btnZoomIn) {
    const canZoom = doc.ui.tab === "active" && isActive(n);
    const focused = canZoom && doc.ui.zoomId === n.id;
    el.btnZoomIn.hidden = !canZoom;
    el.btnZoomIn.classList.toggle("is-focused", focused);
    el.btnZoomIn.setAttribute("aria-pressed", focused ? "true" : "false");
    el.btnZoomIn.textContent = focused ? t("detail.focusOff") : t("detail.focus");
    el.btnZoomIn.title = focused ? t("detail.focusOffTitle") : t("detail.focusTitle");
    el.btnZoomIn.setAttribute("aria-label", focused ? t("detail.focusOffAria") : t("detail.focusAria"));
    if (mobileV2Active) el.btnZoomIn.hidden = true;
  }

  if (isMobileSheet()) {
    if (!el.mobileActiveSurface?.hidden) {
      sheetLevel = mobileUi.detailsOpen ? "expanded" : "closed";
    }
    else if (sheetLevel === "closed") sheetLevel = "peek";
  } else {
    sheetLevel = "closed";
  }
  syncSheetUi();
}

function render() {
  syncBodyUiClasses();
  if (doc.ui.tab === "active") renderActive();
  else {
    renderZoomBar();
    renderArchive();
  }
  renderDetail();
  applyPendingEnters();
}

function extendSelectionBy(delta) {
  const ids = currentVisibleIds();
  const cur = doc.selectedId;
  if (!cur || !ids.length) return;
  const idx = ids.indexOf(cur);
  if (idx < 0) return;
  const next = ids[Math.max(0, Math.min(ids.length - 1, idx + delta))];
  if (!rangeAnchorId) rangeAnchorId = cur;
  const a = ids.indexOf(rangeAnchorId);
  const b = ids.indexOf(next);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  rangeIds = ids.slice(lo, hi + 1);
  doc.selectedId = next;
  syncSelectionClasses();
  renderDetail();
  if (doc.ui.tab === "active") {
    // Keep caret at end so continued typing isn't blocked; don't select-all
    focusTitle(next, { selectAll: false });
  }
  saveDoc();
}

function deleteSelectedNodes() {
  const ids = [...new Set(rangeIds.length ? rangeIds : doc.selectedId ? [doc.selectedId] : [])];
  if (!ids.length) return false;
  // Only delete roots of the selection (skip nodes whose ancestor is also selected)
  const roots = ids.filter((id) => {
    let cur = getNode(id);
    while (cur?.parentId) {
      if (ids.includes(cur.parentId)) return false;
      cur = getNode(cur.parentId);
    }
    return true;
  });
  return deleteNodesWithUndo(roots);
}

function onTitlePaste(e) {
  const id = e.currentTarget.dataset.id;
  if (!id || doc.ui.tab !== "active") return;
  const text = e.clipboardData?.getData("text/plain") || "";
  if (!text.includes("\n")) return;
  const trees = parseOutlinePaste(text);
  if (!trees.length) return;
  e.preventDefault();
  endCoalesce();
  insertOutlineTrees(id, trees);
}

function onTitleKeydown(e) {
  const id = e.currentTarget.dataset.id;
  if (!id) return;
  const meta = e.ctrlKey || e.metaKey;
  const input = e.currentTarget;

  if (e.key === "Tab") {
    e.preventDefault();
    endCoalesce();
    if (doc.ui.tab !== "active") return;
    if (doc.ui.activeSort === "due-asc") return;
    if (e.shiftKey) outdentNode(id);
    else indentNode(id);
    return;
  }

  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    endCoalesce();
    if (doc.ui.tab !== "active") return;
    if (meta) {
      e.stopPropagation();
      if (!isCategoryNode(getNode(id))) completeNode(id);
      return;
    }
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const value = input.value || "";
    if (start === end && start === 0 && value.length > 0) {
      insertSiblingAbove(id);
      return;
    }
    if (start !== end || (start > 0 && start < value.length)) {
      splitNodeAtCaret(id, start);
      return;
    }
    insertSiblingBelow(id);
    return;
  }

  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && meta && !e.shiftKey) {
    e.preventDefault();
    endCoalesce();
    reorderAmongSiblings(id, e.key === "ArrowUp" ? -1 : 1);
    return;
  }

  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.shiftKey && !meta) {
    e.preventDefault();
    extendSelectionBy(e.key === "ArrowUp" ? -1 : 1);
    return;
  }

  if (e.key === "ArrowUp" && !meta && !e.shiftKey) {
    e.preventDefault();
    moveSelection(-1);
    return;
  }
  if (e.key === "ArrowDown" && !meta && !e.shiftKey) {
    e.preventDefault();
    moveSelection(1);
    return;
  }
  if (e.key === "ArrowLeft" && meta) {
    e.preventDefault();
    handleArrowLeft();
    return;
  }
  if (e.key === "ArrowRight" && meta) {
    e.preventDefault();
    handleArrowRight();
    return;
  }

  if (meta && e.key.toLowerCase() === ".") {
    e.preventDefault();
    e.stopPropagation();
    endCoalesce();
    if (doc.ui.tab === "active") setZoom(id);
    return;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    endCoalesce();
    if (doc.ui.zoomId && doc.ui.tab === "active") {
      zoomOut();
      return;
    }
    if (isMobileSheet() && sheetLevel === "expanded") {
      setSheetLevel("peek");
      return;
    }
    clearInputAndSelection();
    return;
  }

  if (e.key === "Delete" && meta) {
    e.preventDefault();
    endCoalesce();
    deleteSelectedNodes();
    return;
  }

}

async function exportJson() {
  const fullDoc = await storage.exportDocument(doc);
  const blob = new Blob([JSON.stringify(fullDoc, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `taskliner-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      pushHistory();
      skipPersist = false;
      const imported = migrateDoc(JSON.parse(String(reader.result)));
      doc = splitDocument(imported).doc;
      invalidateArchiveView();
      rangeIds = doc.selectedId ? [doc.selectedId] : [];
      rangeAnchorId = rangeIds[0] || null;
      history.future = [];
      applyTheme(doc.ui.theme);
      setTab(doc.ui.tab);
      render();
      void storage.replaceDocument(imported);
    } catch {
      alert(t("file.importFail"));
    }
  };
  reader.readAsText(file);
}

/**
 * Replace the current document with the first-run tutorial outline.
 * @param {{ confirmReplace?: boolean, quiet?: boolean }} [opts]
 */
function loadTutorial(opts = {}) {
  const confirmReplace = opts.confirmReplace !== false;
  if (confirmReplace) {
    const ok = window.confirm(
      t("tutorial.reloadConfirm")
    );
    if (!ok) return false;
  }
  pushHistory();
  skipPersist = false;
  const tutorial = tutorialDoc();
  doc = splitDocument(tutorial).doc;
  invalidateArchiveView();
  rangeIds = [];
  rangeAnchorId = null;
  history.future = [];
  applyTheme(doc.ui.theme);
  setTab(doc.ui.tab);
  render();
  void storage.replaceDocument(tutorial);
  const check = verifyTutorialDoc(tutorial);
  if (!opts.quiet) {
    if (check.ok) showNoticeToast(t("tutorial.loaded"));
    else showNoticeToast(t("tutorial.verifyError", { error: check.errors[0] }));
  }
  return check.ok;
}

// --- events ---

for (const btn of el.tabs) {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
}

function showSoonToast(message) {
  showNoticeToast(message);
}

el.btnExport.addEventListener("click", () => {
  closeAllToolPops();
  closeFileDialog();
  exportJson();
});
el.btnImport.addEventListener("change", () => {
  const file = el.btnImport.files?.[0];
  if (file) importJson(file);
  el.btnImport.value = "";
  closeAllToolPops();
  closeFileDialog();
});

function tutorialUrl() {
  try {
    return new URL("./tutorial/", location.href).toString();
  } catch {
    return "./tutorial/";
  }
}

function storageFlag(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function setStorageFlag(key) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Optional onboarding state should not block the editor.
  }
}

function syncTutorialLinks() {
  const url = tutorialUrl();
  for (const link of document.querySelectorAll('a[href="./tutorial/"]')) {
    link.href = url;
  }
}

function syncStarterGuide() {
  if (!el.starterGuide) return;
  el.starterGuide.hidden = storageFlag(STARTER_DISMISSED_KEY);
}

function closeStarterDialog() {
  closeAppDialog(el.starterDialog);
}

function markStarterDialogSeen() {
  setStorageFlag(STARTER_DIALOG_SEEN_KEY);
}

function maybeOpenStarterDialog() {
  if (!el.starterDialog || storageFlag(STARTER_DIALOG_SEEN_KEY)) return;
  if (skipPersist || guidedTutorialLocation) return;
  if (!isMobileSheet()) return;
  markStarterDialogSeen();
  openAppDialog(el.starterDialog);
}

function dismissStarterGuide() {
  setStorageFlag(STARTER_DISMISSED_KEY);
  syncStarterGuide();
  showNoticeToast(t("starter.dismissedToast"));
}

syncTutorialLinks();
syncStarterGuide();

if (el.btnStarterDismiss) {
  el.btnStarterDismiss.addEventListener("click", dismissStarterGuide);
}
if (el.btnStarterDialogClose) {
  el.btnStarterDialogClose.addEventListener("click", () => {
    markStarterDialogSeen();
    closeStarterDialog();
  });
}
if (el.btnStarterDialogLater) {
  el.btnStarterDialogLater.addEventListener("click", () => {
    markStarterDialogSeen();
    closeStarterDialog();
  });
}
if (el.starterDialog) {
  el.starterDialog.addEventListener("click", (e) => {
    if (e.target === el.starterDialog) {
      markStarterDialogSeen();
      closeStarterDialog();
    }
  });
  el.starterDialog.addEventListener("cancel", () => {
    markStarterDialogSeen();
  });
}

for (const opt of el.themeOptions) {
  opt.addEventListener("click", () => {
    const next = normalizeTheme(opt.dataset.themeId);
    if (doc.ui.theme === next) {
      closeAllToolPops();
      closeThemeDialog();
      return;
    }
    applyTheme(next);
    render();
    saveDoc();
    closeAllToolPops();
    closeThemeDialog();
  });
}
if (el.btnAccount) {
  el.btnAccount.addEventListener("click", () => openAccountDialog());
}

function updateGoogleAuthButton() {
  if (!el.btnAccount) return;
  const connected = googleAuth.hasToken();
  const titleKey = connected
    ? "login.connectedTitle"
    : googleAuth.isAvailable()
      ? "login.connectTitle"
      : "login.unavailableTitle";
  const label = el.btnAccount.querySelector("[data-google-auth-label]");
  el.btnAccount.dataset.i18nTitle = titleKey;
  el.btnAccount.dataset.i18nAriaLabel = connected ? "login.connected" : "login";
  el.btnAccount.title = t(titleKey);
  el.btnAccount.setAttribute("aria-label", t(connected ? "login.connected" : "login"));
  if (label) label.textContent = t(connected ? "login.connected" : "login");
}

function e2eeId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function downloadJsonFile(value, filename) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function presentRecoveryFile(recoveryFile) {
  const serialized = JSON.stringify(recoveryFile);
  pendingRecoveryFile = recoveryFile;
  recoveryExported = false;
  if (el.recoveryCopyValue) el.recoveryCopyValue.value = serialized;
  if (el.recoveryQr) {
    const qrValue = `taskliner-recovery-v1:${recoveryFile.recoveryKey}`;
    el.recoveryQr.innerHTML = encodeQrSvg(qrValue, { margin: 3, scale: 4 }).svg;
  }
  if (el.recoveryStatus) el.recoveryStatus.textContent = "";
  openAppDialog(el.recoveryDialog);
  return new Promise((resolve) => { recoveryDialogResolver = resolve; });
}

function finishRecoveryDialog(saved) {
  if (saved && !recoveryExported) {
    if (el.recoveryStatus) el.recoveryStatus.textContent = t("recovery.exportRequired");
    return;
  }
  closeAppDialog(el.recoveryDialog);
  const resolve = recoveryDialogResolver;
  recoveryDialogResolver = null;
  pendingRecoveryFile = null;
  resolve?.(saved);
}

function setText(target, value) {
  if (target) target.textContent = value;
}

function setSyncPrimary(action, labelKey, { hidden = false, disabled = false } = {}) {
  if (!el.btnSyncPrimary) return;
  el.btnSyncPrimary.dataset.action = action;
  el.btnSyncPrimary.textContent = t(labelKey);
  el.btnSyncPrimary.hidden = hidden;
  el.btnSyncPrimary.disabled = disabled;
}

function renderSyncOverview({ status, schedulerStatus, error = null, transferring = false, realtimeDegraded = false }) {
  if (!el.syncOverview) return;
  const expectedLock = syncV3Enabled && status.authorized && status.locked && !!status.workspaceId;
  const setupRequired = syncV3Enabled && status.authorized && ["unconfigured", "legacy", "migrating", "unknown"].includes(status.e2eeStatus);
  let state = "disconnected";
  let kickerKey = "sync.overview.localKicker";
  let titleKey = "sync.overview.localTitle";
  let descriptionKey = pendingPairingFragment ? "sync.overview.inviteDisconnectedDescription" : "sync.overview.localDescription";

  setSyncPrimary("connect", status.reauthorizeRequired ? "login.sync.reconnect" : pendingPairingFragment ? "deviceLink.connect" : "login.sync.connect", {
    disabled: !googleAuth.isAvailable(),
  });

  if (!googleAuth.isAvailable()) {
    state = "unavailable";
    titleKey = "sync.overview.unavailableTitle";
    descriptionKey = "sync.overview.unavailableDescription";
    setSyncPrimary("connect", "login.sync.connect", { disabled: true });
  } else if (!status.authorized) {
    if (pendingPairingFragment) {
      state = "actionRequired";
      kickerKey = "deviceLink.progress1";
      titleKey = "sync.overview.inviteTitle";
    }
  } else if (status.accountMismatch) {
    state = "error";
    kickerKey = "sync.overview.attentionKicker";
    titleKey = "sync.overview.accountMismatchTitle";
    descriptionKey = "login.sync.accountMismatch";
    setSyncPrimary("switch-account", "sync.overview.switchAccount");
  } else if (status.reauthorizeRequired) {
    state = "actionRequired";
    kickerKey = "sync.overview.attentionKicker";
    titleKey = "sync.overview.reconnectTitle";
    descriptionKey = "sync.overview.reconnectDescription";
    setSyncPrimary("connect", "login.sync.reconnect");
  } else if (expectedLock) {
    state = "actionRequired";
    kickerKey = "deviceLink.progress2";
    titleKey = pendingPairingFragment ? "sync.overview.inviteReadyTitle" : "sync.overview.verifyTitle";
    descriptionKey = pendingPairingFragment ? "sync.overview.inviteReadyDescription" : "sync.overview.verifyDescription";
    setSyncPrimary("open-device-link", "sync.overview.continueDevice");
  } else if (setupRequired) {
    state = "actionRequired";
    kickerKey = "sync.overview.preparingKicker";
    titleKey = "sync.overview.setupTitle";
    descriptionKey = "sync.overview.setupDescription";
    setSyncPrimary("setup", "sync.overview.finishSetup");
  } else if (!schedulerStatus.online) {
    state = "offline";
    kickerKey = "sync.overview.offlineKicker";
    titleKey = "sync.overview.offlineTitle";
    descriptionKey = "sync.overview.offlineDescription";
    setSyncPrimary("sync", "login.sync.syncNow", { disabled: true });
  } else if (status.syncPaused || status.remoteMissing) {
    state = "actionRequired";
    kickerKey = "sync.overview.attentionKicker";
    titleKey = status.syncPaused ? "sync.overview.pausedTitle" : "sync.overview.remoteMissingTitle";
    descriptionKey = status.syncPaused ? "login.sync.paused" : "login.sync.remoteMissing";
    setSyncPrimary("sync", "sync.overview.resume");
  } else if (transferring) {
    state = "syncing";
    kickerKey = "sync.overview.connectedKicker";
    titleKey = "sync.overview.syncingTitle";
    descriptionKey = "sync.overview.syncingDescription";
    setSyncPrimary("sync", "login.sync.syncing", { disabled: true });
  } else if (error || status.lastError) {
    state = "error";
    kickerKey = "sync.overview.attentionKicker";
    titleKey = "sync.overview.errorTitle";
    descriptionKey = "sync.overview.errorDescription";
    setSyncPrimary("sync", "sync.overview.retry");
  } else {
    state = realtimeDegraded ? "degraded" : "synced";
    kickerKey = "sync.overview.connectedKicker";
    titleKey = realtimeDegraded ? "sync.overview.delayedTitle" : "sync.overview.syncedTitle";
    descriptionKey = realtimeDegraded ? "sync.overview.delayedDescription" : "sync.overview.syncedDescription";
    setSyncPrimary(realtimeDegraded ? "sync" : "add-device", realtimeDegraded ? "sync.overview.retry" : "sync.overview.addAnotherDevice");
  }

  el.syncOverview.dataset.state = state;
  setText(el.syncOverviewKicker, t(kickerKey));
  setText(el.syncOverviewTitle, t(titleKey));
  setText(el.syncOverviewDescription, t(descriptionKey));
  if (el.syncManageDetails) el.syncManageDetails.hidden = !status.authorized || expectedLock || setupRequired;
  if (el.btnSyncManageAddDevice) el.btnSyncManageAddDevice.hidden = status.locked || status.e2eeStatus !== "encrypted-active";
  if (el.btnSyncManageRecovery) el.btnSyncManageRecovery.hidden = status.locked || status.e2eeStatus !== "encrypted-active";
}

function setDeviceLinkStep(currentStep, { completeAll = false } = {}) {
  for (const item of el.deviceLinkSteps?.querySelectorAll("[data-device-link-step]") || []) {
    const step = item.dataset.deviceLinkStep;
    const order = { account: 1, verify: 2, sync: 3 };
    item.classList.toggle("is-active", !completeAll && step === currentStep);
    item.classList.toggle("is-complete", completeAll || order[step] < order[currentStep]);
  }
}

function setDeviceLinkPhase(phase, { error = null, words = [] } = {}) {
  const phaseChanged = deviceLinkPhase !== phase;
  deviceLinkPhase = phase;
  const config = {
    connect: ["account", "deviceLink.progress1", "deviceLink.connectTitle", "deviceLink.connectDescription"],
    choose: ["verify", "deviceLink.progress2", "deviceLink.existingFoundTitle", "deviceLink.existingFoundDescription"],
    code: ["verify", "deviceLink.progress2", "deviceLink.codeTitle", "deviceLink.codeDescription"],
    requesting: ["verify", "deviceLink.progress2", "deviceLink.requestingTitle", "deviceLink.requestingDescription"],
    waiting: ["verify", "deviceLink.progress2", "deviceLink.waitingTitle", "deviceLink.waitingDescription"],
    confirm: ["verify", "deviceLink.progress2", "deviceLink.confirmTitle", "deviceLink.confirmDescription"],
    unlocking: ["verify", "deviceLink.progress2", "deviceLink.unlockingTitle", "deviceLink.unlockingDescription"],
    syncing: ["sync", "deviceLink.progress3", "deviceLink.syncingTitle", "deviceLink.syncingDescription"],
    complete: ["sync", "deviceLink.progress3", "deviceLink.completeTitle", "deviceLink.completeDescription"],
    error: ["verify", "deviceLink.attention", "deviceLink.errorTitle", "deviceLink.errorDescription"],
  }[phase] || ["account", "", "", ""];
  setDeviceLinkStep(config[0], { completeAll: phase === "complete" });
  setText(el.deviceLinkKicker, t(config[1]));
  setText(el.deviceLinkStageTitle, t(config[2]));
  setText(el.deviceLinkDescription, t(config[3]));
  const busyKey = {
    requesting: "deviceLink.requestingBusy",
    waiting: "deviceLink.waitingBusy",
    unlocking: "deviceLink.unlockingBusy",
    syncing: "deviceLink.syncingBusy",
  }[phase] || "";
  if (el.deviceLinkBusy) el.deviceLinkBusy.hidden = !busyKey;
  setText(el.deviceLinkBusyText, busyKey ? t(busyKey) : "");
  el.deviceLinkDialog?.setAttribute("aria-busy", busyKey ? "true" : "false");
  setText(el.deviceLinkStatus, error ? pairingErrorMessage(error) : "");
  if (el.deviceLinkStatus) el.deviceLinkStatus.classList.toggle("is-error", !!error);
  if (el.deviceLinkChoices) el.deviceLinkChoices.hidden = phase !== "choose";
  if (el.deviceLinkCodeForm) el.deviceLinkCodeForm.hidden = phase !== "code";
  if (el.deviceLinkConfirm) el.deviceLinkConfirm.hidden = phase !== "confirm";
  if (el.deviceLinkWords) el.deviceLinkWords.textContent = words.join(" · ");
  if (phase === "complete") deviceLinkRequired = false;
  const mustFinishOrChooseLocal = deviceLinkRequired && phase !== "complete";
  if (el.btnDeviceLinkClose) el.btnDeviceLinkClose.hidden = mustFinishOrChooseLocal;
  const canChooseLocal = mustFinishOrChooseLocal && !["requesting", "unlocking", "syncing"].includes(phase);
  if (el.btnDeviceLinkUseLocal) el.btnDeviceLinkUseLocal.hidden = !canChooseLocal;
  if (el.btnDeviceLinkPrimary) {
    const primary = phase === "connect"
      ? ["connect", "deviceLink.connect"]
      : phase === "complete"
        ? ["close", "deviceLink.done"]
        : phase === "error"
          ? ["retry", "deviceLink.retry"]
          : null;
    el.btnDeviceLinkPrimary.hidden = !primary;
    if (primary) {
      el.btnDeviceLinkPrimary.dataset.action = primary[0];
      el.btnDeviceLinkPrimary.textContent = t(primary[1]);
    }
  }
  if (phaseChanged) {
    window.requestAnimationFrame(() => {
      const body = el.deviceLinkDialog?.querySelector(".help-dialog-body");
      if (body) body.scrollTop = 0;
    });
  }
}

async function makeRecoveryWrapper({ workspaceId, keyId, wdk }) {
  const recoveryKey = generateRecoveryKey();
  const wrapper = await createRecoveryKeyWrapper({
    workspaceId,
    keyId,
    wrapperId: e2eeId("recovery"),
    recoveryKey,
    wdk,
  });
  const recoveryFile = createRecoveryFile({ workspaceId, keyId, recoveryKey });
  const verified = await unwrapRecoveryKeyWrapper(wrapper, recoveryKey, { expectedWorkspaceId: workspaceId, expectedKeyId: keyId });
  if (JSON.stringify([...verified]) !== JSON.stringify([...wdk])) throw new Error(t("e2ee.recoveryRequired"));
  return { wrapper, recoveryFile };
}

async function setupEncryptedSync() {
  if (!syncV3Enabled || !googleAuth.hasToken()) return;
  syncUiPhase = "checking";
  updateSyncUi();
  try {
    if (typeof driveSync.refreshStatus === "function") await syncOperations.run(() => driveSync.refreshStatus());
    const currentStatus = driveSync.getStatus();
    if (currentStatus.e2eeStatus === "migrating" && driveSync.getWorkspaceKey()) {
      await syncOperations.run(() => driveSync.migrateLegacy());
      const discordSettings = await integrationSettings.readDiscord({ fresh: true });
      await syncOperations.run(() => driveSync.pushSharedSetting(discordSettings.webhookUrl ? discordSettings : null));
      syncScheduler.start();
      startRealtimeChannel();
      showNoticeToast(t("e2ee.setupComplete"));
      return;
    }
    const migrationLockExpiresAt = Date.parse(currentStatus.migrationLockExpiresAt || "");
    const migrationLockActive = !Number.isFinite(migrationLockExpiresAt) || migrationLockExpiresAt > Date.now();
    if (currentStatus.e2eeStatus === "migrating" && migrationLockActive) {
      throw new E2eeMigrationLockedError(t("e2ee.migrationLocked"));
    }
    const material = await driveSync.createWorkspaceKeyMaterial();
    const wrappers = [];
    let passkey = null;
    try {
      passkey = await createTasklinerPasskey(material);
    } catch {
      passkey = null;
    }
    if (passkey?.prfSupported) {
      const passkeyWrapper = await createPasskeyKeyWrapper({
        ...material,
        wrapperId: e2eeId("passkey"),
        credentialId: passkey.credentialId,
        prfSalt: passkey.prfSalt,
        prfResult: passkey.prfResult,
      });
      const verifiedPasskeyWdk = await unwrapPasskeyKeyWrapper(passkeyWrapper, passkey.prfResult, {
        expectedWorkspaceId: material.workspaceId,
        expectedKeyId: material.keyId,
      });
      if (JSON.stringify([...verifiedPasskeyWdk]) !== JSON.stringify([...material.wdk])) throw new Error(t("e2ee.noPasskey"));
      wrappers.push(passkeyWrapper);
    }
    const recovery = await makeRecoveryWrapper(material);
    if (!await presentRecoveryFile(recovery.recoveryFile)) throw new Error(t("e2ee.recoveryRequired"));
    wrappers.push(recovery.wrapper);
    syncUiPhase = "sending";
    updateSyncUi();
    try {
      const setupStatus = driveSync.getStatus();
      if (["legacy", "migrating"].includes(setupStatus.e2eeStatus) && setupStatus.legacyCount > 0) {
        await syncOperations.run(() => driveSync.migrateLegacy({ wrappers }));
      } else {
        const discordSettings = await integrationSettings.readDiscord({ fresh: true });
        await syncOperations.run(() => driveSync.activateNewWorkspace({ wrappers, sharedSetting: discordSettings.webhookUrl ? discordSettings : null }));
      }
    } catch (error) {
      if (error?.code === "legacy_exists") {
        await syncOperations.run(() => driveSync.migrateLegacy({ wrappers }));
      } else if (error?.code === "migration_locked") {
        await driveSync.discardWorkspaceKey();
        if (typeof driveSync.refreshStatus === "function") await syncOperations.run(() => driveSync.refreshStatus()).catch(() => undefined);
        throw new E2eeMigrationLockedError(t("e2ee.migrationLocked"));
      } else if (error?.code === "workspace_initialized") {
        await driveSync.discardWorkspaceKey();
        try { await syncDriveNow({ interactive: false }); } catch { /* refresh remote workspace identity */ }
        throw new E2eeSyncLockedError();
      } else {
        throw error;
      }
    }
    const discordSettings = await integrationSettings.readDiscord({ fresh: true });
    await syncOperations.run(() => driveSync.pushSharedSetting(discordSettings.webhookUrl ? discordSettings : null));
    syncScheduler.start();
    startRealtimeChannel();
    showNoticeToast(t("e2ee.setupComplete"));
  } catch (error) {
    updateSyncUi(error);
  } finally {
    syncUiPhase = null;
    updateSyncUi();
  }
}

async function unlockEncryptedSyncWithPasskey() {
  setDeviceLinkPhase("unlocking");
  try {
    const wrappers = (await driveSync.listKeyWrappers()).filter((wrapper) => wrapper.kind === "passkey-prf");
    if (!wrappers.length) throw new Error(t("e2ee.noPasskey"));
    const wrapper = wrappers[0];
    const prfResult = await getTasklinerPasskeyPrf(wrapper);
    await driveSync.unlockWithPasskey(wrapper, prfResult);
    setDeviceLinkPhase("syncing");
    await syncDriveNow({ interactive: false });
    syncScheduler.start();
    startRealtimeChannel();
    updateSyncUi();
    setDeviceLinkPhase("complete");
  } catch (error) {
    setDeviceLinkPhase("error", { error });
    updateSyncUi(error);
  }
}

async function unlockEncryptedSyncWithRecoveryFile(file) {
  setDeviceLinkPhase("unlocking");
  try {
    const parsed = parseRecoveryFile(JSON.parse(await file.text()));
    await unlockEncryptedSyncWithRecoveryKey(parsed.recoveryKey, parsed);
  } catch (error) {
    setDeviceLinkPhase("error", { error });
    updateSyncUi(error);
  } finally {
    if (el.deviceLinkRecoveryInput) el.deviceLinkRecoveryInput.value = "";
  }
}

async function unlockEncryptedSyncWithRecoveryKey(recoveryKey, expected = {}) {
  setDeviceLinkPhase("unlocking");
  const wrappers = (await driveSync.listKeyWrappers()).filter((wrapper) =>
    wrapper.kind === "recovery"
      && (!expected.workspaceId || wrapper.workspaceId === expected.workspaceId)
      && (!expected.keyId || wrapper.keyId === expected.keyId)
  );
  let unlocked = false;
  for (const wrapper of wrappers) {
    try {
      await driveSync.unlockWithRecovery(wrapper, recoveryKey);
      unlocked = true;
      break;
    } catch {
      // A raw QR recovery key may need to be tried against more than one saved wrapper.
    }
  }
  if (!unlocked) throw new Error(t("e2ee.noRecovery"));
  setDeviceLinkPhase("syncing");
  await syncDriveNow({ interactive: false });
  syncScheduler.start();
  startRealtimeChannel();
  updateSyncUi();
  setDeviceLinkPhase("complete");
}

async function unlockEncryptedSyncWithRecoveryCode() {
  const raw = window.prompt(t("e2ee.recoveryCodePrompt"));
  if (!raw) return;
  try {
    const match = /^taskliner-recovery-v1:([A-Za-z0-9_-]+)$/u.exec(raw.trim());
    if (!match) throw new Error(t("e2ee.noRecovery"));
    const recoveryKey = base64urlDecode(match[1], "recovery key");
    if (recoveryKey.length !== 32) throw new Error(t("e2ee.noRecovery"));
    await unlockEncryptedSyncWithRecoveryKey(recoveryKey);
  } catch (error) {
    setDeviceLinkPhase("error", { error });
    updateSyncUi(error);
  }
}

async function createAdditionalRecoveryFile() {
  try {
    const status = driveSync.getStatus();
    const wdk = driveSync.getWorkspaceKey();
    if (!wdk || !status.workspaceId || !status.keyId) throw new E2eeSyncLockedError();
    const recovery = await makeRecoveryWrapper({ workspaceId: status.workspaceId, keyId: status.keyId, wdk });
    if (!await presentRecoveryFile(recovery.recoveryFile)) return;
    await driveSync.uploadKeyWrapper(recovery.wrapper);
    showNoticeToast(t("e2ee.recoveryCreated"));
  } catch (error) {
    updateSyncUi(error);
  }
}

function clearPairingPoll() {
  if (pairingPollTimer !== null) window.clearTimeout(pairingPollTimer);
  pairingPollTimer = null;
}

const PAIRING_POLL_RETRY_LIMIT = 4;

function isRetryablePairingPollError(error) {
  return Number(error?.status) >= 500
    || Number(error?.status) === 408
    || Number(error?.status) === 429
    || error?.code === "sync_v3_unavailable";
}

function retryPairingPoll(run, error) {
  if (!isRetryablePairingPollError(error) || pairingPollRetryCount >= PAIRING_POLL_RETRY_LIMIT) return false;
  pairingPollRetryCount += 1;
  const delay = Math.min(8_000, 1_000 * (2 ** (pairingPollRetryCount - 1)));
  pairingPollTimer = window.setTimeout(run, delay);
  return true;
}

function pairingErrorMessage(error) {
  return isRetryablePairingPollError(error) ? t("pairing.temporaryError") : (error?.message || t("pairing.failed"));
}

function pairingDisplayError(error) {
  if (!isRetryablePairingPollError(error)) return error;
  const displayed = new Error(t("pairing.temporaryError"));
  displayed.status = error.status;
  displayed.code = error.code;
  return displayed;
}

function setPairingStep(currentStep, { completeAll = false } = {}) {
  const order = { invite: 1, verify: 2, finish: 3 };
  for (const item of el.pairingSteps?.querySelectorAll("[data-pairing-step]") || []) {
    const step = item.dataset.pairingStep;
    item.classList.toggle("is-active", !completeAll && step === currentStep);
    item.classList.toggle("is-complete", completeAll || order[step] < order[currentStep]);
  }
}

function setPairingPhase(phase, { error = null } = {}) {
  const phaseChanged = pairingPhase !== phase;
  pairingPhase = phase;
  const currentStep = {
    preparing: "invite",
    invite: "verify",
    review: "verify",
    approving: "verify",
    waiting: "finish",
    complete: "finish",
    error: "verify",
  }[phase] || "invite";
  setPairingStep(currentStep, { completeAll: phase === "complete" });

  const busyKey = {
    preparing: "pairing.preparing",
    invite: "pairing.waitingRequest",
    approving: "pairing.approving",
    waiting: "pairing.waitingNewDevice",
  }[phase] || "";
  if (el.pairingBusy) el.pairingBusy.hidden = !busyKey;
  setText(el.pairingBusyText, busyKey ? t(busyKey) : "");
  el.pairingDialog?.setAttribute("aria-busy", busyKey ? "true" : "false");

  if (el.pairingInvite) el.pairingInvite.hidden = phase !== "invite";
  if (el.pairingRequest) el.pairingRequest.hidden = !["review", "approving", "waiting"].includes(phase);
  if (el.pairingReviewActions) el.pairingReviewActions.hidden = phase !== "review";
  if (el.pairingComplete) el.pairingComplete.hidden = phase !== "complete";
  if (el.btnPairingApprove) el.btnPairingApprove.disabled = phase !== "review";
  setText(el.pairingReviewDescription, phase === "waiting" ? t("pairing.waitingDescription") : t("pairing.reviewDescription"));
  setText(el.pairingStatus, error ? pairingErrorMessage(error) : phase === "review" ? t("pairing.checkWords") : "");
  if (el.pairingStatus) el.pairingStatus.classList.toggle("is-error", !!error);
  if (phaseChanged) {
    window.requestAnimationFrame(() => {
      const body = el.pairingDialog?.querySelector(".help-dialog-body");
      if (body) body.scrollTop = 0;
    });
  }
}

async function artifactWasDeleted(kind, artifactId) {
  const artifacts = await driveSync.listArtifacts(kind);
  return !artifacts.some((entry) => entry?.artifactId === artifactId);
}

async function cleanupExpiredPairingArtifacts() {
  for (const kind of ["pairing-offer", "pairing-request", "pairing-response"]) {
    const artifacts = await driveSync.listArtifacts(kind);
    for (const artifact of artifacts) {
      if (Number(artifact?.payload?.expiresAt) <= Date.now() && artifact?.artifactId) {
        await driveSync.deleteArtifact(kind, artifact.artifactId);
      }
    }
  }
}

function pairingAccount() {
  const status = driveSync.getStatus();
  if (!status.accountId) throw new Error(t("pairing.sameAccount"));
  return status;
}

async function openDeviceInvitation() {
  clearPairingPoll();
  pairingPollRetryCount = 0;
  closeAppDialog(el.accountDialog);
  setPairingPhase("preparing");
  openAppDialog(el.pairingDialog);
  try {
    const status = pairingAccount();
    await cleanupExpiredPairingArtifacts();
    const wdk = driveSync.getWorkspaceKey();
    if (!wdk || !status.workspaceId || !status.keyId || !status.deviceId) throw new E2eeSyncLockedError();
    inviterPairing = await createPairingOffer({
      workspaceId: status.workspaceId,
      keyId: status.keyId,
      inviterDeviceId: status.deviceId,
      inviterDeviceName: status.deviceName,
      accountId: status.accountId,
      registry: pairingRegistry,
    });
    await driveSync.putArtifact("pairing-offer", inviterPairing.offer.offerId, inviterPairing.offer);
    const url = new URL(location.href);
    // A unique, non-secret query value forces iOS Safari to perform a real
    // navigation even when Taskliner is already open in an existing tab.
    url.searchParams.set("pairing", inviterPairing.offer.offerId);
    url.hash = inviterPairing.qrFragment.slice(1);
    if (el.pairingQr) el.pairingQr.innerHTML = encodeQrSvg(url.href, { margin: 3, scale: 4 }).svg;
    if (el.pairingCode) el.pairingCode.textContent = inviterPairing.inviteCode;
    setPairingPhase("invite");
    pollPairingRequest();
  } catch (error) {
    setPairingPhase("error", { error });
    updateSyncUi(error);
  }
}

function pollPairingRequest() {
  clearPairingPoll();
  pairingPollRetryCount = 0;
  const run = async () => {
    if (!inviterPairing) return;
    try {
      if (Date.now() >= inviterPairing.offer.expiresAt) {
        await cancelCurrentPairing();
        throw new Error(t("pairing.expired"));
      }
      const artifacts = await driveSync.listArtifacts("pairing-request");
      pairingPollRetryCount = 0;
      const entry = artifacts.find((artifact) => artifact?.payload?.offerId === inviterPairing.offer.offerId);
      if (entry) {
        const inspected = await inspectPairingRequest({
          offer: inviterPairing.offer,
          request: entry.payload,
          inviterPrivateKey: inviterPairing.inviterPrivateKey,
          inviteSecret: inviterPairing.inviteSecret,
          accountId: pairingAccount().accountId,
          registry: pairingRegistry,
        });
        inviterPairing.request = entry.payload;
        inviterPairing.requestArtifactId = entry.artifactId;
        inviterPairing.confirmationWords = inspected.confirmationWords;
        if (el.pairingDeviceName) el.pairingDeviceName.textContent = t("pairing.requestFrom", { device: inspected.requesterDeviceName });
        if (el.pairingWords) el.pairingWords.textContent = inspected.confirmationWords.join(" · ");
        setPairingPhase("review");
        return;
      }
    } catch (error) {
      if (retryPairingPoll(run, error)) return;
      setPairingPhase("error", { error });
      return;
    }
    pairingPollTimer = window.setTimeout(run, 2_000);
  };
  void run();
}

async function approveCurrentPairing() {
  if (!inviterPairing?.request) return;
  setPairingPhase("approving");
  try {
    const result = await approvePairingRequest({
      offer: inviterPairing.offer,
      request: inviterPairing.request,
      inviterPrivateKey: inviterPairing.inviterPrivateKey,
      inviteSecret: inviterPairing.inviteSecret,
      accountId: pairingAccount().accountId,
      wdk: driveSync.getWorkspaceKey(),
      registry: pairingRegistry,
    });
    await driveSync.deleteArtifact("pairing-request", inviterPairing.requestArtifactId);
    await driveSync.deleteArtifact("pairing-offer", inviterPairing.offer.offerId);
    const consumed = await Promise.all([
      artifactWasDeleted("pairing-request", inviterPairing.requestArtifactId),
      artifactWasDeleted("pairing-offer", inviterPairing.offer.offerId),
    ]);
    if (!consumed.every(Boolean)) throw new Error(t("pairing.consumeFailed"));
    await driveSync.putArtifact("pairing-response", result.response.responseId, result.response);
    inviterPairing.responseArtifactId = result.response.responseId;
    inviterPairing.responseObserved = false;
    setPairingPhase("waiting");
    pairingPollRetryCount = 0;
    pollPairingCompletion();
  } catch (error) {
    setPairingPhase("error", { error });
  }
}

function pollPairingCompletion() {
  clearPairingPoll();
  pairingPollRetryCount = 0;
  const run = async () => {
    if (!inviterPairing?.responseArtifactId) return;
    try {
      if (Date.now() >= inviterPairing.offer.expiresAt) throw new Error(t("pairing.expired"));
      const artifacts = await driveSync.listArtifacts("pairing-response");
      pairingPollRetryCount = 0;
      const responseExists = artifacts.some((entry) => entry?.artifactId === inviterPairing.responseArtifactId);
      if (responseExists) inviterPairing.responseObserved = true;
      if (!responseExists && inviterPairing.responseObserved) {
        inviterPairing = null;
        setPairingPhase("complete");
        showNoticeToast(t("pairing.existingComplete"));
        return;
      }
    } catch (error) {
      if (retryPairingPoll(run, error)) return;
      setPairingPhase("error", { error });
      return;
    }
    pairingPollTimer = window.setTimeout(run, inviterPairing?.responseObserved ? 2_000 : 250);
  };
  void run();
}

async function cancelCurrentPairing() {
  clearPairingPoll();
  const current = inviterPairing;
  inviterPairing = null;
  try {
    if (current?.requestArtifactId) await driveSync.deleteArtifact("pairing-request", current.requestArtifactId);
    if (current?.offer?.offerId) await driveSync.deleteArtifact("pairing-offer", current.offer.offerId);
  } catch {
    // Expired artifacts are removed by the next pairing cleanup request.
  }
  pairingPhase = "idle";
  closeAppDialog(el.pairingDialog);
}

function openDeviceLinkDialog({ autoStart = true } = {}) {
  closeAllToolPops();
  closeAppDialog(el.accountDialog);
  const status = driveSync.getStatus();
  deviceLinkRequired = status.authorized && status.locked && !!status.workspaceId;
  if (!status.authorized) {
    setDeviceLinkPhase("connect");
  } else if (!status.locked && status.e2eeStatus === "encrypted-active") {
    setDeviceLinkPhase("complete");
  } else if (pendingPairingFragment && autoStart) {
    setDeviceLinkPhase("requesting");
  } else {
    setDeviceLinkPhase("choose");
  }
  openAppDialog(el.deviceLinkDialog);
  if (status.authorized && status.locked && pendingPairingFragment && autoStart && !requesterPairing) {
    void requestExistingDeviceApproval();
  }
}

function capturePairingInviteFromLocation() {
  if (!String(location.hash || "").startsWith("#taskliner-pair=")) return false;
  const fragment = capturePairingFragment();
  if (!fragment) return false;
  pendingPairingFragment = fragment;
  updateSyncUi();
  if (!skipPersist) openDeviceLinkDialog({ autoStart: googleAuth.hasToken() });
  return true;
}

async function closeDeviceLinkDialog({ clearInvite = true, force = false } = {}) {
  if (deviceLinkRequired && deviceLinkPhase !== "complete" && !force) return;
  clearPairingPoll();
  deviceLinkConfirmResolver?.(false);
  deviceLinkConfirmResolver = null;
  const current = requesterPairing;
  requesterPairing = null;
  if (current?.request?.requestId) {
    await driveSync.deleteArtifact("pairing-request", current.request.requestId).catch(() => undefined);
  }
  if (clearInvite) {
    pendingPairingFragment = "";
    try { sessionStorage.removeItem(PAIRING_FRAGMENT_SESSION_KEY); } catch { /* optional session cleanup */ }
  }
  deviceLinkPhase = "idle";
  deviceLinkRequired = false;
  closeAppDialog(el.deviceLinkDialog);
  updateSyncUi();
}

async function useThisDeviceWithoutSync() {
  stopRealtimeChannel();
  syncScheduler.stop();
  deviceLinkRequired = false;
  await closeDeviceLinkDialog({ clearInvite: true, force: true });
  await driveSync.disconnect();
  updateSyncUi();
  showSoonToast(t("deviceLink.localReady"));
}

function confirmPairingWords(words) {
  setDeviceLinkPhase("confirm", { words });
  return new Promise((resolve) => { deviceLinkConfirmResolver = resolve; });
}

async function requestExistingDeviceApproval() {
  if (requesterPairing) return;
  try {
    setDeviceLinkPhase("requesting");
    const status = pairingAccount();
    await cleanupExpiredPairingArtifacts();
    const artifacts = await driveSync.listArtifacts("pairing-offer");
    pairingPollRetryCount = 0;
    let requested = null;
    let secret = null;
    let offerId = null;
    if (pendingPairingFragment) {
      const parsed = parsePairingQrFragment(pendingPairingFragment);
      offerId = parsed.offerId;
      secret = parsed.inviteSecret;
    }
    const candidates = artifacts.filter((entry) => !offerId || entry?.payload?.offerId === offerId);
    const inviteCode = el.deviceLinkInviteCode?.value.trim() || "";
    for (const entry of candidates) {
      try {
        const created = await createPairingRequest({
          offer: entry.payload,
          ...(secret ? { inviteSecret: secret } : { inviteCode }),
          requesterDeviceId: status.deviceId,
          requesterDeviceName: status.deviceName,
          accountId: status.accountId,
          registry: pairingRegistry,
        });
        requested = { ...created, offer: entry.payload };
        break;
      } catch {
        // A manual code may need to be matched against more than one active offer.
      }
    }
    if (!requested) throw new Error(t("pairing.codeNotFound"));
    requesterPairing = requested;
    await driveSync.putArtifact("pairing-request", requested.request.requestId, requested.request);
    setDeviceLinkPhase("waiting");
    pollPairingResponse();
  } catch (error) {
    requesterPairing = null;
    const displayedError = pairingDisplayError(error);
    setDeviceLinkPhase("error", { error: displayedError });
    updateSyncUi(displayedError);
  }
}

function pollPairingResponse() {
  clearPairingPoll();
  pairingPollRetryCount = 0;
  const run = async () => {
    if (!requesterPairing) return;
    try {
      if (Date.now() >= requesterPairing.offer.expiresAt) {
        await driveSync.deleteArtifact("pairing-request", requesterPairing.request.requestId).catch(() => undefined);
        await driveSync.deleteArtifact("pairing-offer", requesterPairing.offer.offerId).catch(() => undefined);
        throw new Error(t("pairing.expired"));
      }
      const artifacts = await driveSync.listArtifacts("pairing-response");
      pairingPollRetryCount = 0;
      const entry = artifacts.find((artifact) => artifact?.payload?.requestId === requesterPairing.request.requestId);
      if (entry) {
        const result = await acceptPairingResponse({
          offer: requesterPairing.offer,
          request: requesterPairing.request,
          response: entry.payload,
          requesterPrivateKey: requesterPairing.requesterPrivateKey,
          inviteSecret: requesterPairing.inviteSecret,
          accountId: pairingAccount().accountId,
          registry: pairingRegistry,
        });
        if (!await confirmPairingWords(result.confirmationWords)) {
          throw new Error(t("pairing.wordsRejected"));
        }
        deviceLinkConfirmResolver = null;
        await driveSync.persistWorkspaceKey(result.wdk, {
          workspaceId: requesterPairing.offer.workspaceId,
          keyId: requesterPairing.offer.keyId,
        });
        await syncDriveNow({ interactive: false });
        await driveSync.deleteArtifact("pairing-response", entry.artifactId);
        await driveSync.deleteArtifact("pairing-request", requesterPairing.request.requestId).catch(() => undefined);
        if (!await artifactWasDeleted("pairing-response", entry.artifactId)) throw new Error(t("pairing.consumeFailed"));
        requesterPairing = null;
        pendingPairingFragment = "";
        try { sessionStorage.removeItem(PAIRING_FRAGMENT_SESSION_KEY); } catch { /* optional session cleanup */ }
        syncScheduler.start();
        startRealtimeChannel();
        updateSyncUi();
        setDeviceLinkPhase("complete");
        showNoticeToast(t("pairing.complete"));
        return;
      }
    } catch (error) {
      if (retryPairingPoll(run, error)) return;
      requesterPairing = null;
      setDeviceLinkPhase("error", { error });
      updateSyncUi(error);
      return;
    }
    pairingPollTimer = window.setTimeout(run, 2_000);
  };
  void run();
}

function updateSyncUi(error = null) {
  const status = driveSync.getStatus();
  const schedulerStatus = syncScheduler.getStatus();
  const transferring = syncUiPhase === "sending" || syncUiPhase === "receiving" || syncUiPhase === "checking";
  const syncReadyForRealtime = !syncV3Enabled || status.e2eeStatus === "encrypted-active";
  const realtimeDegraded = syncReadyForRealtime && (status.realtimeState === "disconnected" || status.realtimeState === "error");
  const expectedLock = syncV3Enabled && status.authorized && status.locked && !!status.workspaceId;
  const setupRequired = syncV3Enabled && status.authorized && ["unconfigured", "legacy", "migrating", "unknown"].includes(status.e2eeStatus);
  const expectedSetupError = error instanceof E2eeSyncLockedError || error instanceof E2eeSetupRequiredError || error instanceof E2eeMigrationLockedError;
  let headerState = "disconnected";
  let headerKey = "sync.header.disconnected";
  if (!googleAuth.isAvailable()) {
    headerState = "unavailable";
    headerKey = "sync.header.unavailable";
  } else if (!status.authorized) {
    headerState = pendingPairingFragment ? "actionRequired" : "disconnected";
    headerKey = pendingPairingFragment ? "sync.header.finishDevice" : "sync.header.disconnected";
  } else if (status.accountMismatch) {
    headerState = status.accountMismatch ? "accountMismatch" : "error";
    headerKey = status.accountMismatch ? "sync.header.accountMismatch" : "sync.header.error";
  } else if (status.reauthorizeRequired) {
    headerState = "actionRequired";
    headerKey = "sync.header.reconnect";
  } else if (expectedLock || setupRequired || expectedSetupError) {
    headerState = "actionRequired";
    headerKey = expectedLock ? "sync.header.finishDevice" : "sync.header.finishSetup";
  } else if (error) {
    headerState = "error";
    headerKey = "sync.header.error";
  } else if (!schedulerStatus.online) {
    headerState = "offline";
    headerKey = "sync.header.offline";
  } else if (status.syncPaused) {
    headerState = "paused";
    headerKey = "sync.header.paused";
  } else if (status.remoteMissing) {
    headerState = "paused";
    headerKey = "sync.header.remoteMissing";
  } else if (syncUiPhase === "sending") {
    headerState = "sending";
    headerKey = "sync.header.sending";
  } else if (syncUiPhase === "receiving") {
    headerState = "receiving";
    headerKey = "sync.header.receiving";
  } else if (syncUiPhase === "checking") {
    headerState = "checking";
    headerKey = "sync.header.checking";
  } else if (status.lastError) {
    headerState = "error";
    headerKey = "sync.header.error";
  } else if (status.localDirty || schedulerStatus.pushQueued) {
    headerState = "preparing";
    headerKey = "sync.header.preparing";
  } else if (realtimeDegraded) {
    headerState = "degraded";
    headerKey = "sync.header.degraded";
  } else if (status.hasSynced && status.lastSyncedAt) {
    headerState = "synced";
    headerKey = "sync.header.synced";
  } else {
    headerState = "ready";
    headerKey = "sync.header.ready";
  }
  if (el.headerSyncStatus) {
    const label = t(headerKey);
    el.headerSyncStatus.dataset.state = headerState;
    el.headerSyncStatus.title = status.lastSyncedAt && headerState === "synced"
      ? `${label}: ${new Date(status.lastSyncedAt).toLocaleString()}`
      : label;
    if (el.headerSyncLabel) el.headerSyncLabel.textContent = label;
    el.headerSyncStatus.hidden = !status.authorized;
  }
  if (el.syncStatus) {
    if (!googleAuth.isAvailable()) el.syncStatus.textContent = t("login.sync.unavailable");
    else if (error instanceof ServerSyncAccountMismatchError || error instanceof E2eeAccountMismatchError || status.accountMismatch) el.syncStatus.textContent = t("login.sync.accountMismatch");
    else if (expectedLock || error instanceof E2eeSyncLockedError) el.syncStatus.textContent = t("sync.overview.verifyStatus");
    else if (error instanceof E2eeSetupRequiredError) el.syncStatus.textContent = t("sync.overview.setupStatus");
    else if (error instanceof E2eeMigrationLockedError) el.syncStatus.textContent = t("e2ee.migrationLocked");
    else if (error instanceof ServerSyncAuthorizationRequiredError) el.syncStatus.textContent = t("login.sync.needsGoogle");
    else if (error instanceof ServerAuthUnavailableError || error instanceof ServerSyncUnavailableError) el.syncStatus.textContent = t("login.sync.unavailable");
    else if (error) el.syncStatus.textContent = t("login.sync.error", { error: error.message || "" });
    else if (!status.authorized) el.syncStatus.textContent = pendingPairingFragment ? t("sync.overview.inviteStatus") : "";
    else if (status.reauthorizeRequired) el.syncStatus.textContent = t("sync.overview.reconnectDescription");
    else if (transferring) el.syncStatus.textContent = t("login.sync.syncing");
    else if (status.lastError && !expectedLock && !setupRequired) el.syncStatus.textContent = t("login.sync.error", { error: status.lastError });
    else if (status.syncPaused) el.syncStatus.textContent = t("login.sync.paused");
    else if (status.remoteMissing) el.syncStatus.textContent = t("login.sync.remoteMissing");
    else if (realtimeDegraded) el.syncStatus.textContent = t("login.sync.realtimeUnavailable");
    else if (status.lastSyncedAt) el.syncStatus.textContent = t("login.sync.lastSynced", { date: new Date(status.lastSyncedAt).toLocaleString() });
    else el.syncStatus.textContent = "";
  }
  if (el.btnSyncDisconnect) {
    el.btnSyncDisconnect.disabled = !status.authorized;
    el.btnSyncDisconnect.hidden = !status.authorized;
  }
  updateGoogleAuthButton();
  renderSyncOverview({ status, schedulerStatus, error: expectedSetupError ? null : error, transferring, realtimeDegraded });
}

function openAccountDialog() {
  closeAllToolPops();
  updateSyncUi();
  openAppDialog(el.accountDialog);
}

async function connectGoogleFromDialog() {
  if (!googleAuth.isAvailable()) return;
  if (syncV3Enabled && !googleAuth.hasToken() && !syncEncryptionExplainerShown && !pendingPairingFragment) {
    syncEncryptionExplainerShown = true;
    const accepted = await new Promise((resolve) => {
      const finish = (value) => {
        closeAppDialog(el.syncEncryptionExplainer);
        el.btnSyncEncryptionExplainerAccept?.removeEventListener("click", accept);
        el.btnSyncEncryptionExplainerCancel?.removeEventListener("click", cancel);
        el.btnSyncEncryptionExplainerClose?.removeEventListener("click", cancel);
        resolve(value);
      };
      const accept = () => finish(true);
      const cancel = () => finish(false);
      el.btnSyncEncryptionExplainerAccept?.addEventListener("click", accept);
      el.btnSyncEncryptionExplainerCancel?.addEventListener("click", cancel);
      el.btnSyncEncryptionExplainerClose?.addEventListener("click", cancel);
      openAppDialog(el.syncEncryptionExplainer);
    });
    if (!accepted) return;
  }
  syncUiPhase = "connecting";
  updateSyncUi();
  if (el.syncStatus) el.syncStatus.textContent = t("login.connecting");
  try {
    googleAuth.connect({ reauthorize: driveSync.getStatus().reauthorizeRequired });
  } catch (error) {
    syncUiPhase = null;
    updateSyncUi(error);
    showSoonToast(t("login.error"));
  }
}

async function syncFromDialog() {
  if (!googleAuth.isAvailable()) return;
  syncUiPhase = "checking";
  updateSyncUi();
  try {
    let resumed = false;
    const status = driveSync.getStatus();
    if (status.syncPaused || status.remoteMissing) {
      const confirmKey = status.syncPaused ? "login.sync.resumeConfirm" : "login.sync.remoteMissingConfirm";
      if (!window.confirm(t(confirmKey))) return;
      if (el.syncStatus) el.syncStatus.textContent = t("login.sync.syncing");
      await syncOperations.run(() => driveSync.resumeSync());
      if (driveSync.getStatus().localDirty) syncScheduler.noteLocalChange();
      else syncScheduler.clearLocalChanges();
      resumed = true;
    }
    if (el.syncStatus) el.syncStatus.textContent = t("login.sync.syncing");
    if (!resumed) await syncDriveNow({ interactive: false });
    syncScheduler.start();
    startRealtimeChannel();
  } catch (error) {
    if (error instanceof E2eeSetupRequiredError) await setupEncryptedSync();
    else if (error instanceof E2eeSyncLockedError) {
      updateSyncUi(error);
      openDeviceLinkDialog();
    } else updateSyncUi(error);
  } finally {
    syncUiPhase = null;
    updateSyncUi();
  }
}

async function restoreGoogleConnection() {
  await driveSync.load();
  const restored = await googleAuth.restore?.();
  updateSyncUi();
  if (!restored) {
    if (pendingPairingFragment) openDeviceLinkDialog({ autoStart: false });
    return;
  }
  syncUiPhase = "checking";
  updateSyncUi();
  try {
    await syncDriveNow({ interactive: false });
    if (!driveSync.getStatus().syncPaused) syncScheduler.start();
    startRealtimeChannel();
  } catch (error) {
    if (error instanceof E2eeSetupRequiredError) await setupEncryptedSync();
    else if (error instanceof E2eeSyncLockedError) {
      updateSyncUi(error);
      openDeviceLinkDialog();
    } else updateSyncUi(error);
  } finally {
    syncUiPhase = null;
    updateSyncUi();
  }
}

function clearRealtimeReconnect() {
  if (realtimeReconnectTimer !== null) window.clearTimeout(realtimeReconnectTimer);
  realtimeReconnectTimer = null;
}

function scheduleRealtimeReconnect() {
  if (!realtimeEnabled || realtimeReconnectTimer !== null || !googleAuth.hasToken() || navigator.onLine === false || document.visibilityState !== "visible") return;
  const delay = Math.min(60_000, 1_000 * (2 ** realtimeReconnectAttempt));
  realtimeReconnectAttempt = Math.min(realtimeReconnectAttempt + 1, 16);
  realtimeReconnectTimer = window.setTimeout(() => {
    realtimeReconnectTimer = null;
    connectRealtimeChannel();
  }, delay);
}

function handleRealtimeStatus({ state }) {
  const connected = state === "connected";
  syncScheduler.setRealtimeConnected(connected);
  if (connected) {
    realtimeReconnectAttempt = 0;
    clearRealtimeReconnect();
    if (realtimeNeedsCatchup && !foregroundSyncInProgress) {
      realtimeNeedsCatchup = false;
      void syncOnForeground();
    }
  } else if ((state === "disconnected" || state === "error") && !foregroundSyncInProgress) {
    scheduleRealtimeReconnect();
  }
  updateSyncUi();
}

function connectRealtimeChannel() {
  if (!realtimeEnabled || navigator.onLine === false || document.visibilityState !== "visible") return;
  const started = driveSync.connectRealtime({
    onStatus: handleRealtimeStatus,
    onChange: async () => {
      syncUiPhase = "receiving";
      updateSyncUi();
      try {
        await syncOperations.run(() => driveSync.pull({ interactive: false }));
      } catch (error) {
        updateSyncUi(error);
        realtimeNeedsCatchup = true;
        syncScheduler.setRealtimeConnected(false);
        driveSync.disconnectRealtime();
        scheduleRealtimeReconnect();
      } finally {
        syncUiPhase = null;
        updateSyncUi();
      }
    },
  });
  if (!started) scheduleRealtimeReconnect();
}

async function syncOnForeground() {
  if (!realtimeEnabled || !googleAuth.hasToken() || navigator.onLine === false || document.visibilityState !== "visible") return;
  if (foregroundSyncPromise) return foregroundSyncPromise;

  foregroundSyncInProgress = true;
  foregroundSyncPromise = (async () => {
    clearRealtimeReconnect();
    syncScheduler.setRealtimeConnected(false);
    driveSync.disconnectRealtime();
    syncUiPhase = "checking";
    updateSyncUi();
    try {
      await syncDriveNow({ interactive: false });
      if (!driveSync.getStatus().syncPaused) syncScheduler.start();
    } catch (error) {
      updateSyncUi(error);
    } finally {
      syncUiPhase = null;
      updateSyncUi();
      if (realtimeEnabled && document.visibilityState === "visible" && navigator.onLine !== false) connectRealtimeChannel();
      foregroundSyncInProgress = false;
    }
  })().finally(() => {
    foregroundSyncPromise = null;
  });
  return foregroundSyncPromise;
}

function startRealtimeChannel() {
  realtimeEnabled = true;
  connectRealtimeChannel();
}

function stopRealtimeChannel() {
  realtimeEnabled = false;
  realtimeReconnectAttempt = 0;
  realtimeNeedsCatchup = false;
  clearRealtimeReconnect();
  foregroundSyncPromise = null;
  foregroundSyncInProgress = false;
  syncScheduler.setRealtimeConnected(false);
  driveSync.disconnectRealtime();
}

if (el.btnSyncPrimary) {
  el.btnSyncPrimary.addEventListener("click", async () => {
    const action = el.btnSyncPrimary.dataset.action;
    if (action === "connect") await connectGoogleFromDialog();
    else if (action === "open-device-link") openDeviceLinkDialog();
    else if (action === "add-device") await openDeviceInvitation();
    else if (action === "setup") await setupEncryptedSync();
    else if (action === "sync") await syncFromDialog();
    else if (action === "switch-account") {
      if (!window.confirm(t("login.sync.disconnectConfirm"))) return;
      stopRealtimeChannel();
      syncScheduler.stop();
      await driveSync.disconnect();
      updateSyncUi();
      await connectGoogleFromDialog();
    }
  });
}
if (el.btnSyncManageAddDevice) el.btnSyncManageAddDevice.addEventListener("click", () => void openDeviceInvitation());
if (el.btnSyncManageRecovery) el.btnSyncManageRecovery.addEventListener("click", () => void createAdditionalRecoveryFile());
if (el.btnSyncManageNow) el.btnSyncManageNow.addEventListener("click", () => void syncFromDialog());
if (el.btnDeviceLinkPasskey) el.btnDeviceLinkPasskey.addEventListener("click", () => void unlockEncryptedSyncWithPasskey());
if (el.btnDeviceLinkExisting) el.btnDeviceLinkExisting.addEventListener("click", () => setDeviceLinkPhase("code"));
if (el.btnDeviceLinkRecoveryFile) el.btnDeviceLinkRecoveryFile.addEventListener("click", () => el.deviceLinkRecoveryInput?.click());
if (el.btnDeviceLinkRecoveryCode) el.btnDeviceLinkRecoveryCode.addEventListener("click", () => void unlockEncryptedSyncWithRecoveryCode());
if (el.deviceLinkCodeForm) {
  el.deviceLinkCodeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void requestExistingDeviceApproval();
  });
}
if (el.deviceLinkRecoveryInput) {
  el.deviceLinkRecoveryInput.addEventListener("change", () => {
    const file = el.deviceLinkRecoveryInput.files?.[0];
    if (file) void unlockEncryptedSyncWithRecoveryFile(file);
  });
}
if (el.btnDeviceLinkConfirm) {
  el.btnDeviceLinkConfirm.addEventListener("click", () => {
    const resolve = deviceLinkConfirmResolver;
    deviceLinkConfirmResolver = null;
    setDeviceLinkPhase("syncing");
    resolve?.(true);
  });
}
if (el.btnDeviceLinkReject) {
  el.btnDeviceLinkReject.addEventListener("click", () => {
    const resolve = deviceLinkConfirmResolver;
    deviceLinkConfirmResolver = null;
    resolve?.(false);
  });
}
if (el.btnDeviceLinkPrimary) {
  el.btnDeviceLinkPrimary.addEventListener("click", async () => {
    const action = el.btnDeviceLinkPrimary.dataset.action;
    if (action === "connect") await connectGoogleFromDialog();
    else if (action === "close") await closeDeviceLinkDialog({ clearInvite: false });
    else if (action === "retry") {
      if (pendingPairingFragment) await requestExistingDeviceApproval();
      else setDeviceLinkPhase("choose");
    }
  });
}
if (el.btnDeviceLinkUseLocal) el.btnDeviceLinkUseLocal.addEventListener("click", () => void useThisDeviceWithoutSync());
if (el.btnDeviceLinkClose) el.btnDeviceLinkClose.addEventListener("click", () => void closeDeviceLinkDialog());
if (el.btnPairingApprove) el.btnPairingApprove.addEventListener("click", () => void approveCurrentPairing());
if (el.btnPairingCancel) el.btnPairingCancel.addEventListener("click", () => void cancelCurrentPairing());
if (el.btnPairingClose) el.btnPairingClose.addEventListener("click", () => void cancelCurrentPairing());
if (el.btnPairingDone) el.btnPairingDone.addEventListener("click", () => void cancelCurrentPairing());
if (el.btnRecoveryDownload) {
  el.btnRecoveryDownload.addEventListener("click", () => {
    if (pendingRecoveryFile) {
      downloadJsonFile(pendingRecoveryFile, "taskliner-recovery.json");
      recoveryExported = true;
    }
  });
}
if (el.btnRecoveryCopy) {
  el.btnRecoveryCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.recoveryCopyValue?.value || "");
      recoveryExported = true;
      if (el.recoveryStatus) el.recoveryStatus.textContent = t("recovery.copied");
    } catch {
      el.recoveryCopyValue?.select();
      if (el.recoveryStatus) el.recoveryStatus.textContent = t("recovery.copyFallback");
    }
  });
}
if (el.btnRecoverySaved) el.btnRecoverySaved.addEventListener("click", () => finishRecoveryDialog(true));
if (el.btnRecoveryClose) el.btnRecoveryClose.addEventListener("click", () => finishRecoveryDialog(false));
if (el.recoveryDialog) {
  el.recoveryDialog.addEventListener("cancel", (event) => { event.preventDefault(); finishRecoveryDialog(false); });
}
if (el.pairingDialog) {
  el.pairingDialog.addEventListener("cancel", (event) => { event.preventDefault(); void cancelCurrentPairing(); });
}
if (el.deviceLinkDialog) {
  el.deviceLinkDialog.addEventListener("cancel", (event) => { event.preventDefault(); void closeDeviceLinkDialog(); });
  el.deviceLinkDialog.addEventListener("click", (event) => {
    if (event.target === el.deviceLinkDialog) void closeDeviceLinkDialog();
  });
}
if (el.btnAccountClose) el.btnAccountClose.addEventListener("click", () => closeAppDialog(el.accountDialog));
if (el.accountDialog) {
  el.accountDialog.addEventListener("click", (event) => {
    if (event.target === el.accountDialog) closeAppDialog(el.accountDialog);
  });
}
if (el.btnSyncDisconnect) {
  el.btnSyncDisconnect.addEventListener("click", async () => {
    if (!window.confirm(t("login.sync.disconnectConfirm"))) return;
    stopRealtimeChannel();
    syncScheduler.stop();
    await driveSync.disconnect();
    updateSyncUi();
    showSoonToast(t("login.sync.disconnected"));
  });
}
if (el.btnSyncDeleteRemote) {
  el.btnSyncDeleteRemote.addEventListener("click", async () => {
    if (!window.confirm(t("login.sync.deleteRemoteConfirm"))) return;
    syncScheduler.stop();
    stopRealtimeChannel();
    try {
      await driveSync.deleteRemoteData();
      await driveSync.disconnect();
      updateSyncUi();
      showSoonToast(t("login.sync.deletedRemote"));
    } catch (error) {
      updateSyncUi(error);
    }
  });
}
updateGoogleAuthButton();
updateSyncUi();
window.addEventListener("taskliner:localechange", updateGoogleAuthButton);
window.addEventListener("taskliner:localechange", () => updateSyncUi());
window.addEventListener("online", () => {
  syncScheduler.setOnline(true);
  if (document.visibilityState === "visible") void syncOnForeground();
  updateSyncUi();
});
window.addEventListener("offline", () => {
  clearRealtimeReconnect();
  driveSync.disconnectRealtime();
  syncScheduler.setRealtimeConnected(false);
  syncScheduler.setOnline(false);
  updateSyncUi();
});
document.addEventListener("visibilitychange", () => {
  const visible = document.visibilityState === "visible";
  syncScheduler.setVisible(visible);
  if (visible) {
    void syncOnForeground();
  } else {
    clearRealtimeReconnect();
    driveSync.disconnectRealtime();
    syncScheduler.setRealtimeConnected(false);
  }
  updateSyncUi();
});
window.addEventListener("hashchange", capturePairingInviteFromLocation);
window.addEventListener("pageshow", capturePairingInviteFromLocation);
window.addEventListener("focus", capturePairingInviteFromLocation);
window.addEventListener("pageshow", () => void syncOnForeground());
window.addEventListener("focus", () => void syncOnForeground());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") capturePairingInviteFromLocation();
});

function openAppDialog(dialog) {
  closeAllToolPops();
  closeInlineSearches();
  if (!dialog) return;
  if (dialog.open || dialog.hasAttribute("open")) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeAppDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

if (el.btnDetailClose) {
  el.btnDetailClose.addEventListener("click", () => {
    if (!el.mobileActiveSurface?.hidden) requestMobileV2Back();
    else clearInputAndSelection();
  });
}
if (el.btnMobileAdd) {
  el.btnMobileAdd.addEventListener("click", addMobileItem);
}

function openHelpDialog() {
  openAppDialog(el.helpDialog);
}

function closeHelpDialog() {
  closeAppDialog(el.helpDialog);
}

function openThemeDialog() {
  openAppDialog(el.themeDialog);
}

function closeThemeDialog() {
  closeAppDialog(el.themeDialog);
}

function openFileDialog() {
  openAppDialog(el.fileDialog);
}

function closeFileDialog() {
  closeAppDialog(el.fileDialog);
}

function openCategoryHelpDialog() {
  openAppDialog(el.categoryHelpDialog);
}

function closeCategoryHelpDialog() {
  closeAppDialog(el.categoryHelpDialog);
}

function openAboutDialog() {
  openAppDialog(el.aboutDialog);
}

function closeAboutDialog() {
  closeAppDialog(el.aboutDialog);
}

function openDiscordDialog() {
  closeAllToolPops();
  void syncDiscordSettingsUi();
  openAppDialog(el.discordDialog);
}

function closeDiscordDialog() {
  closeAppDialog(el.discordDialog);
}

if (el.btnAbout) {
  el.btnAbout.addEventListener("click", () => openAboutDialog());
}
if (el.btnAboutClose) {
  el.btnAboutClose.addEventListener("click", () => closeAboutDialog());
}
if (el.aboutDialog) {
  el.aboutDialog.addEventListener("click", (e) => {
    if (e.target === el.aboutDialog) closeAboutDialog();
  });
}
if (el.btnDiscord) {
  el.btnDiscord.addEventListener("click", () => openDiscordDialog());
}
if (el.btnDiscordClose) {
  el.btnDiscordClose.addEventListener("click", () => closeDiscordDialog());
}
if (el.discordDialog) {
  el.discordDialog.addEventListener("click", (event) => {
    if (event.target === el.discordDialog) closeDiscordDialog();
  });
}

if (el.btnHelp) {
  el.btnHelp.addEventListener("click", () => openHelpDialog());
}
if (el.btnHelpClose) {
  el.btnHelpClose.addEventListener("click", () => closeHelpDialog());
}
if (el.helpDialog) {
  el.helpDialog.addEventListener("click", (e) => {
    if (e.target === el.helpDialog) closeHelpDialog();
  });
}
if (el.btnTheme) {
  el.btnTheme.addEventListener("click", () => openThemeDialog());
}
if (el.btnThemeClose) {
  el.btnThemeClose.addEventListener("click", () => closeThemeDialog());
}
if (el.themeDialog) {
  el.themeDialog.addEventListener("click", (e) => {
    if (e.target === el.themeDialog) closeThemeDialog();
  });
}
if (el.btnFileMenu) {
  el.btnFileMenu.addEventListener("click", () => openFileDialog());
}
if (el.btnFileClose) {
  el.btnFileClose.addEventListener("click", () => closeFileDialog());
}
if (el.fileDialog) {
  el.fileDialog.addEventListener("click", (e) => {
    if (e.target === el.fileDialog) closeFileDialog();
  });
}
if (el.btnCategoryHelp) {
  el.btnCategoryHelp.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCategoryHelpDialog();
  });
}
if (el.btnCategoryHelpClose) {
  el.btnCategoryHelpClose.addEventListener("click", () => closeCategoryHelpDialog());
}
if (el.categoryHelpDialog) {
  el.categoryHelpDialog.addEventListener("click", (e) => {
    if (e.target === el.categoryHelpDialog) closeCategoryHelpDialog();
  });
}

if (el.activeQuery) el.activeQuery.tabIndex = -1;
if (el.archiveQuery) el.archiveQuery.tabIndex = -1;
syncArchiveFilterUi();
syncActiveFilterUi();
syncArchiveToolHint();
renderZoomBar();

function bindToolPop(btn, panel) {
  if (!btn || !panel) return;
  const pop = btn.closest(".tool-pop");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeInlineSearches();
    toggleToolPop(pop);
  });
}
bindToolPop(el.btnArchiveFilter, el.archiveFilterPanel);
bindToolPop(el.btnSettingsMenu, el.settingsMenuPanel);
bindToolPop(el.btnTopbarMenu, el.topbarMenuPanel);
bindToolPop(el.btnLangMenu, el.langMenuPanel);

function bindInlineSearch(btn) {
  if (!btn) return;
  const wrap = btn.closest(".inline-search");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInlineSearch(wrap);
  });
}
bindInlineSearch(el.btnActiveSearch);
bindInlineSearch(el.btnArchiveSearch);

document.addEventListener("mousedown", (e) => {
  if (e.target.closest?.(".tool-pop") || e.target.closest?.(".inline-search")) return;
  closeAllToolPops();
  closeInlineSearches();
});

if (el.activeQuery) {
  el.activeQuery.addEventListener("input", () => {
    doc.ui.activeQuery = el.activeQuery.value;
    renderActive();
    saveDoc();
  });
  el.activeQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.activeQuery.blur();
      if (!el.activeQuery.value.trim()) {
        setInlineSearchOpen(el.btnActiveSearch?.closest(".inline-search"), false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!el.activeQuery.value.trim()) {
        setInlineSearchOpen(el.btnActiveSearch?.closest(".inline-search"), false);
      } else {
        el.activeQuery.blur();
      }
    }
  });
}
if (el.archiveQuery) {
  el.archiveQuery.addEventListener("input", () => {
    doc.ui.archiveQuery = el.archiveQuery.value;
    renderArchive();
    saveDoc();
  });
  el.archiveQuery.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.archiveQuery.blur();
      if (!el.archiveQuery.value.trim()) {
        setInlineSearchOpen(el.btnArchiveSearch?.closest(".inline-search"), false);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!el.archiveQuery.value.trim()) {
        setInlineSearchOpen(el.btnArchiveSearch?.closest(".inline-search"), false);
      } else {
        el.archiveQuery.blur();
      }
    }
  });
}
if (el.btnActiveDueSort) {
  el.btnActiveDueSort.addEventListener("click", () => {
    doc.ui.activeSort = doc.ui.activeSort === "due-asc" ? "outline" : "due-asc";
    closeAllToolPops();
    render();
    saveDoc();
  });
}
if (el.btnActivePlainText) {
  el.btnActivePlainText.addEventListener("click", () => {
    setPlainTextMode(!doc.ui.plainTextMode);
  });
}
if (el.progressModeSelect) {
  el.progressModeSelect.addEventListener("change", () => {
    doc.ui.progressMode = normalizeProgressMode(el.progressModeSelect.value);
    render();
    saveDoc();
  });
}
if (el.categoryMode) {
  el.categoryMode.addEventListener("change", () => {
    doc.ui.categoryMode = !!el.categoryMode.checked;
    render();
    saveDoc();
  });
}
if (el.dueKeepTree) {
  el.dueKeepTree.addEventListener("change", () => {
    doc.ui.dueKeepTree = !!el.dueKeepTree.checked;
    render();
    saveDoc();
  });
}
if (el.dueShowUndated) {
  el.dueShowUndated.addEventListener("change", () => {
    doc.ui.dueShowUndated = !!el.dueShowUndated.checked;
    render();
    saveDoc();
  });
}
if (el.titleWrap) {
  el.titleWrap.addEventListener("change", () => {
    doc.ui.titleWrap = !!el.titleWrap.checked;
    render();
    saveDoc();
  });
}
if (el.btnZoomOut) {
  el.btnZoomOut.addEventListener("click", () => zoomToRoot());
}
if (el.btnZoomIn) {
  el.btnZoomIn.addEventListener("click", () => {
    const n = getNode(doc.selectedId);
    if (!n || !isActive(n)) return;
    if (doc.ui.zoomId === n.id) zoomToRoot();
    else setZoom(n.id);
  });
}
if (el.detailDue) {
  initDetailDuePicker();
  el.detailDue.addEventListener("change", () => {
    const n = getNode(doc.selectedId);
    if (!n || isCompleted(n)) return;
    pushHistory();
    n.dueAt = dueAtFromDateInput(el.detailDue.value);
    render();
    saveDoc();
  });
}
if (el.detailDueClear) {
  el.detailDueClear.addEventListener("click", () => {
    const n = getNode(doc.selectedId);
    if (!n || isCompleted(n)) return;
    pushHistory();
    n.dueAt = null;
    render();
    saveDoc();
  });
}

el.archiveClearFilters.addEventListener("click", clearArchiveFilters);
if (el.archiveLoadMore) {
  el.archiveLoadMore.addEventListener("click", () => {
    if (!archiveState.hasMore || archiveState.loading) return;
    void loadArchivePage();
  });
}

for (const chip of el.archivePeriodChips) {
  chip.addEventListener("click", () => {
    doc.ui.archivePeriod = chip.dataset.period || "all";
    if (doc.ui.archivePeriod === "custom" && !doc.ui.archiveFrom && !doc.ui.archiveTo) {
      // default custom range: last 7 days
      const to = new Date();
      const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 6);
      const fmt = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      doc.ui.archiveFrom = fmt(from);
      doc.ui.archiveTo = fmt(to);
    }
    renderArchive();
    saveDoc();
  });
}
for (const chip of el.archiveSortChips) {
  chip.addEventListener("click", () => {
    doc.ui.archiveSort = chip.dataset.sort || "completed-desc";
    renderArchive();
    saveDoc();
  });
}

el.archiveFrom.addEventListener("change", () => {
  doc.ui.archivePeriod = "custom";
  doc.ui.archiveFrom = el.archiveFrom.value;
  renderArchive();
  saveDoc();
});
el.archiveTo.addEventListener("change", () => {
  doc.ui.archivePeriod = "custom";
  doc.ui.archiveTo = el.archiveTo.value;
  renderArchive();
  saveDoc();
});

el.detailTitle.addEventListener("blur", () => endCoalesce());
el.detailTitle.addEventListener("input", () => {
  const n = getNode(doc.selectedId);
  if (!n || isCompleted(n)) return;
  beginCoalesce();
  n.title = el.detailTitle.value;
  const input = document.querySelector(`.title-input[data-id="${n.id}"]`);
  if (input) {
    input.value = n.title;
    const mirror = input.closest(".title-grow")?.querySelector(".title-mirror");
    if (mirror) mirror.textContent = n.title || t("untitled");
  }
  saveDoc();
});

el.detailNote.addEventListener("blur", () => endCoalesce());
el.detailNote.addEventListener("input", () => {
  const n = getNode(doc.selectedId);
  if (!n || isCompleted(n)) return;
  beginCoalesce();
  n.note = el.detailNote.value;
  const row = document.querySelector(`.row[data-id="${n.id}"]`);
  const noteIndicator = row?.querySelector(".note-indicator");
  if (noteIndicator) {
    const hasNote = !!(n.note || "").trim();
    noteIndicator.hidden = !hasNote;
    row.querySelector(".title-cell")?.classList.toggle("has-note", hasNote);
  } else if ((n.note || "").trim() && row) {
    const titleCell = row.querySelector(".title-cell");
    titleCell?.classList.add("has-note");
    titleCell?.appendChild(createNoteIndicator());
  }
  saveDoc();
});

const bindMobileMoveButton = (button, action) => {
  button?.addEventListener("click", () => {
    const id = doc.selectedId;
    if (!id || !isMobileSheet()) return;
    action(id);
  });
};
bindMobileMoveButton(el.btnIndent, indentNode);
bindMobileMoveButton(el.btnOutdent, outdentNode);
bindMobileMoveButton(el.btnMoveUp, (id) => reorderAmongSiblings(id, -1));
bindMobileMoveButton(el.btnMoveDown, (id) => reorderAmongSiblings(id, 1));

el.btnToggleDone.addEventListener("click", () => {
  const n = getNode(doc.selectedId);
  if (!n || isCategoryNode(n)) return;
  if (isCompleted(n)) restoreNode(n.id);
  else completeNode(n.id);
});

el.btnDelete.addEventListener("click", () => {
  if (doc.selectedId) deleteNode(doc.selectedId);
});

function isTypingInDetailField(t) {
  return (
    t &&
    ((t.tagName === "TEXTAREA" && !t.classList.contains("title-input")) ||
      (t.tagName === "INPUT" && !t.classList.contains("title-input")) ||
      t.tagName === "SELECT")
  );
}

function isInsideDetailSheet(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return !!element?.closest?.(".detail-pane");
}

function isInsideMobileTextEditor(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return !!element?.closest?.(".mobile-inline-editor, .mobile-quick-add, .mobile-search-bar");
}

document.addEventListener(
  "selectstart",
  (e) => {
    if (isMobileSheet() && !isInsideDetailSheet(e.target) && !isInsideMobileTextEditor(e.target)) e.preventDefault();
  },
  true
);

document.addEventListener(
  "copy",
  (e) => {
    if (!isMobileSheet()) return;
    const selection = window.getSelection?.();
    if (
      isInsideDetailSheet(e.target) ||
      isInsideDetailSheet(selection?.anchorNode) ||
      isInsideDetailSheet(document.activeElement) ||
      isInsideMobileTextEditor(e.target) ||
      isInsideMobileTextEditor(selection?.anchorNode) ||
      isInsideMobileTextEditor(document.activeElement)
    ) {
      return;
    }
    e.preventDefault();
    selection?.removeAllRanges();
  },
  true
);

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const meta = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (meta && key === "z") {
    e.preventDefault();
    endCoalesce();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (meta && key === "y") {
    e.preventDefault();
    endCoalesce();
    redo();
    return;
  }

  if (meta && key === "c") {
    if (isTypingInDetailField(t)) return;
    // 複数行選択中は常に Markdown 箇条書きをコピー（入力中の部分選択より優先）
    if (rangeIds.length > 1) {
      e.preventDefault();
      copySelectionMarkdown();
      return;
    }
    if (
      t &&
      t.classList?.contains("title-input") &&
      t.selectionStart !== t.selectionEnd
    ) {
      return;
    }
    e.preventDefault();
    copySelectionMarkdown();
    return;
  }

  if (meta && key === "a") {
    if (isTypingInDetailField(t)) return;
    e.preventDefault();
    if (t?.classList?.contains("title-input")) {
      const val = t.value || "";
      const fullySelected =
        val.length > 0 && t.selectionStart === 0 && t.selectionEnd === val.length;
      if (!fullySelected) {
        t.select();
        if (rangeIds.length > 1 && doc.selectedId) {
          rangeIds = [doc.selectedId];
          rangeAnchorId = doc.selectedId;
          syncSelectionClasses();
        }
        return;
      }
    }
    selectAllVisibleRows();
    return;
  }

  if (meta && key === "enter") {
    if (isTypingInDetailField(t)) return;
    if (!doc.selectedId) return;
    e.preventDefault();
    endCoalesce();
    const n = getNode(doc.selectedId);
    if (!n || isCategoryNode(n)) return;
    if (isCompleted(n)) restoreNode(n.id);
    else completeNode(n.id);
    return;
  }

  if (meta && key === ".") {
    if (isTypingInDetailField(t)) return;
    if (doc.ui.tab !== "active" || !doc.selectedId) return;
    e.preventDefault();
    endCoalesce();
    setZoom(doc.selectedId);
    return;
  }

  if (e.key === "Escape") {
    if (el.categoryHelpDialog?.open) {
      e.preventDefault();
      closeCategoryHelpDialog();
      return;
    }
    if (el.helpDialog?.open) {
      e.preventDefault();
      closeHelpDialog();
      return;
    }
    if (el.themeDialog?.open) {
      e.preventDefault();
      closeThemeDialog();
      return;
    }
    if (el.fileDialog?.open) {
      e.preventDefault();
      closeFileDialog();
      return;
    }
    if (document.querySelector(".tool-pop.is-open")) {
      e.preventDefault();
      closeAllToolPops();
      return;
    }
    const openSearch = document.querySelector(".inline-search.is-open");
    if (openSearch && !((openSearch.querySelector(".inline-search-input")?.value || "").trim())) {
      e.preventDefault();
      setInlineSearchOpen(openSearch, false);
      return;
    }
    if (doc.ui.zoomId && doc.ui.tab === "active") {
      e.preventDefault();
      endCoalesce();
      zoomOut();
      return;
    }
    if (isMobileSheet() && sheetLevel === "expanded") {
      e.preventDefault();
      endCoalesce();
      if (!el.mobileActiveSurface?.hidden && mobileUi.detailsOpen) {
        requestMobileV2Back();
        return;
      }
      setSheetLevel("peek");
      return;
    }
    if (
      t?.classList?.contains("title-input") ||
      t === el.detailTitle ||
      t === el.detailNote ||
      doc.selectedId ||
      rangeIds.length
    ) {
      e.preventDefault();
      endCoalesce();
      clearInputAndSelection();
    }
    return;
  }

  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && meta) {
    if (isTypingInDetailField(t)) return;
    if (t?.classList?.contains("title-input")) return; // handled in onTitleKeydown
    if (!doc.selectedId) return;
    e.preventDefault();
    endCoalesce();
    if (e.key === "ArrowLeft") handleArrowLeft();
    else handleArrowRight();
    return;
  }

  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && meta && !e.shiftKey) {
    if (isTypingInDetailField(t)) return;
    if (t?.classList?.contains("title-input")) return; // handled in onTitleKeydown
    if (!doc.selectedId || doc.ui.tab !== "active") return;
    e.preventDefault();
    endCoalesce();
    reorderAmongSiblings(doc.selectedId, e.key === "ArrowUp" ? -1 : 1);
    return;
  }

  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.shiftKey && !meta) {
    // Allow while typing in title (also handled there); skip detail textarea/date
    if (isTypingInDetailField(t)) return;
    if (t?.classList?.contains("title-input")) return;
    e.preventDefault();
    extendSelectionBy(e.key === "ArrowUp" ? -1 : 1);
    return;
  }

  if (meta && e.key === "Delete") {
    if (isTypingInDetailField(t)) return;
    if (t?.classList?.contains("title-input")) return;
    if (!doc.selectedId && !rangeIds.length) return;
    e.preventDefault();
    endCoalesce();
    deleteSelectedNodes();
  }
});

ensureActiveRoot();

function setupOutlineDeselect() {
  for (const outline of [el.activeOutline, el.archiveOutline]) {
    if (!outline) continue;
    outline.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.(".row")) return;
      // Empty outline / empty-state / padding → clear selection
      endCoalesce();
      clearInputAndSelection();
    });
  }
}
setupOutlineDeselect();

function setupMobileActiveV2() {
  if (!el.mobileActiveSurface) return;
  replaceMobileHistoryState();

  el.btnMobileBack?.addEventListener("click", requestMobileV2Back);

  el.btnMobileDisplayMode?.addEventListener("click", () => {
    mobileUi.displayMode = mobileUi.displayMode === "branch" ? "outline" : "branch";
    mobileUi.inlineEditor = null;
    mobileUi.reorderMode = false;
    renderMobileActive();
    replaceMobileHistoryState();
  });

  el.btnMobileDueSort?.addEventListener("click", () => {
    mobileUi.inlineEditor = null;
    mobileUi.reorderMode = false;
    doc.ui.activeSort = doc.ui.activeSort === "due-asc" ? "outline" : "due-asc";
    render();
    saveDoc();
  });

  el.btnMobileSearch?.addEventListener("click", () => {
    if (el.mobileSearchBar && !el.mobileSearchBar.hidden) {
      requestMobileV2Back();
      return;
    }
    el.mobileSearchBar.hidden = false;
    pushMobileHistoryState({ transient: true });
    requestAnimationFrame(() => {
      el.mobileSearchQuery?.focus();
      el.mobileSearchQuery?.select();
    });
    renderMobileActive();
  });

  el.btnMobileSearchClose?.addEventListener("click", requestMobileV2Back);

  el.mobileSearchQuery?.addEventListener("input", () => {
    doc.ui.activeQuery = el.mobileSearchQuery.value;
    mobileUi.inlineEditor = null;
    mobileUi.reorderMode = false;
    renderMobileActive();
    saveDoc();
  });

  el.btnMobileReorder?.addEventListener("click", () => {
    if (doc.ui.activeQuery || doc.ui.activeSort === "due-asc") return;
    mobileUi.inlineEditor = null;
    if (mobileUi.reorderMode) {
      mobileUi.reorderMode = false;
      renderMobileActive();
      return;
    }
    mobileUi.reorderMode = true;
    renderMobileActive();
    pushMobileHistoryState({ transient: true });
  });

  el.btnMobileReorderDone?.addEventListener("click", requestMobileV2Back);

  el.btnMobileRowMenuClose?.addEventListener("click", requestMobileV2Back);
  el.mobileRowMenuBackdrop?.addEventListener("click", requestMobileV2Back);
  el.mobileRowMenuDialog?.addEventListener("click", (event) => {
    const actionButton = event.target.closest?.("[data-mobile-row-action]");
    if (!actionButton) return;
    const id = mobileUi.rowMenuId;
    const node = id ? doc.nodes[id] : null;
    if (!isActive(node)) {
      closeMobileRowMenu({ restoreFocus: false });
      return;
    }
    const action = actionButton.dataset.mobileRowAction;
    closeMobileRowMenu({ restoreFocus: false });
    if (action === "details") {
      openMobileDetails(id);
    } else if (action === "move") {
      openMobileMovePicker(id);
    } else if (action === "complete" && !isCategoryNode(node)) {
      completeNode(id);
      replaceMobileHistoryState();
    } else if (action === "delete") {
      deleteNode(id);
      replaceMobileHistoryState();
    }
  });

  el.btnMobileMoveClose?.addEventListener("click", requestMobileV2Back);
  el.mobileMoveDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    requestMobileV2Back();
  });
  el.mobileMoveSearch?.addEventListener("input", () => {
    if (!mobileUi.movePicker) return;
    mobileUi.movePicker.query = el.mobileMoveSearch.value;
    renderMobileMoveList();
  });

  el.btnMobileV2Add?.addEventListener("click", () => {
    if (mobileUi.displayMode === "outline" && doc.ui.activeSort !== "due-asc" && !doc.ui.activeQuery.trim()) {
      openMobileAddParentPicker();
      return;
    }
    beginMobileQuickAdd(mobileUi.navRootId);
  });

  el.btnMobileAddParentRoot?.addEventListener("click", () => beginMobileQuickAdd(null));
  el.btnMobileAddParentCancel?.addEventListener("click", requestMobileV2Back);

  el.mobileQuickAddInput?.addEventListener("input", () => {
    mobileUi.quickAdd.draft = el.mobileQuickAddInput.value;
  });

  el.btnMobileQuickAddClose?.addEventListener("click", requestMobileV2Back);

  el.mobileQuickAdd?.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = mobileUi.quickAdd.draft.trim();
    if (!title) return;
    const parentId = mobileUi.quickAdd.parentId;
    const parent = parentId ? doc.nodes[parentId] : null;
    if (parentId && !isActive(parent)) {
      showNoticeToast(t("mobile.parentUnavailable"));
      return;
    }

    const list = parent ? parent.childIds : doc.rootIds;
    const blankId = list.find((id) => {
      const candidate = doc.nodes[id];
      return (
        isActive(candidate) &&
        !(candidate.title || "").trim() &&
        !candidate.childIds.length &&
        !(candidate.note || "").trim() &&
        candidate.dueAt == null
      );
    });

    pushHistory();
    const result = blankId
      ? renameOutlineNode(doc, { id: blankId, title })
      : createOutlineNode(doc, {
          id: uid(),
          title,
          parentId,
          index: "end",
          createdAt: now(),
        });
    if (!result.changed) return;
    mobileUi.quickAdd.draft = "";
    if (el.mobileQuickAddInput) el.mobileQuickAddInput.value = "";
    renderMobileActive();
    saveDoc();
    requestAnimationFrame(() => {
      el.mobileActiveList?.scrollTo?.({ top: el.mobileActiveList.scrollHeight, behavior: "smooth" });
      el.mobileQuickAddInput?.focus();
    });
  });
}

setupMobileActiveV2();

window.addEventListener("popstate", () => {
  const handled = handleMobileV2Back();
  if (handled === "blocked") pushMobileHistoryState({ transient: true });
});

function setupDetailSheet() {
  const pane = el.detailPane;
  const handle = el.detailSheetHandle;
  const backdrop = el.detailSheetBackdrop;
  if (!pane || !handle) return;

  handle.addEventListener("click", () => {
    if (!isMobileSheet() || !doc.selectedId) return;
    if (sheetDragMoved) return;
    setSheetLevel(sheetLevel === "expanded" ? "peek" : "expanded");
  });

  backdrop?.addEventListener("click", () => {
    if (!isMobileSheet()) return;
    collapseOrCloseSheet();
  });

  /** @type {{ startY: number, pointerId: number } | null} */
  let sheetDrag = null;
  let sheetDragMoved = false;

  const endDrag = () => {
    sheetDrag = null;
    pane.classList.remove("is-sheet-dragging");
    pane.style.transform = "";
  };

  handle.addEventListener("pointerdown", (e) => {
    if (!isMobileSheet() || !doc.selectedId || sheetLevel === "closed") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    sheetDragMoved = false;
    sheetDrag = { startY: e.clientY, pointerId: e.pointerId };
    handle.setPointerCapture?.(e.pointerId);
  });

  handle.addEventListener("pointermove", (e) => {
    if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
    const dy = e.clientY - sheetDrag.startY;
    if (!sheetDragMoved && Math.abs(dy) < 8) return;
    sheetDragMoved = true;
    pane.classList.add("is-sheet-dragging");
    // Allow slight upward rubber only from peek; downward always.
    const minY = sheetLevel === "peek" ? -48 : 0;
    pane.style.transform = `translateY(${Math.max(minY, dy)}px)`;
  });

  const finishDrag = (e) => {
    if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
    const dy = e.clientY - sheetDrag.startY;
    const moved = sheetDragMoved;
    endDrag();
    if (!moved) return;

    if (sheetLevel === "expanded") {
      if (dy > 220) {
        clearInputAndSelection();
        return;
      }
      if (dy > 90) {
        setSheetLevel("peek");
        return;
      }
      setSheetLevel("expanded");
      return;
    }

    // peek
    if (dy < -36) {
      setSheetLevel("expanded");
      return;
    }
    if (dy > 90) {
      clearInputAndSelection();
      return;
    }
    setSheetLevel("peek");
  };

  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", (e) => {
    if (!sheetDrag || e.pointerId !== sheetDrag.pointerId) return;
    endDrag();
    syncSheetUi();
  });

  const mq = window.matchMedia?.(MOBILE_SHEET_MQ);
  const onViewportChange = () => {
    if (!isMobileSheet()) {
      sheetLevel = "closed";
      endDrag();
    } else if (doc.selectedId && sheetLevel === "closed" && el.mobileActiveSurface?.hidden) {
      sheetLevel = "peek";
    }
    syncSheetUi();
    syncBodyUiClasses();
    if (doc.ui.tab === "active") {
      renderActive();
      renderDetail();
    }
  };
  mq?.addEventListener?.("change", onViewportChange);
}

setupDetailSheet();

document.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("[data-set-locale]");
  if (!btn) return;
  const next = btn.getAttribute("data-set-locale");
  if (next !== "ja" && next !== "en") return;
  e.preventDefault();
  e.stopPropagation();
  setLocale(next);
  closeAllToolPops();
});

window.addEventListener("taskliner:localechange", () => {
  refreshDetailDuePicker();
  if (!doc) return;
  // Tutorial preview or an explicitly loaded tutorial: rebuild in the new language.
  const tutorialIds = new Set(Object.values(TUTORIAL_IDS));
  const nodeIds = Object.keys(doc.nodes || {});
  const guidedIds = new Set(Object.values(GUIDED_TUTORIAL_IDS));
  const stillGuided =
    wantsGuidedTutorialFromUrl() ||
    (nodeIds.length === guidedIds.size && nodeIds.every((id) => guidedIds.has(id)));
  const stillTutorial =
    skipPersist ||
    (nodeIds.length === tutorialIds.size && nodeIds.every((id) => tutorialIds.has(id)));
  if (stillGuided) {
    const keepUi = { ...doc.ui };
    doc = guidedTutorialDoc();
    doc.ui = keepUi;
  } else if (stillTutorial) {
    const keepUi = { ...doc.ui };
    doc = tutorialDoc();
    doc.ui = keepUi;
    if (!skipPersist) saveDoc();
  }
  render();
  syncArchiveFilterUi();
  void syncDiscordSettingsUi();
});

// Initial paint: start with no selection
{
  const tab = doc.ui.tab;
  for (const btn of el.tabs) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  el.viewActive.classList.toggle("is-active", tab === "active");
  el.viewActive.hidden = tab !== "active";
  el.viewArchive.classList.toggle("is-active", tab === "archive");
  el.viewArchive.hidden = tab !== "archive";
  applyTheme(doc.ui.theme);
}
clearSelection();
render();
const startupHydration = hydratePersistedDoc().catch(() => undefined);
if (!skipPersist) {
  void syncDiscordSettingsUi();
  void completionOutbox.start().then(syncDiscordSettingsUi);
  void startupHydration.then(() => restoreGoogleConnection());
}
maybeOpenStarterDialog();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {
    // Offline support is optional when the app is served without a secure origin.
  });
}

// ?tutorial=1: preview only (skipPersist). Optional verify toast, then strip verify=.
{
  const fromUrl = wantsTutorialFromUrl();
  const wantVerify = (() => {
    try {
      return new URLSearchParams(location.search).has("verify");
    } catch {
      return false;
    }
  })();
  if (fromUrl || wantVerify) {
    const check = verifyTutorialDoc(doc);
    if (wantVerify) {
      if (check.ok) {
        console.info("[taskliner] tutorial verify: ok");
        showNoticeToast(t("tutorial.verifyOk"));
      } else {
        console.warn("[taskliner] tutorial verify failed:", check.errors);
        showNoticeToast(t("tutorial.verifyNg", { error: check.errors[0] }));
      }
    }
  }
  clearVerifyQueryParam();
}

// Manual check from DevTools: verifyTutorialDoc(doc) or window.__tasklinerVerifyTutorial()
window.__tasklinerVerifyTutorial = () => verifyTutorialDoc(doc);
