import assert from "node:assert/strict";
import test from "node:test";
import { validateTree } from "../src/model/validate-tree.mjs";
import {
  createNode,
  indentUnderPreviousSibling,
  moveNode,
  outdentPreservingOutline,
  renameNode,
  reorderNodeByDelta,
} from "../src/model/outline-operations.mjs";

const node = (id, parentId = null, childIds = []) => ({
  id,
  title: id,
  parentId,
  childIds: [...childIds],
  collapsed: false,
  createdAt: 1,
  completedAt: null,
  dueAt: null,
  note: "",
  completedChildCount: 0,
});

const makeDoc = () => ({
  schemaVersion: 3,
  nodes: {
    a: node("a", null, ["a1", "a2", "a3"]),
    a1: node("a1", "a"),
    a2: node("a2", "a", ["a2x"]),
    a2x: node("a2x", "a2"),
    a3: node("a3", "a"),
    b: node("b"),
  },
  rootIds: ["a", "b"],
  selectedId: null,
  ui: { categoryMode: false },
});

function assertValid(doc) {
  assert.deepEqual(validateTree(doc), { ok: true, errors: [] });
}

test("createNode inserts deterministic nodes at root and child positions", () => {
  const doc = makeDoc();
  assert.equal(createNode(doc, { id: "root-new", title: "Root", createdAt: 10, index: 1 }).changed, true);
  assert.deepEqual(doc.rootIds, ["a", "root-new", "b"]);
  assert.equal(createNode(doc, { id: "child-new", title: "Child", parentId: "a", createdAt: 11 }).changed, true);
  assert.deepEqual(doc.nodes.a.childIds, ["a1", "a2", "a3", "child-new"]);
  assert.equal(doc.nodes["child-new"].parentId, "a");
  assertValid(doc);
});

test("createNode rejects missing parents and duplicate ids without mutation", () => {
  const doc = makeDoc();
  const before = structuredClone(doc);
  assert.equal(createNode(doc, { id: "x", title: "X", parentId: "missing", createdAt: 1 }).changed, false);
  assert.equal(createNode(doc, { id: "a", title: "Duplicate", createdAt: 1 }).changed, false);
  assert.deepEqual(doc, before);
});

test("moveNode moves between root and parents while preserving the subtree", () => {
  const doc = makeDoc();
  const moved = moveNode(doc, { id: "a2", parentId: "b", index: "end" });
  assert.equal(moved.changed, true);
  assert.deepEqual(doc.nodes.a.childIds, ["a1", "a3"]);
  assert.deepEqual(doc.nodes.b.childIds, ["a2"]);
  assert.equal(doc.nodes.a2.parentId, "b");
  assert.equal(doc.nodes.a2x.parentId, "a2");

  assert.equal(moveNode(doc, { id: "a2", parentId: null, index: 1 }).changed, true);
  assert.deepEqual(doc.rootIds, ["a", "a2", "b"]);
  assertValid(doc);
});

test("moveNode handles forward indices in the same sibling list", () => {
  const doc = makeDoc();
  assert.equal(moveNode(doc, { id: "a1", parentId: "a", index: 3 }).changed, true);
  assert.deepEqual(doc.nodes.a.childIds, ["a2", "a3", "a1"]);
  assert.equal(moveNode(doc, { id: "a3", parentId: "a", index: 1 }).changed, false);
  assertValid(doc);
});

test("moveNode rejects self and descendant destinations without mutation", () => {
  const doc = makeDoc();
  const before = structuredClone(doc);
  assert.equal(moveNode(doc, { id: "a", parentId: "a", index: "end" }).changed, false);
  assert.equal(moveNode(doc, { id: "a", parentId: "a2x", index: "end" }).changed, false);
  assert.deepEqual(doc, before);
});

test("indent uses the previous sibling as parent and expands it", () => {
  const doc = makeDoc();
  doc.nodes.a1.collapsed = true;
  const result = indentUnderPreviousSibling(doc, { id: "a2" });
  assert.equal(result.changed, true);
  assert.deepEqual(doc.nodes.a.childIds, ["a1", "a3"]);
  assert.deepEqual(doc.nodes.a1.childIds, ["a2"]);
  assert.equal(doc.nodes.a2.parentId, "a1");
  assert.equal(doc.nodes.a1.collapsed, false);
  assert.equal(indentUnderPreviousSibling(doc, { id: "a1" }).changed, false);
  assertValid(doc);
});

test("outdent preserves outline semantics by adopting following siblings", () => {
  const doc = makeDoc();
  const result = outdentPreservingOutline(doc, { id: "a2" });
  assert.equal(result.changed, true);
  assert.deepEqual(doc.rootIds, ["a", "a2", "b"]);
  assert.deepEqual(doc.nodes.a.childIds, ["a1"]);
  assert.deepEqual(doc.nodes.a2.childIds, ["a2x", "a3"]);
  assert.equal(doc.nodes.a3.parentId, "a2");
  assert.equal(outdentPreservingOutline(doc, { id: "a" }).changed, false);
  assertValid(doc);
});

test("reorder changes only sibling order", () => {
  const doc = makeDoc();
  assert.equal(reorderNodeByDelta(doc, { id: "a2", delta: -1 }).changed, true);
  assert.deepEqual(doc.nodes.a.childIds, ["a2", "a1", "a3"]);
  assert.equal(doc.nodes.a2.parentId, "a");
  assert.equal(reorderNodeByDelta(doc, { id: "a2", delta: -1 }).changed, false);
  assertValid(doc);
});

test("renameNode is a no-op for the same title", () => {
  const doc = makeDoc();
  assert.equal(renameNode(doc, { id: "a", title: "a" }).changed, false);
  assert.equal(renameNode(doc, { id: "a", title: "Renamed" }).changed, true);
  assert.equal(doc.nodes.a.title, "Renamed");
  assertValid(doc);
});
