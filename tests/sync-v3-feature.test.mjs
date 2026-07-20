import assert from "node:assert/strict";
import test from "node:test";

import { isSyncV3Enabled } from "../src/google/sync-v3-feature.mjs";

function documentWith(content = null) {
  return {
    querySelector() {
      return content == null ? null : { content };
    },
  };
}

test("sync v3 stays disabled on the public domain without an enabled build flag", () => {
  assert.equal(isSyncV3Enabled({
    locationObj: { hostname: "taskliner.app", search: "?syncV3=1" },
    documentObj: documentWith(),
  }), false);
});

test("sync v3 can run on local and preview builds", () => {
  assert.equal(isSyncV3Enabled({
    locationObj: { hostname: "localhost", search: "" },
    documentObj: documentWith(),
  }), true);
  assert.equal(isSyncV3Enabled({
    locationObj: { hostname: "branch.taskliner.pages.dev", search: "?syncV3=1" },
    documentObj: documentWith(),
  }), true);
  assert.equal(isSyncV3Enabled({
    locationObj: { hostname: "branch.taskliner.pages.dev", search: "" },
    documentObj: documentWith("preview"),
  }), true);
});

test("an enabled build flag is explicit and the local query can disable v3", () => {
  assert.equal(isSyncV3Enabled({
    locationObj: { hostname: "taskliner.app", search: "" },
    documentObj: documentWith("enabled"),
  }), true);
  assert.equal(isSyncV3Enabled({
    locationObj: { hostname: "localhost", search: "?syncV3=0" },
    documentObj: documentWith(),
  }), false);
});
