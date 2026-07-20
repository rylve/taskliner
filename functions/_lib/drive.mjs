import { decryptSecret } from "./auth.mjs";
import { artifactAppProperties, artifactFileName } from "./sync-artifacts.mjs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

async function googleJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error_description || `Google API returned ${response.status}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

export async function getDriveAccessToken(env, user) {
  const refreshToken = await decryptSecret(env.AUTH_SECRET, user.refresh_token_ciphertext);
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  let token;
  try {
    token = await googleJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    if (error?.details?.error === "invalid_grant") {
      error.status = 401;
      error.code = "refresh_token_invalid";
    }
    throw error;
  }
  if (!token?.access_token) throw new Error("Google did not return an access token");
  return token.access_token;
}

function authHeaders(accessToken, extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

function quoteQuery(value) {
  return `'${String(value).replace(/'/g, "\\'")}'`;
}

export async function listTasklinerFiles(accessToken) {
  const files = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      spaces: "appDataFolder",
      pageSize: "100",
      q: `(appProperties has { key=${quoteQuery("taskliner")} and value=${quoteQuery("sync")} } or name contains ${quoteQuery("taskliner-device-v2.")}) and trashed = false`,
      fields: "nextPageToken,files(id,name,modifiedTime,version,size,appProperties)",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const result = await googleJson(`${DRIVE_API}/files?${params}`, { headers: authHeaders(accessToken) });
    if (Array.isArray(result?.files)) files.push(...result.files);
    pageToken = result?.nextPageToken || null;
  } while (pageToken);
  return files;
}

export async function downloadFile(accessToken, fileId) {
  return googleJson(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: authHeaders(accessToken) });
}

async function uploadMultipart(accessToken, { fileId = null, name, content, appProperties }) {
  const boundary = `taskliner-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, mimeType: "application/json", appProperties, ...(fileId ? {} : { parents: ["appDataFolder"] }) });
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n`,
    `--${boundary}--\r\n`,
  ].join("");
  const url = fileId
    ? `${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,modifiedTime,version,appProperties`
    : `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime,version,appProperties`;
  return googleJson(url, {
    method: fileId ? "PATCH" : "POST",
    headers: authHeaders(accessToken, { "Content-Type": `multipart/related; boundary="${boundary}"` }),
    body,
  });
}

export async function writeTasklinerFile(accessToken, { fileId = null, deviceId, state }) {
  return uploadMultipart(accessToken, {
    fileId,
    name: `taskliner-device-v2.${deviceId}.json`,
    content: JSON.stringify(state),
    appProperties: { taskliner: "sync", format: "taskliner-device-state", version: "1", deviceId },
  });
}

export async function writeSyncArtifact(accessToken, { fileId = null, kind, artifactId, payload }) {
  return uploadMultipart(accessToken, {
    fileId,
    name: artifactFileName(kind, artifactId),
    content: JSON.stringify(payload),
    appProperties: artifactAppProperties(kind, artifactId),
  });
}

export async function deleteFile(accessToken, fileId) {
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: authHeaders(accessToken),
  });
  if (!response.ok && response.status !== 404) {
    const error = new Error(`Google Drive delete returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
}
