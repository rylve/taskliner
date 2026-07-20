import assert from "node:assert/strict";
import test from "node:test";
import { GOOGLE_CLIENT_IDS, getGoogleClientEnvironment, getGoogleClientId } from "../src/google/google-config.mjs";

test("Google client selection keeps development and production origins separate", () => {
  assert.equal(getGoogleClientEnvironment("localhost"), "development");
  assert.equal(getGoogleClientEnvironment("localhost."), "development");
  assert.equal(getGoogleClientId("localhost"), GOOGLE_CLIENT_IDS.development);
  assert.equal(getGoogleClientEnvironment("taskliner.app"), "production");
  assert.equal(getGoogleClientEnvironment("www.taskliner.app"), "production");
  assert.equal(getGoogleClientId("taskliner.app"), GOOGLE_CLIENT_IDS.production);
  assert.equal(getGoogleClientEnvironment("preview.pages.dev"), "development");
  assert.equal(getGoogleClientId("unknown.example"), null);
});
