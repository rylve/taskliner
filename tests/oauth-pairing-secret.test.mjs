import assert from "node:assert/strict";
import test from "node:test";

import { safeReturnTo } from "../functions/_lib/return-to.mjs";
import { createGoogleServerAuth } from "../src/google/server-auth.mjs";
import { capturePairingFragment, PAIRING_FRAGMENT_SESSION_KEY } from "../src/pairing/pairing-fragment.mjs";

test("OAuth returnTo never includes a pairing fragment", () => {
  let assigned = "";
  const auth = createGoogleServerAuth({
    fetchImpl: async () => Response.json({ authenticated: false }),
    locationObj: {
      origin: "https://taskliner.app",
      protocol: "https:",
      pathname: "/",
      search: "?source=pairing",
      hash: "#taskliner-pair=offer.secret",
      assign(value) { assigned = value; },
    },
  });
  auth.connect();
  const login = new URL(assigned, "https://taskliner.app");
  assert.equal(login.searchParams.get("returnTo"), "/?source=pairing");
  assert.equal(assigned.includes("secret"), false);
});

test("pairing fragments are removed before parsing and stay removed on parse failure", () => {
  const calls = [];
  const locationObj = {
    pathname: "/",
    search: "?source=qr",
    hash: "#taskliner-pair=malformed.secret",
    replace(value) { calls.push(["location.replace", value]); },
  };
  const historyObj = {
    state: null,
    replaceState(_state, _title, value) {
      calls.push(["history.replaceState", value]);
      locationObj.hash = "";
    },
  };
  const removed = [];
  const result = capturePairingFragment({
    locationObj,
    historyObj,
    sessionStorageObj: {
      getItem: () => "",
      setItem: () => { throw new Error("must not store"); },
      removeItem: (key) => removed.push(key),
    },
    parseFragment() {
      calls.push(["parse"]);
      throw new Error("invalid pairing fragment");
    },
  });
  assert.equal(result, "");
  assert.equal(locationObj.hash, "");
  assert.deepEqual(calls, [["history.replaceState", "/?source=qr"], ["parse"]]);
  assert.deepEqual(removed, [PAIRING_FRAGMENT_SESSION_KEY]);
});

test("pairing capture falls back to a fragment-free navigation when history replacement fails", () => {
  const replacements = [];
  let parsed = false;
  const result = capturePairingFragment({
    locationObj: {
      pathname: "/pair",
      search: "",
      hash: "#taskliner-pair=offer.secret",
      replace(value) { replacements.push(value); },
    },
    historyObj: { get state() { return null; }, replaceState() { throw new Error("blocked"); } },
    sessionStorageObj: null,
    parseFragment() { parsed = true; },
  });
  assert.equal(result, "");
  assert.deepEqual(replacements, ["/pair"]);
  assert.equal(parsed, false);
});

test("server returnTo sanitization removes fragments and rejects cross-origin paths", () => {
  assert.equal(safeReturnTo("/outline?tab=active#taskliner-pair=offer.secret"), "/outline?tab=active");
  assert.equal(safeReturnTo("//evil.example/#taskliner-pair=secret"), "/");
  assert.equal(safeReturnTo("https://evil.example/"), "/");
});
