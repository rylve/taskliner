import assert from "node:assert/strict";
import test from "node:test";
import {
  activeChildrenOf,
  ancestorChain,
  canIndentNode,
  canMoveNode,
  canOutdentNode,
  canReorderNode,
  categoryRootOf,
  collectDescendantIds,
  depthOf,
  isAncestor,
  siblingList,
} from "../src/model/outline-selectors.mjs";

const doc = {
  nodes: {
    root: { id: "root", parentId: null, childIds: ["child", "done"], completedAt: null },
    child: { id: "child", parentId: "root", childIds: ["leaf"], completedAt: null },
    leaf: { id: "leaf", parentId: "child", childIds: [], completedAt: null },
    done: { id: "done", parentId: "root", childIds: [], completedAt: 1 },
    other: { id: "other", parentId: null, childIds: [], completedAt: null },
  },
  rootIds: ["root", "other"],
  ui: { categoryMode: true },
};

test("selectors return stable ancestry and descendants", () => {
  assert.equal(depthOf(doc, "leaf"), 2);
  assert.deepEqual(ancestorChain(doc, "leaf").map((node) => node.id), ["root", "child", "leaf"]);
  assert.deepEqual(collectDescendantIds(doc, "root"), ["child", "leaf", "done"]);
  assert.equal(isAncestor(doc, "root", "leaf"), true);
  assert.equal(isAncestor(doc, "other", "leaf"), false);
});

test("selectors expose active children, siblings, and category roots", () => {
  assert.deepEqual(activeChildrenOf(doc, "root").map((node) => node.id), ["child"]);
  assert.equal(siblingList(doc, "leaf"), doc.nodes.child.childIds);
  assert.equal(siblingList(doc, "other"), doc.rootIds);
  assert.equal(categoryRootOf(doc, "leaf")?.id, "root");
  assert.equal(categoryRootOf(doc, "root"), null);
});

test("capability selectors prevent invalid structure changes", () => {
  assert.equal(canMoveNode(doc, "child", "other"), true);
  assert.equal(canMoveNode(doc, "root", "leaf"), false);
  assert.equal(canIndentNode(doc, "other"), true);
  assert.equal(canOutdentNode(doc, "leaf"), true);
  assert.equal(canOutdentNode(doc, "root"), false);
  assert.equal(canReorderNode(doc, "root", 1), true);
  assert.equal(canReorderNode(doc, "other", 1), false);
});
