export class ServerAuthUnavailableError extends Error {
  constructor(message = "Taskliner sync server is unavailable") {
    super(message);
    this.name = "ServerAuthUnavailableError";
    this.code = "server_auth_unavailable";
  }
}

export function createGoogleServerAuth({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  locationObj = globalThis.location,
} = {}) {
  let authorized = false;
  let user = null;

  function isAvailable() {
    return typeof fetchImpl === "function" && !!locationObj?.origin && /^https?:$/.test(locationObj.protocol || "");
  }

  async function restore() {
    if (!isAvailable()) return false;
    try {
      const response = await fetchImpl("/api/auth/me", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new ServerAuthUnavailableError();
      const result = await response.json();
      authorized = result?.authenticated === true;
      user = authorized ? result : null;
      return authorized;
    } catch {
      authorized = false;
      user = null;
      return false;
    }
  }

  function connect({ reauthorize = false } = {}) {
    if (!isAvailable()) throw new ServerAuthUnavailableError();
    const current = `${locationObj.pathname || "/"}${locationObj.search || ""}`;
    const query = new URLSearchParams({ returnTo: current.startsWith("/") ? current : "/" });
    query.set("cacheBust", String(Date.now()));
    if (reauthorize) query.set("reauthorize", "1");
    const target = `/api/auth/login?${query}`;
    locationObj.assign(target);
    return false;
  }

  async function logout() {
    if (isAvailable()) {
      try { await fetchImpl("/api/auth/logout", { method: "POST", credentials: "include" }); } catch { /* local disconnect still succeeds */ }
    }
    authorized = false;
    user = null;
  }

  async function revoke() {
    if (isAvailable()) {
      const response = await fetchImpl("/api/auth/revoke", { method: "POST", credentials: "include" });
      if (!response.ok && response.status !== 401) throw new ServerAuthUnavailableError();
    }
    authorized = false;
    user = null;
  }

  return {
    restore,
    connect,
    logout,
    revoke,
    clear: logout,
    hasToken: () => authorized,
    isAvailable,
    getUser: () => user,
  };
}
