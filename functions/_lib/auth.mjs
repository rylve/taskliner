const textEncoder = new TextEncoder();
const SESSION_COOKIE = "taskliner_session";
const OAUTH_STATE_COOKIE = "taskliner_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const OAUTH_STATE_MAX_AGE = 60 * 10;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signValue(secret, value) {
  const signature = await crypto.subtle.sign(
    { name: "HMAC" },
    await crypto.subtle.importKey("raw", textEncoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    textEncoder.encode(value),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyValue(secret, value, signature) {
  return crypto.subtle.verify(
    { name: "HMAC" },
    await crypto.subtle.importKey("raw", textEncoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
    base64UrlToBytes(signature),
    textEncoder.encode(value),
  );
}

async function secretKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(secret)));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await secretKey(secret), textEncoder.encode(plaintext));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(secret, payload) {
  const [version, encodedIv, encodedCiphertext] = String(payload || "").split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) throw new Error("Invalid encrypted secret");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(encodedIv) },
    await secretKey(secret),
    base64UrlToBytes(encodedCiphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function parseCookies(request) {
  const cookies = {};
  for (const part of request.headers.get("Cookie")?.split(";") || []) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      continue;
    }
  }
  return cookies;
}

export function serializeCookie(name, value, { maxAge = null, httpOnly = true, secure = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function encodePayload(payload) {
  return bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
}

function decodePayload(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

async function createSignedToken(secret, payload) {
  const encoded = encodePayload(payload);
  return `${encoded}.${await signValue(secret, encoded)}`;
}

async function readSignedToken(secret, token) {
  const [payload, signature] = String(token || "").split(".");
  let verified = false;
  try {
    verified = !!payload && !!signature && await verifyValue(secret, payload, signature);
  } catch {
    return null;
  }
  if (!verified) return null;
  let decoded;
  try {
    decoded = decodePayload(payload);
  } catch {
    return null;
  }
  if (!decoded || !Number.isFinite(decoded.exp) || decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded;
}

export function getOAuthStateCookieName() {
  return OAUTH_STATE_COOKIE;
}

export async function createOAuthState(secret, returnTo) {
  return createSignedToken(secret, {
    returnTo,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_MAX_AGE,
    nonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18))),
  });
}

export async function readOAuthState(secret, token) {
  return readSignedToken(secret, token);
}

export async function createSessionCookie(secret, googleSub) {
  return createSignedToken(secret, {
    sub: googleSub,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  });
}

export async function getSessionUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !env.AUTH_SECRET || !env.DB) return null;
  const payload = await readSignedToken(env.AUTH_SECRET, token);
  if (!payload?.sub) return null;
  return env.DB.prepare(
    `SELECT google_sub, email, refresh_token_ciphertext
       FROM taskliner_users WHERE google_sub = ?1`,
  ).bind(payload.sub).first();
}

export async function createAccountId(secret, googleSub) {
  const digest = await signValue(secret, `account:${googleSub}`);
  return digest.slice(0, 22);
}

export async function upsertUser(env, { googleSub, email, refreshToken }) {
  const existing = await env.DB.prepare(
    "SELECT refresh_token_ciphertext FROM taskliner_users WHERE google_sub = ?1",
  ).bind(googleSub).first();
  const ciphertext = refreshToken
    ? await encryptSecret(env.AUTH_SECRET, refreshToken)
    : existing?.refresh_token_ciphertext;
  if (!ciphertext) throw new Error("Google did not return a refresh token");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO taskliner_users (google_sub, email, refresh_token_ciphertext, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, refresh_token_ciphertext = excluded.refresh_token_ciphertext, updated_at = excluded.updated_at`,
  ).bind(googleSub, email || null, ciphertext, now).run();
}

export async function deleteUser(env, googleSub) {
  await env.DB.prepare("DELETE FROM taskliner_users WHERE google_sub = ?1").bind(googleSub).run();
}

export { OAUTH_STATE_COOKIE, SESSION_COOKIE, SESSION_MAX_AGE, OAUTH_STATE_MAX_AGE };
