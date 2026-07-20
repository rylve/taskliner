import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDriveStatus,
  createDriveAppDataClient,
  createMemoryTokenProvider,
  DriveApiError,
} from "../src/google/drive-appdata.mjs";
import {
  calculateBackoffDelay,
  parseRetryAfter,
  retryWithBackoff,
} from "../src/sync/backoff.mjs";

function response(status, body = null, headers = {}) {
  return new Response(status === 204 || body == null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function bodyText(body) {
  if (typeof body === "string") return body;
  return body ? body.text() : "";
}

test("appData client injects the token and restricts list to appDataFolder", async () => {
  const calls = [];
  const client = createDriveAppDataClient({
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(200, { files: [{ id: "file-1", name: "device.json" }], nextPageToken: "next" });
    },
    tokenProvider: createMemoryTokenProvider("memory-token"),
    baseUrl: "https://drive.test/drive/v3/files",
  });

  const result = await client.list({ pageSize: 10, q: "name = 'device.json'" });
  assert.deepEqual(result.files, [{ id: "file-1", name: "device.json" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer memory-token");
  assert.equal(calls[0].url.searchParams.get("spaces"), "appDataFolder");
  assert.equal(calls[0].url.searchParams.get("pageSize"), "10");
  assert.equal(calls[0].url.searchParams.get("q"), "name = 'device.json'");
});

test("get, create, update, and delete use Drive file REST endpoints", async () => {
  const calls = [];
  const statuses = [200, 200, 200, 204];
  const client = createDriveAppDataClient({
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(statuses.shift(), { id: "file/1", name: "state.json" });
    },
    tokenProvider: createMemoryTokenProvider("token"),
    baseUrl: "https://drive.test/drive/v3/files",
    uploadBaseUrl: "https://drive.test/upload/drive/v3/files",
  });

  await client.get("file/1");
  await client.create({ name: "state.json", content: { version: 1 }, mimeType: "application/json" });
  await client.update("file/1", { content: "encrypted", mimeType: "text/plain" });
  await client.delete("file/1");

  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].url.pathname, "/drive/v3/files/file%2F1");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].url.pathname, "/upload/drive/v3/files");
  assert.equal(calls[1].url.searchParams.get("uploadType"), "multipart");
  assert.match(await bodyText(calls[1].options.body), /"parents":\["appDataFolder"\]/);
  assert.match(await bodyText(calls[1].options.body), /\{"version":1\}/);
  assert.equal(calls[2].options.method, "PATCH");
  assert.equal(calls[2].url.pathname, "/upload/drive/v3/files/file%2F1");
  assert.equal(calls[3].options.method, "DELETE");
  assert.equal(calls[3].url.pathname, "/drive/v3/files/file%2F1");
});

test("Drive errors preserve status and classify auth, quota, and server failures", async () => {
  for (const [status, category, retryable] of [
    [401, "unauthorized", false],
    [403, "forbidden", false],
    [429, "rate_limited", true],
    [503, "server_error", true],
  ]) {
    const client = createDriveAppDataClient({
      fetch: async () => response(status, { error: { message: "failure" } }, { "Retry-After": "2" }),
      tokenProvider: createMemoryTokenProvider("token"),
    });
    await assert.rejects(client.list(), (error) => {
      assert.ok(error instanceof DriveApiError);
      assert.equal(error.status, status);
      assert.equal(error.category, category);
      assert.equal(error.classification, category);
      assert.equal(error.retryable, retryable);
      if (status === 429 || status === 503) assert.equal(error.retryAfterMs, 2_000);
      return true;
    });
  }
  assert.equal(classifyDriveStatus(401), "unauthorized");
  assert.equal(classifyDriveStatus(403), "forbidden");
  assert.equal(classifyDriveStatus(429), "rate_limited");
  assert.equal(classifyDriveStatus(500), "server_error");
});

test("backoff accepts Retry-After seconds and HTTP dates", async () => {
  assert.equal(parseRetryAfter("2"), 2_000);
  const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:03 GMT", { now }), 3_000);
  assert.equal(calculateBackoffDelay(4, { retryAfter: "3", maxDelayMs: 10_000 }), 3_000);
  assert.equal(calculateBackoffDelay(2, { baseDelayMs: 100, maxDelayMs: 10_000 }), 400);
});

test("retryWithBackoff retries only retryable errors and can inject waiting", async () => {
  let attempts = 0;
  const waits = [];
  const result = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts < 3) throw new DriveApiError("busy", { status: 429, retryAfterMs: 25 });
    return "ok";
  }, {
    maxRetries: 2,
    sleepFn: async (delay) => waits.push(delay),
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [25, 25]);
});
