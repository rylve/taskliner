import {
  isRetryableStatus,
  retryAfterMs,
} from "../sync/backoff.mjs";

const DEFAULT_BASE_URL = "https://www.googleapis.com/drive/v3/files";
const DEFAULT_UPLOAD_BASE_URL = "https://www.googleapis.com/upload/drive/v3/files";
const DEFAULT_FIELDS = "id,name,mimeType,size,modifiedTime,version,trashed,parents,appProperties";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeAccessToken(value) {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  if (typeof value.accessToken === "string") return value.accessToken;
  if (typeof value.token === "string") return value.token;
  return null;
}

/**
 * A deliberately memory-only token provider. It does not refresh, persist, or
 * otherwise implement an OAuth flow.
 */
export function createMemoryTokenProvider(initialToken = null) {
  let token = normalizeAccessToken(initialToken);
  return {
    getToken() {
      return token;
    },
    getAccessToken() {
      return token;
    },
    setToken(nextToken) {
      token = normalizeAccessToken(nextToken);
      return token;
    },
    clear() {
      token = null;
    },
    clearToken() {
      token = null;
    },
    hasToken() {
      return !!token;
    },
  };
}

export function classifyDriveStatus(status) {
  const code = Number(status);
  if (code === 401) return "unauthorized";
  if (code === 403) return "forbidden";
  if (code === 429) return "rate_limited";
  if (code >= 500 && code <= 599) return "server_error";
  if (code >= 400 && code <= 499) return "client_error";
  return "unknown";
}

export class DriveApiError extends Error {
  constructor(message, {
    status = null,
    category = classifyDriveStatus(status),
    body = null,
    response = null,
    retryAfterMs = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DriveApiError";
    this.status = status;
    this.category = category;
    this.classification = category;
    this.kind = category;
    this.body = body;
    this.response = response;
    this.retryAfterMs = retryAfterMs;
    this.retryable = isRetryableStatus(status);
  }
}

function encodePathPart(value) {
  if (typeof value !== "string" || !value) throw new TypeError("fileId must be a non-empty string");
  return encodeURIComponent(value);
}

function setQuery(url, parameters) {
  for (const [key, value] of Object.entries(parameters || {})) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function parseJsonText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readBody(response) {
  if (response.status === 204) return null;
  if (typeof response.text === "function") return parseJsonText(await response.text());
  if (typeof response.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

function bodyHasContent(input) {
  return isRecord(input) && (Object.prototype.hasOwnProperty.call(input, "content")
    || Object.prototype.hasOwnProperty.call(input, "data"));
}

function contentValue(input) {
  if (Object.prototype.hasOwnProperty.call(input, "content")) return input.content;
  return input.data;
}

function jsonStringify(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer)) return value;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value;
  return JSON.stringify(value);
}

function multipartBody(metadata, content, mimeType) {
  const boundary = `taskliner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const media = jsonStringify(content);
  const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const suffix = `\r\n--${boundary}--`;
  const body = typeof Blob !== "undefined" ? new Blob([prefix, media, suffix]) : `${prefix}${media}${suffix}`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

function normalizeCreateInput(input = {}) {
  if (!isRecord(input)) throw new TypeError("create options must be an object");
  const metadata = isRecord(input.metadata) ? { ...input.metadata } : {};
  for (const key of ["name", "mimeType", "appProperties", "description"]) {
    if (input[key] !== undefined) metadata[key] = input[key];
  }
  if (!metadata.name) throw new TypeError("create requires a file name");
  metadata.parents = ["appDataFolder"];
  return {
    metadata,
    hasContent: bodyHasContent(input),
    content: bodyHasContent(input) ? contentValue(input) : undefined,
    fields: input.fields,
    mimeType: input.mediaMimeType || metadata.mimeType || "application/octet-stream",
  };
}

function normalizeUpdateInput(input = {}) {
  if (!isRecord(input)) throw new TypeError("update options must be an object");
  const metadata = isRecord(input.metadata) ? { ...input.metadata } : {};
  for (const key of ["name", "mimeType", "appProperties", "description"]) {
    if (input[key] !== undefined) metadata[key] = input[key];
  }
  return {
    metadata,
    hasContent: bodyHasContent(input),
    content: bodyHasContent(input) ? contentValue(input) : undefined,
    fields: input.fields,
    mimeType: input.mediaMimeType || metadata.mimeType || "application/octet-stream",
  };
}

async function getToken(tokenProvider) {
  if (!tokenProvider) throw new DriveApiError("No access token provider was supplied", { status: 401 });
  const value = typeof tokenProvider === "function"
    ? await tokenProvider()
    : await (tokenProvider.getToken?.() ?? tokenProvider.getAccessToken?.());
  const token = normalizeAccessToken(value);
  if (!token) throw new DriveApiError("No access token is available", { status: 401 });
  return token;
}

/**
 * Minimal Google Drive v3 client restricted to the appDataFolder space.
 * OAuth is intentionally outside this module; callers provide a token source.
 */
export function createDriveAppDataClient({
  fetch: injectedFetch,
  fetchImpl,
  tokenProvider,
  baseUrl = DEFAULT_BASE_URL,
  uploadBaseUrl,
} = {}) {
  const requestFetch = injectedFetch || fetchImpl;
  if (typeof requestFetch !== "function") throw new TypeError("fetch must be injected");
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  const normalizedUploadBaseUrl = String(uploadBaseUrl || (
    normalizedBaseUrl === DEFAULT_BASE_URL
      ? DEFAULT_UPLOAD_BASE_URL
      : normalizedBaseUrl.replace(/\/drive\/v3\/files$/, "/upload/drive/v3/files")
  )).replace(/\/+$/, "");

  const request = async (method, path, { query, body, contentType } = {}) => {
    const url = setQuery(new URL(`${normalizedBaseUrl}${path}`), query);
    const token = await getToken(tokenProvider);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (contentType) headers["Content-Type"] = contentType;
    let response;
    try {
      response = await requestFetch(url.toString(), { method, headers, body });
    } catch (error) {
      throw new DriveApiError("Drive request failed before receiving a response", {
        category: "network_error",
        cause: error,
      });
    }

    const parsedBody = await readBody(response);
    const status = Number(response.status);
    const ok = typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300;
    if (!ok) {
      const retryAfter = retryAfterMs(response.headers);
      const detail = isRecord(parsedBody) ? parsedBody.error?.message || parsedBody.error_description : parsedBody;
      throw new DriveApiError(detail || `Drive API request failed with status ${status}`, {
        status,
        body: parsedBody,
        response,
        retryAfterMs: retryAfter,
      });
    }
    return parsedBody;
  };

  const requestUpload = async (method, path, options) => {
    const url = setQuery(new URL(`${normalizedUploadBaseUrl}${path}`), options.query);
    const token = await getToken(tokenProvider);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": options.contentType,
    };
    let response;
    try {
      response = await requestFetch(url.toString(), { method, headers, body: options.body });
    } catch (error) {
      throw new DriveApiError("Drive upload request failed before receiving a response", {
        category: "network_error",
        cause: error,
      });
    }
    const parsedBody = await readBody(response);
    const status = Number(response.status);
    const ok = typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300;
    if (!ok) {
      const retryAfter = retryAfterMs(response.headers);
      const detail = isRecord(parsedBody) ? parsedBody.error?.message || parsedBody.error_description : parsedBody;
      throw new DriveApiError(detail || `Drive API request failed with status ${status}`, {
        status,
        body: parsedBody,
        response,
        retryAfterMs: retryAfter,
      });
    }
    return parsedBody;
  };

  return {
    list({ pageSize = 100, pageToken, q, fields = DEFAULT_FIELDS } = {}) {
      return request("GET", "", {
        query: {
          spaces: "appDataFolder",
          pageSize,
          pageToken,
          q,
          fields: fields || undefined,
        },
      });
    },

    get(fileId, { fields = DEFAULT_FIELDS, alt } = {}) {
      return request("GET", `/${encodePathPart(fileId)}`, {
        query: { fields: fields || undefined, alt },
      });
    },

    download(fileId) {
      return request("GET", `/${encodePathPart(fileId)}`, { query: { alt: "media" } });
    },

    create(input) {
      const normalized = normalizeCreateInput(input);
      const query = { uploadType: "multipart", fields: normalized.fields || undefined };
      if (!normalized.hasContent) {
        return request("POST", "", {
          query: { fields: normalized.fields || undefined },
          body: JSON.stringify(normalized.metadata),
          contentType: "application/json; charset=UTF-8",
        });
      }
      const multipart = multipartBody(normalized.metadata, normalized.content, normalized.mimeType);
      return requestUpload("POST", "", { query, ...multipart });
    },

    update(fileId, input = {}) {
      const normalized = normalizeUpdateInput(input);
      if (!normalized.hasContent) {
        return request("PATCH", `/${encodePathPart(fileId)}`, {
          query: { fields: normalized.fields || undefined },
          body: JSON.stringify(normalized.metadata),
          contentType: "application/json; charset=UTF-8",
        });
      }
      const multipart = multipartBody(normalized.metadata, normalized.content, normalized.mimeType);
      return requestUpload("PATCH", `/${encodePathPart(fileId)}`, {
        query: { uploadType: "multipart", fields: normalized.fields || undefined },
        ...multipart,
      });
    },

    delete(fileId) {
      return request("DELETE", `/${encodePathPart(fileId)}`);
    },
  };
}

export const classifyStatus = classifyDriveStatus;
