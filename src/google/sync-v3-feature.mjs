const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isPreviewHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return LOCAL_HOSTS.has(host) || host.endsWith(".pages.dev");
}

function configuredMode(documentObj) {
  const value = documentObj?.querySelector?.('meta[name="taskliner-sync-v3"]')?.content;
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The shipped HTML enables v3 explicitly; preview builds may opt in separately. */
export function isSyncV3Enabled({
  locationObj = globalThis.location,
  documentObj = globalThis.document,
} = {}) {
  const mode = configuredMode(documentObj);
  if (mode === "enabled") return true;
  if (mode === "disabled") return false;

  const preview = isPreviewHost(locationObj?.hostname);
  if (mode === "preview") return preview;
  if (!preview) return false;

  try {
    const flag = new URLSearchParams(locationObj?.search || "").get("syncV3");
    if (flag === "0") return false;
    if (flag === "1") return true;
  } catch {
    return false;
  }
  return LOCAL_HOSTS.has(String(locationObj?.hostname || "").toLowerCase());
}

export { isPreviewHost };
