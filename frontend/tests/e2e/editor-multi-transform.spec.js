import { expect, test } from "@playwright/test";

import {
  createTemplateWithLayout,
  fetchTemplatePageLayout,
  loginViaApi,
  saveTemplateLayout,
} from "./helpers.js";

const SCALE = 530 / 794;

function canvasPoint(realX, realY) {
  return { x: Math.round(realX * SCALE), y: Math.round(realY * SCALE) };
}

function baseLayout(textLabels) {
  return {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: textLabels,
    stickers: [],
    footer: null,
    logo: null,
  };
}

async function openEditor(page, templateId) {
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();
  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();
  return canvas;
}

async function readMultiTransformScene(page, textIds) {
  return page.evaluate((ids) => {
    const stage = window.Konva?.stages?.find(candidate => (
      ids.every(id => candidate.findOne(`#text-${id}`))
    ));
    const transformer = stage?.findOne("Transformer");
    if (!stage || !transformer || transformer.nodes().length !== ids.length) return null;

    const readAnchor = (name) => {
      const anchor = transformer.findOne(`.${name}`);
      if (!anchor?.visible()) return null;
      const position = anchor.getAbsolutePosition();
      return { x: position.x, y: position.y };
    };
    const nodes = ids.map((id) => {
      const node = stage.findOne(`#text-${id}`);
      return {
        id,
        x: node.x(),
        y: node.y(),
        width: node.width(),
        height: node.height(),
        scaleX: node.scaleX(),
        scaleY: node.scaleY(),
        rotation: node.rotation(),
        visualWidth: node.width() * Math.abs(node.scaleX()),
        visualHeight: node.height() * Math.abs(node.scaleY()),
      };
    });
    return {
      nodes,
      topLeft: readAnchor("top-left"),
      bottomRight: readAnchor("bottom-right"),
      rotater: readAnchor("rotater"),
    };
  }, textIds);
}

function expectCommittedSceneMatchesLive(liveScene, committedScene) {
  for (const liveNode of liveScene.nodes) {
    const committedNode = committedScene.nodes.find(node => node.id === liveNode.id);
    expect(committedNode).toBeTruthy();
    expect(Math.abs(committedNode.x - liveNode.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(committedNode.y - liveNode.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(committedNode.visualWidth - liveNode.visualWidth)).toBeLessThanOrEqual(SCALE);
    expect(Math.abs(committedNode.visualHeight - liveNode.visualHeight)).toBeLessThanOrEqual(SCALE);
    expect(committedNode.rotation).toBeCloseTo(liveNode.rotation, 0);
  }
}

test("multi-selection resize and rotate preserve live geometry through commit", async ({ page }) => {
  await loginViaApi(page);
  const firstText = {
    id: 1101,
    x: 80,
    y: 120,
    width: 100,
    height: 200,
    rotation: 0,
    text: "多選縮放 A",
    text_role: "static",
    font_size: 22,
    font_color: "#223344",
    text_align: "center",
    line_height: 1.4,
    z_index: 0,
  };
  const secondText = {
    id: 2202,
    x: 420,
    y: 500,
    width: 300,
    height: 60,
    rotation: 0,
    text: "多選縮放 B",
    text_role: "static",
    font_size: 22,
    font_color: "#445566",
    text_align: "center",
    line_height: 1.4,
    z_index: 1,
  };
  const textIds = [firstText.id, secondText.id];
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E multi transform ${Date.now()}`,
    baseLayout([firstText, secondText]),
  );
  const canvas = await openEditor(page, templateId);

  await canvas.click({ position: canvasPoint(
    firstText.x + firstText.width / 2,
    firstText.y + firstText.height / 2,
  ) });
  await page.keyboard.down("Shift");
  await canvas.click({ position: canvasPoint(
    secondText.x + secondText.width / 2,
    secondText.y + secondText.height / 2,
  ) });
  await page.keyboard.up("Shift");
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await expect.poll(async () => (await readMultiTransformScene(page, textIds))?.bottomRight)
    .not.toBeNull();

  const beforeResize = await readMultiTransformScene(page, textIds);
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Template canvas has no bounding box");
  const shrinkTarget = {
    x: beforeResize.topLeft.x + (beforeResize.bottomRight.x - beforeResize.topLeft.x) * 0.08,
    y: beforeResize.topLeft.y + (beforeResize.bottomRight.y - beforeResize.topLeft.y) * 0.08,
  };
  await page.mouse.move(
    canvasBox.x + beforeResize.bottomRight.x,
    canvasBox.y + beforeResize.bottomRight.y,
  );
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + shrinkTarget.x, canvasBox.y + shrinkTarget.y, { steps: 20 });
  await expect.poll(async () => {
    const scene = await readMultiTransformScene(page, textIds);
    return scene?.nodes.every(node => Math.abs(node.scaleX) < 0.9);
  }).toBeTruthy();
  const liveResize = await readMultiTransformScene(page, textIds);
  for (const node of liveResize.nodes) {
    expect(node.visualWidth / SCALE).toBeGreaterThanOrEqual(59.5);
    expect(node.visualHeight / SCALE).toBeGreaterThanOrEqual(39.5);
  }
  await page.mouse.up();

  await expect.poll(async () => {
    const scene = await readMultiTransformScene(page, textIds);
    return scene?.nodes.every(node => (
      Math.abs(node.scaleX - 1) < 0.001 && Math.abs(node.scaleY - 1) < 0.001
    ));
  }).toBeTruthy();
  const committedResize = await readMultiTransformScene(page, textIds);
  expectCommittedSceneMatchesLive(liveResize, committedResize);
  for (const node of committedResize.nodes) {
    expect(node.visualWidth / SCALE).toBeGreaterThanOrEqual(59.5);
    expect(node.visualHeight / SCALE).toBeGreaterThanOrEqual(39.5);
  }

  const selectionCenter = {
    x: (committedResize.topLeft.x + committedResize.bottomRight.x) / 2,
    y: (committedResize.topLeft.y + committedResize.bottomRight.y) / 2,
  };
  const rotateVector = {
    x: committedResize.rotater.x - selectionCenter.x,
    y: committedResize.rotater.y - selectionCenter.y,
  };
  const rotateRadians = Math.PI / 5;
  const rotateTarget = {
    x: selectionCenter.x
      + rotateVector.x * Math.cos(rotateRadians) - rotateVector.y * Math.sin(rotateRadians),
    y: selectionCenter.y
      + rotateVector.x * Math.sin(rotateRadians) + rotateVector.y * Math.cos(rotateRadians),
  };
  await page.mouse.move(
    canvasBox.x + committedResize.rotater.x,
    canvasBox.y + committedResize.rotater.y,
  );
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + rotateTarget.x, canvasBox.y + rotateTarget.y, { steps: 16 });
  await expect.poll(async () => {
    const scene = await readMultiTransformScene(page, textIds);
    return scene?.nodes.every(node => Math.abs(node.rotation) > 20);
  }).toBeTruthy();
  const liveRotate = await readMultiTransformScene(page, textIds);
  await page.mouse.up();

  await expect.poll(async () => {
    const scene = await readMultiTransformScene(page, textIds);
    return scene?.nodes.every(node => (
      Math.abs(node.scaleX - 1) < 0.001 && Math.abs(node.scaleY - 1) < 0.001
    ));
  }).toBeTruthy();
  const committedRotate = await readMultiTransformScene(page, textIds);
  expectCommittedSceneMatchesLive(liveRotate, committedRotate);
  await expect(page.getByRole("button", { name: "復原" })).toBeEnabled();

  await saveTemplateLayout(page);
  const savedLayout = await fetchTemplatePageLayout(page, templateId);
  for (const savedText of savedLayout.text_labels) {
    const committedNode = committedRotate.nodes.find(node => String(node.id) === String(savedText.id));
    expect(savedText.width).toBeGreaterThanOrEqual(60);
    expect(savedText.height).toBeGreaterThanOrEqual(40);
    expect(savedText.rotation).toBeCloseTo(committedNode.rotation, 0);
    expect(savedText.x + savedText.width / 2).toBeCloseTo(committedNode.x / SCALE, 0);
    expect(savedText.y + savedText.height / 2).toBeCloseTo(committedNode.y / SCALE, 0);
  }
});

test("multi-selection can enlarge legacy elements below the current minimum size", async ({ page }) => {
  await loginViaApi(page);
  const firstText = {
    id: 3303,
    x: 100,
    y: 140,
    width: 24,
    height: 18,
    rotation: 0,
    text: "小 A",
    text_role: "static",
    font_size: 12,
    font_color: "#223344",
    text_align: "center",
    line_height: 1,
    z_index: 0,
  };
  const secondText = {
    ...firstText,
    id: 4404,
    x: 420,
    y: 500,
    width: 30,
    height: 20,
    text: "小 B",
    z_index: 1,
  };
  const textIds = [firstText.id, secondText.id];
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E legacy small multi transform ${Date.now()}`,
    baseLayout([firstText, secondText]),
  );
  const canvas = await openEditor(page, templateId);

  await canvas.click({ position: canvasPoint(
    firstText.x + firstText.width / 2,
    firstText.y + firstText.height / 2,
  ) });
  await page.keyboard.down("Shift");
  await canvas.click({ position: canvasPoint(
    secondText.x + secondText.width / 2,
    secondText.y + secondText.height / 2,
  ) });
  await page.keyboard.up("Shift");
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await expect.poll(async () => (await readMultiTransformScene(page, textIds))?.bottomRight)
    .not.toBeNull();

  const before = await readMultiTransformScene(page, textIds);
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Template canvas has no bounding box");
  await page.mouse.move(
    canvasBox.x + before.bottomRight.x,
    canvasBox.y + before.bottomRight.y,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBox.x + before.bottomRight.x + 100,
    canvasBox.y + before.bottomRight.y + 100,
    { steps: 20 },
  );
  await expect.poll(async () => {
    const scene = await readMultiTransformScene(page, textIds);
    return scene?.nodes.every(node => Math.abs(node.scaleX) > 1.15);
  }).toBeTruthy();
  const live = await readMultiTransformScene(page, textIds);
  await page.mouse.up();

  await expect.poll(async () => {
    const scene = await readMultiTransformScene(page, textIds);
    return scene?.nodes.every(node => Math.abs(node.scaleX - 1) < 0.001);
  }).toBeTruthy();
  const committed = await readMultiTransformScene(page, textIds);
  expectCommittedSceneMatchesLive(live, committed);
  expect(committed.nodes[0].visualWidth / SCALE).toBeGreaterThan(firstText.width);
  expect(committed.nodes[0].visualHeight / SCALE).toBeGreaterThan(firstText.height);
  expect(committed.nodes[1].visualWidth / SCALE).toBeGreaterThan(secondText.width);
  expect(committed.nodes[1].visualHeight / SCALE).toBeGreaterThan(secondText.height);

  await saveTemplateLayout(page);
  const savedLayout = await fetchTemplatePageLayout(page, templateId);
  expect(savedLayout.text_labels[0].width).toBeGreaterThan(firstText.width);
  expect(savedLayout.text_labels[0].height).toBeGreaterThan(firstText.height);
  expect(savedLayout.text_labels[1].width).toBeGreaterThan(secondText.width);
  expect(savedLayout.text_labels[1].height).toBeGreaterThan(secondText.height);
});
