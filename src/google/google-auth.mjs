import { createMemoryTokenProvider, DRIVE_APPDATA_SCOPE } from "./google-identity.mjs";

function googleOauthApi() {
  return globalThis.google?.accounts?.oauth2 || null;
}

function waitForOauthApi(getOauthApi, { timeoutMs = 8_000, intervalMs = 100 } = {}) {
  const immediate = getOauthApi();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const oauth = getOauthApi();
      if (oauth) {
        resolve(oauth);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Google Identity Services is not loaded"));
        return;
      }
      setTimeout(check, intervalMs);
    };
    setTimeout(check, intervalMs);
  });
}

/**
 * Browser-only GIS token flow. The access token stays in the returned
 * memory-only provider and is never written to application storage.
 */
export function createGoogleBrowserAuth({
  clientId,
  getOauthApi = googleOauthApi,
} = {}) {
  if (typeof getOauthApi !== "function") throw new TypeError("getOauthApi must be a function");

  const requestAccessToken = ({ interactive = false } = {}) => new Promise((resolve, reject) => {
    if (typeof clientId !== "string" || !clientId) {
      reject(new Error("Google OAuth is not configured for this host"));
      return;
    }

    void waitForOauthApi(getOauthApi).then((oauth) => {
      if (!oauth?.initTokenClient) {
        reject(new Error("Google Identity Services is not loaded"));
        return;
      }

      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      let tokenClient;
      try {
        tokenClient = oauth.initTokenClient({
          client_id: clientId,
          scope: DRIVE_APPDATA_SCOPE,
          callback: (response) => {
            if (response?.error) {
              finish(reject, new Error(response.error_description || response.error));
              return;
            }
            if (!response?.access_token) {
              finish(reject, new Error("Google did not return an access token"));
              return;
            }
            finish(resolve, response);
          },
        });
        tokenClient.requestAccessToken(interactive ? { prompt: "consent" } : { prompt: "" });
      } catch (error) {
        finish(reject, error instanceof Error ? error : new Error("Google authorization failed"));
      }
    }).catch(reject);
  });

  const tokenProvider = createMemoryTokenProvider({ requestAccessToken });
  return {
    clientId: clientId || null,
    scope: DRIVE_APPDATA_SCOPE,
    async connect() {
      return tokenProvider.getToken({ interactive: true });
    },
    async restore() {
      try {
        await tokenProvider.getToken({ interactive: false });
        return true;
      } catch {
        tokenProvider.clear();
        return false;
      }
    },
    getToken(options) {
      return tokenProvider.getToken(options);
    },
    clear() {
      tokenProvider.clear();
    },
    hasToken() {
      return tokenProvider.hasToken();
    },
  };
}
