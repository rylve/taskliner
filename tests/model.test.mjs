import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createActiveTreeProjection,
  repairTreeLinks,
  validateTree,
} from "../src/model/validate-tree.mjs";
import { splitDocument, SPLIT_FORMAT } from "../src/storage/storage-adapter.mjs";
import { createDeviceState } from "../src/sync/device-state.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/taskliner-v1.json", import.meta.url), "utf8")
);

test("representative taskliner-v1 fixture has a valid tree", () => {
  assert.deepEqual(validateTree(fixture), { ok: true, errors: [] });
});

test("JSON export/import preserves the representative document", () => {
  const roundTrip = JSON.parse(JSON.stringify(fixture));
  assert.deepEqual(roundTrip, fixture);
  assert.equal(validateTree(roundTrip).ok, true);
});

test("validator rejects cycles and inconsistent links", () => {
  const broken = structuredClone(fixture);
  broken.nodes.root.parentId = "child";
  broken.nodes.child.childIds = ["root"];
  broken.rootIds = ["root"];
  const result = validateTree(broken);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /cycle|rootIds contains a child node|parent\/child mismatch/);
});

test("splitDocument keeps the active projection complete and archives completed payloads", () => {
  const full = {
    schemaVersion: 3,
    nodes: {
      root: {
        id: "root",
        title: "Root",
        parentId: null,
        childIds: ["active", "done"],
        collapsed: false,
        createdAt: 1,
        completedAt: null,
        dueAt: null,
        note: "",
      },
      active: {
        id: "active",
        title: "Active",
        parentId: "root",
        childIds: [],
        collapsed: false,
        createdAt: 2,
        completedAt: null,
        dueAt: null,
        note: "",
      },
      done: {
        id: "done",
        title: "Done",
        parentId: "root",
        childIds: ["done-child"],
        collapsed: false,
        createdAt: 3,
        completedAt: 4,
        dueAt: null,
        note: "private detail",
      },
      "done-child": {
        id: "done-child",
        title: "Done child",
        parentId: "done",
        childIds: [],
        collapsed: false,
        createdAt: 5,
        completedAt: 4,
        dueAt: null,
        note: "child detail",
      },
    },
    rootIds: ["root"],
    selectedId: "done",
    ui: {},
  };

  const { doc, archiveNodes } = splitDocument(full);
  assert.equal(doc.storageFormat, SPLIT_FORMAT);
  assert.deepEqual(Object.keys(doc.nodes).sort(), ["active", "root"]);
  assert.deepEqual(doc.nodes.root.childIds, ["active", "done"]);
  assert.equal(doc.nodes.root.completedChildCount, 1);
  assert.equal(doc.selectedId, null);
  assert.deepEqual(
    archiveNodes.map((node) => node.id).sort(),
    ["done", "done-child"]
  );
  assert.equal(archiveNodes.find((node) => node.id === "done")?.note, "private detail");
});

test("split projections repair active links while preserving archive positions locally", () => {
  const doc = {
    schemaVersion: 3,
    nodes: {
      root: {
        id: "root", title: "Root", parentId: null,
        childIds: ["child", "moved", "archived"], collapsed: false,
        createdAt: 1, completedAt: null, dueAt: null, note: "",
      },
      child: {
        id: "child", title: "Child", parentId: "root",
        childIds: [], collapsed: false,
        createdAt: 2, completedAt: null, dueAt: null, note: "",
      },
      other: {
        id: "other", title: "Other", parentId: null,
        childIds: [], collapsed: false,
        createdAt: 3, completedAt: null, dueAt: null, note: "",
      },
      moved: {
        id: "moved", title: "Moved", parentId: "other",
        childIds: [], collapsed: false,
        createdAt: 4, completedAt: null, dueAt: null, note: "",
      },
    },
    rootIds: ["root", "other", "moved", "archived-root"],
    selectedId: null,
    ui: {},
  };

  assert.equal(repairTreeLinks(doc, { preserveExternalIds: true }).changed, true);
  assert.deepEqual(doc.nodes.root.childIds, ["child", "archived"]);
  assert.deepEqual(doc.nodes.other.childIds, ["moved"]);
  assert.deepEqual(doc.rootIds, ["root", "other", "archived-root"]);

  const syncProjection = createActiveTreeProjection(doc);
  assert.deepEqual(syncProjection.nodes.root.childIds, ["child"]);
  assert.deepEqual(syncProjection.rootIds, ["root", "other"]);
  assert.deepEqual(validateTree(syncProjection), { ok: true, errors: [] });
});

test("device state creation accepts archive placeholders from split storage", () => {
  const full = {
    schemaVersion: 3,
    nodes: {
      root: {
        id: "root", title: "Root", parentId: null,
        childIds: ["active", "done"], collapsed: false,
        createdAt: 1, completedAt: null, dueAt: null, note: "",
      },
      active: {
        id: "active", title: "Active", parentId: "root",
        childIds: [], collapsed: false,
        createdAt: 2, completedAt: null, dueAt: null, note: "",
      },
      done: {
        id: "done", title: "Done", parentId: "root",
        childIds: [], collapsed: false,
        createdAt: 3, completedAt: 4, dueAt: null, note: "",
      },
    },
    rootIds: ["root"],
    selectedId: null,
    ui: {},
  };
  const { doc } = splitDocument(full);
  const state = createDeviceState({
    doc,
    workspaceId: "workspace",
    deviceId: "device",
    lamportCounter: 1,
  });

  assert.deepEqual(Object.keys(state.nodes).sort(), ["active", "root"]);
  assert.equal(state.nodes.active.parentId.value, "root");
});
