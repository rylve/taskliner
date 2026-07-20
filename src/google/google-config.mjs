const GOOGLE_CLIENT_IDS = Object.freeze({
  development: "178831316624-gpaec54du6kbrma8rkigcgm0do5f7fhm.apps.googleusercontent.com",
  production: "63879862520-mpo5621mhc4q4puu2e5oef2c46calcfb.apps.googleusercontent.com",
});

const PRODUCTION_HOSTS = new Set(["taskliner.app", "www.taskliner.app"]);

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
}

export function getGoogleClientEnvironment(hostname = globalThis.location?.hostname) {
  const normalized = normalizeHostname(hostname);
  if (PRODUCTION_HOSTS.has(normalized)) return "production";
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized.endsWith(".pages.dev")) {
    return "development";
  }
  return null;
}

export function getGoogleClientId(hostname = globalThis.location?.hostname) {
  const environment = getGoogleClientEnvironment(hostname);
  return environment ? GOOGLE_CLIENT_IDS[environment] : null;
}

export { GOOGLE_CLIENT_IDS };
