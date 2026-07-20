const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 30_000;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (typeof headers !== "object") return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

/**
 * Convert a Retry-After header to milliseconds.
 * Both the RFC seconds form and the HTTP-date form are accepted.
 */
export function parseRetryAfter(value, { now = Date.now() } = {}) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const seconds = finiteNonNegative(raw);
  if (seconds != null) return Math.round(seconds * 1_000);

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Number(now));
}

export function retryAfterMs(headers, options = {}) {
  return parseRetryAfter(headerValue(headers, "Retry-After"), options);
}

export function calculateBackoffDelay(attempt = 0, {
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  retryAfter,
  retryAfterMs: explicitRetryAfterMs,
  headers,
  now = Date.now(),
  jitterRatio = 0,
  random = Math.random,
} = {}) {
  const retryDelay = explicitRetryAfterMs != null
    ? finiteNonNegative(explicitRetryAfterMs)
    : parseRetryAfter(retryAfter ?? headerValue(headers, "Retry-After"), { now });
  const maxDelay = Math.max(0, Number(maxDelayMs) || 0);
  if (retryDelay != null) return Math.min(retryDelay, maxDelay);

  const baseDelay = Math.max(0, Number(baseDelayMs) || 0);
  const retryAttempt = Math.max(0, Math.floor(Number(attempt) || 0));
  const exponentialDelay = Math.min(maxDelay, baseDelay * (2 ** retryAttempt));
  const ratio = Math.max(0, Number(jitterRatio) || 0);
  if (!ratio) return Math.round(exponentialDelay);

  const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
  const jitter = (randomValue * 2 - 1) * ratio * exponentialDelay;
  return Math.max(0, Math.min(maxDelay, Math.round(exponentialDelay + jitter)));
}

export function isRetryableStatus(status) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code <= 599);
}

export function isRetryableError(error) {
  return !!error && (error.retryable === true || isRetryableStatus(error.status));
}

export function sleep(delayMs, setTimeoutFn = globalThis.setTimeout) {
  const delay = Math.max(0, Number(delayMs) || 0);
  return new Promise((resolve) => setTimeoutFn(resolve, delay));
}

/**
 * Retry an operation after rate-limit or server errors.
 * The operation receives the zero-based attempt number.
 */
export async function retryWithBackoff(operation, {
  maxRetries = 3,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  jitterRatio = 0,
  random = Math.random,
  sleepFn = sleep,
  now = Date.now,
} = {}) {
  let attempt = 0;
  const retries = Math.max(0, Math.floor(Number(maxRetries) || 0));

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= retries || !isRetryableError(error)) throw error;
      const headers = error?.response?.headers;
      const delay = calculateBackoffDelay(attempt, {
        baseDelayMs,
        maxDelayMs,
        jitterRatio,
        random,
        retryAfterMs: error?.retryAfterMs,
        headers,
        now: now(),
      });
      await sleepFn(delay);
      attempt += 1;
    }
  }
}

export const getRetryAfterMs = retryAfterMs;
export const getBackoffDelay = calculateBackoffDelay;
