import assert from "node:assert/strict";
import { getLayoutNodeData } from "../../src/utils/layoutLayerState.js";
import {
  alignLayoutNodes,
  canMatchSelectionSize,
  distributeLayoutNodes,
  getAxisAlignedNodeBounds,
} from "../../src/utils/layoutSelectionOperations.js";
import { test } from "./harness.mjs";


test("selection alignment uses rotated axis-aligned bounds", () => {
  const layout = {
    stickers: [
      { id: "anchor", x: 0, y: 0, width: 20, height: 20, rotation: 0 },
      { id: "rotated", x: 100, y: 0, width: 40, height: 20, rotation: 90 },
    ],
  };
  const refs = [
    { type: "sticker", id: "anchor" },
    { type: "sticker", id: "rotated" },
  ];

  assert.equal(getAxisAlignedNodeBounds(layout, refs[1]).left, 110);
  const aligned = alignLayoutNodes(layout, refs, "left");
  assert.equal(getLayoutNodeData(aligned, refs[0]).x, 0);
  assert.equal(getLayoutNodeData(aligned, refs[1]).x, -10);
  assert.equal(getAxisAlignedNodeBounds(aligned, refs[0]).left, 0);
  assert.equal(Math.abs(getAxisAlignedNodeBounds(aligned, refs[1]).left), 0);
});


test("selection distribution gives three objects equal edge gaps", () => {
  const layout = {
    text_labels: [
      { id: "first", x: 0, y: 10, width: 10, height: 20 },
      { id: "middle", x: 30, y: 10, width: 20, height: 20 },
      { id: "last", x: 100, y: 10, width: 30, height: 20 },
    ],
  };
  const refs = ["first", "middle", "last"].map(id => ({ type: "text", id }));
  const distributed = distributeLayoutNodes(layout, refs, "horizontal");
  const bounds = refs.map(ref => getAxisAlignedNodeBounds(distributed, ref));

  assert.deepEqual(bounds.map(item => item.left), [0, 45, 100]);
  assert.equal(bounds[1].left - bounds[0].right, 35);
  assert.equal(bounds[2].left - bounds[1].right, 35);
});


test("selection operations leave the whole selection unchanged when a node is hidden or locked", () => {
  const hiddenLayout = {
    stickers: [
      { id: "visible", x: 0, y: 0, width: 20, height: 20 },
      { id: "hidden", x: 100, y: 0, width: 20, height: 20, visible: false },
    ],
  };
  const hiddenRefs = [
    { type: "sticker", id: "visible" },
    { type: "sticker", id: "hidden" },
  ];
  assert.equal(alignLayoutNodes(hiddenLayout, hiddenRefs, "left"), hiddenLayout);

  const lockedLayout = {
    text_labels: [
      { id: "first", x: 0, y: 0, width: 20, height: 20 },
      { id: "middle", x: 40, y: 0, width: 20, height: 20, locked: true },
      { id: "last", x: 100, y: 0, width: 20, height: 20 },
    ],
  };
  const lockedRefs = ["first", "middle", "last"].map(id => ({ type: "text", id }));
  assert.equal(distributeLayoutNodes(lockedLayout, lockedRefs, "horizontal"), lockedLayout);
  assert.deepEqual(lockedLayout.text_labels.map(item => item.x), [0, 40, 100]);
});


test("matching selection size accepts only compatible visible unlocked leaf types", () => {
  const layout = {
    photo_slots: [
      { id: "wide-a", width: 400, height: 200 },
      { id: "wide-b", width: 200, height: 100 },
      { id: "square", width: 100, height: 100 },
      { id: "locked-wide", width: 300, height: 150, locked: true },
    ],
    text_labels: [
      { id: "text-a", width: 100, height: 40 },
      { id: "text-b", width: 200, height: 90 },
      { id: "hidden-text", width: 100, height: 40, visible: false },
    ],
    stickers: [{ id: "sticker", width: 100, height: 40 }],
  };
  const ref = (type, id) => ({ type, id });

  assert.equal(canMatchSelectionSize(layout, [ref("text", "text-a"), ref("text", "text-b")]), true);
  assert.equal(canMatchSelectionSize(layout, [ref("photo", "wide-a"), ref("photo", "wide-b")]), true);
  assert.equal(canMatchSelectionSize(layout, [ref("photo", "wide-a"), ref("photo", "square")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("text", "text-a"), ref("sticker", "sticker")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("text", "text-a"), ref("text", "hidden-text")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("photo", "wide-a"), ref("photo", "locked-wide")]), false);
  assert.equal(canMatchSelectionSize(layout, [ref("group", "one"), ref("group", "two")]), false);
});
