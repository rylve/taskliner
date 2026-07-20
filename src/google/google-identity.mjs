export const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/**
 * Memory-only token boundary for Google Identity Services.
 * The caller owns the GIS requestAccessToken callback; this module never
 * writes tokens to localStorage, IndexedDB, URLs, or logs.
 */
export function createMemoryTokenProvider({ requestAccessToken, now = () => Date.now(), refreshSkewMs = 30_000 } = {}) {
  if (typeof requestAccessToken !== "function") throw new TypeError("requestAccessToken must be a function");
  let accessToken = null;
  let expiresAt = 0;

  const clear = () => {
    accessToken = null;
    expiresAt = 0;
  };

  return {
    async getToken({ interactive = false } = {}) {
      if (accessToken && expiresAt > now() + refreshSkewMs) return accessToken;
      const response = await requestAccessToken({ scope: DRIVE_APPDATA_SCOPE, interactive });
      if (!response || typeof response.access_token !== "string" || !response.access_token) {
        clear();
        throw new Error("Google did not return an access token");
      }
      accessToken = response.access_token;
      const expiresIn = Number(response.expires_in);
      expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : Number.POSITIVE_INFINITY;
      return accessToken;
    },
    clear,
    hasToken() {
      return !!accessToken && expiresAt > now();
    },
    scope: DRIVE_APPDATA_SCOPE,
  };
}

