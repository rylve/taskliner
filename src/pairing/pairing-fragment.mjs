import { parsePairingQrFragment } from "./pairing-protocol-v1.mjs";

export const PAIRING_FRAGMENT_SESSION_KEY = "taskliner-pairing-fragment-v1";

function cleanLocation(locationObj) {
  return `${locationObj?.pathname || "/"}${locationObj?.search || ""}`;
}

function storedFragment(sessionStorageObj) {
  try { return sessionStorageObj?.getItem(PAIRING_FRAGMENT_SESSION_KEY) || ""; } catch { return ""; }
}

export function capturePairingFragment({
  locationObj = globalThis.location,
  historyObj = globalThis.history,
  sessionStorageObj = globalThis.sessionStorage,
  parseFragment = parsePairingQrFragment,
} = {}) {
  const fragment = String(locationObj?.hash || "");
  if (!fragment.startsWith("#taskliner-pair=")) return storedFragment(sessionStorageObj);

  const clean = cleanLocation(locationObj);
  try {
    historyObj.replaceState(historyObj.state, "", clean);
  } catch {
    try { locationObj.replace(clean); } catch { /* navigation APIs are unavailable */ }
    return "";
  }

  try {
    parseFragment(fragment);
    sessionStorageObj.setItem(PAIRING_FRAGMENT_SESSION_KEY, fragment);
    return fragment;
  } catch {
    try { sessionStorageObj?.removeItem(PAIRING_FRAGMENT_SESSION_KEY); } catch { /* storage is unavailable */ }
    return "";
  }
}
