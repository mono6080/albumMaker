import { expect, test } from "@playwright/test";

import { getNodeBounds } from "../../src/utils/layoutGroups.js";
import {
  createTemplateWithLayout,
  dragWithSteps,
  fetchTemplatePageLayout,
  loginViaApi,
  redPng,
  saveTemplateLayout,
} from "./helpers.js";

const SCALE = 530 / 794;

function baseLayout(overrides = {}) {
  return {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: [],
    stickers: [],
    footer: null,
    logo: null,
    ...overrides,
  };
}

function canvasPoint(realX, realY) {
  return { x: Math.round(realX * SCALE), y: Math.round(realY * SCALE) };
}

function expectNear(actual, expected, tolerance = 0.5) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

function assertGroupGeometry(scene, bounds) {
  const expectedWidth = bounds.width * SCALE;
  const expectedHeight = bounds.height * SCALE;
  const expectedCenterX = bounds.centerX * SCALE;
  const expectedCenterY = bounds.centerY * SCALE;

  expect(scene.transformer.boundToControl).toBeTruthy();
  expectNear(scene.control.localRect.x, -expectedWidth / 2);
  expectNear(scene.control.localRect.y, -expectedHeight / 2);
  expectNear(scene.control.localRect.width, expectedWidth);
  expectNear(scene.control.localRect.height, expectedHeight);
  expectNear(scene.control.x, expectedCenterX);
  expectNear(scene.control.y, expectedCenterY);
  expectNear(scene.control.rotation, bounds.rotation, 0.05);
  expectNear(scene.control.scaleX, 1, 0.001);
  expectNear(scene.control.scaleY, 1, 0.001);

  expectNear(scene.visual.x, scene.control.x, 0.01);
  expectNear(scene.visual.y, scene.control.y, 0.01);
  expectNear(scene.visual.rotation, scene.control.rotation, 0.01);
  expectNear(scene.visual.scaleX, scene.control.scaleX, 0.001);
  expectNear(scene.visual.scaleY, scene.control.scaleY, 0.001);

  expectNear(scene.transformer.center.x, expectedCenterX);
  expectNear(scene.transformer.center.y, expectedCenterY);
  expectNear(scene.transformer.width, expectedWidth);
  expectNear(scene.transformer.height, expectedHeight);
  expectNear(scene.transformer.rotation, bounds.rotation, 0.05);
}

async function openEditor(page, templateId) {
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();
  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();
  return canvas;
}

async function dragCanvas(page, canvas, from, to, { additive = false } = {}) {
  const box = await canvas.boundingBox();
  const start = canvasPoint(from.x, from.y);
  const end = canvasPoint(to.x, to.y);
  if (additive) await page.keyboard.down("Shift");
  await page.mouse.move(box.x + start.x, box.y + start.y);
  await page.mouse.down();
  await page.mouse.move(box.x + end.x, box.y + end.y, { steps: 8 });
  await page.mouse.up();
  if (additive) await page.keyboard.up("Shift");
}

async function uploadMaterial(page, templateId, filename = "material.png") {
  const response = await page.request.post(`/api/templates/${templateId}/stickers`, {
    multipart: {
      file: { name: filename, mimeType: "image/png", buffer: redPng },
    },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test("nested isolation, Ctrl+G toggle and undo retain the deepest valid scope", async ({ page }) => {
  await loginViaApi(page);
  const sticker = {
    id: 101,
    path: "templates/tmpl0/stickers/missing.png",
    filename: "missing.png",
    x: 80,
    y: 140,
    width: 160,
    height: 100,
    rotation: 0,
    z_index: 0,
  };
  const text = {
    id: 202,
    x: 330,
    y: 150,
    width: 220,
    height: 80,
    rotation: 0,
    text: "巢狀群組文字",
    text_role: "static",
    font_size: 24,
    font_color: "#333333",
    text_align: "center",
    line_height: 1.4,
    z_index: 1,
  };
  const photo = {
    id: 303,
    x: 180,
    y: 350,
    width: 210,
    height: 120,
    rotation: 0,
    border: false,
    z_index: 2,
  };
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E nested groups ${Date.now()}`,
    baseLayout({ photo_slots: [photo], stickers: [sticker], text_labels: [text] }),
  );
  const canvas = await openEditor(page, templateId);

  await canvas.click({ position: canvasPoint(120, 180) });
  await page.keyboard.down("Shift");
  await canvas.click({ position: canvasPoint(390, 180) });
  await canvas.click({ position: canvasPoint(240, 390) });
  await page.keyboard.up("Shift");
  await expect(page.getByText("已選取 3 個物件")).toBeVisible();
  await page.keyboard.press("Control+g");
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible')).toContainText("群組 1");
  await canvas.click({ position: canvasPoint(120, 180) });
  await page.keyboard.down("Shift");
  await canvas.click({ position: canvasPoint(390, 180) });
  await page.keyboard.up("Shift");
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await page.keyboard.press("Control+g");
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible button')).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible button')).toHaveCount(2);

  await page.keyboard.press("Control+g");
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await page.getByRole("button", { name: "復原" }).click();
  await expect(page.getByRole("button", { name: "離開群組" })).toBeVisible();
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible')).toContainText("群組 1");
  await expect(page.getByRole("button", { name: /物件群組/ })).toBeVisible();

  await saveTemplateLayout(page);
  const layout = await fetchTemplatePageLayout(page, templateId);
  expect(layout.group_contract).toBe("nested-world-v2");
  expect(layout.groups).toHaveLength(2);
  expect(layout.groups.some(group => group.children.some(child => child.type === "group"))).toBeTruthy();
});

test("unselected photo drag synchronizes visual and control before mouseup", async ({ page }) => {
  const photo = {
    id: 711,
    x: 120,
    y: 180,
    width: 210,
    height: 280,
    rotation: 17,
    border: true,
    border_width: 18,
    z_index: 0,
  };
  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E photo live drag ${Date.now()}`,
    baseLayout({ photo_slots: [photo] }),
  );
  const canvas = await openEditor(page, templateId);

  const readPhotoPair = () => page.evaluate(({ photoId, inset, scale }) => {
    const stage = window.Konva?.stages?.find(candidate => (
      candidate.findOne(node => node.id() === `photo-${photoId}`)
    ));
    const control = stage?.findOne(node => node.id() === `photo-${photoId}`);
    const visual = stage?.findOne(node => node.id() === `photo-visual-${photoId}`);
    if (!control || !visual) return null;
    const controlContentOrigin = control.getAbsoluteTransform().point({ x: 0, y: 0 });
    const visualContentOrigin = visual.getAbsoluteTransform().point({
      x: inset * scale,
      y: inset * scale,
    });
    const nodeState = node => ({
      x: node.x(),
      y: node.y(),
      rotation: node.rotation(),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
    });
    return {
      control: nodeState(control),
      visual: nodeState(visual),
      controlContentOrigin,
      visualContentOrigin,
      transformerNodeCount: stage.findOne("Transformer")?.nodes().length ?? 0,
    };
  }, { photoId: photo.id, inset: photo.border_width, scale: SCALE });

  await expect.poll(readPhotoPair).not.toBeNull();
  const before = await readPhotoPair();
  expect(before.transformerNodeCount).toBe(0);

  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Template canvas has no bounding box");
  const start = canvasPoint(photo.x + photo.width / 2, photo.y + photo.height / 2);
  const end = canvasPoint(photo.x + photo.width / 2 + 90, photo.y + photo.height / 2 + 70);
  await page.mouse.move(canvasBox.x + start.x, canvasBox.y + start.y);
  await page.mouse.down();
  try {
    await page.mouse.move(canvasBox.x + end.x, canvasBox.y + end.y, { steps: 12 });
    await expect.poll(async () => {
      const scene = await readPhotoPair();
      return scene ? Math.hypot(
        scene.control.x - before.control.x,
        scene.control.y - before.control.y,
      ) : 0;
    }).toBeGreaterThan(25);

    const duringDrag = await readPhotoPair();
    expect(duringDrag.transformerNodeCount).toBe(0);
    expectNear(duringDrag.visual.x, duringDrag.control.x, 0.01);
    expectNear(duringDrag.visual.y, duringDrag.control.y, 0.01);
    expectNear(duringDrag.visual.rotation, duringDrag.control.rotation, 0.01);
    expectNear(duringDrag.visual.scaleX, duringDrag.control.scaleX, 0.001);
    expectNear(duringDrag.visual.scaleY, duringDrag.control.scaleY, 0.001);
    expectNear(duringDrag.visualContentOrigin.x, duringDrag.controlContentOrigin.x, 0.02);
    expectNear(duringDrag.visualContentOrigin.y, duringDrag.controlContentOrigin.y, 0.02);
  } finally {
    await page.mouse.up();
  }
});

test("45 degree group transformer matches bounds before and after resize commit", async ({ page }) => {
  const pivot = { x: 300, y: 350 };
  const rotation = 45;
  const radians = rotation * Math.PI / 180;
  const rotateFrame = (frame) => {
    const center = {
      x: frame.x + frame.width / 2,
      y: frame.y + frame.height / 2,
    };
    const dx = center.x - pivot.x;
    const dy = center.y - pivot.y;
    const rotatedCenter = {
      x: pivot.x + dx * Math.cos(radians) - dy * Math.sin(radians),
      y: pivot.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    };
    return {
      ...frame,
      x: rotatedCenter.x - frame.width / 2,
      y: rotatedCenter.y - frame.height / 2,
      rotation,
    };
  };
  const texts = [
    rotateFrame({ id: 721, x: 250, y: 250, width: 100, height: 50 }),
    rotateFrame({ id: 722, x: 250, y: 400, width: 100, height: 50 }),
  ].map((frame, index) => ({
    ...frame,
    text: `旋轉群組 ${index + 1}`,
    text_role: "static",
    font_size: 22,
    font_color: "#333333",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.4,
    z_index: index,
  }));
  const group = {
    id: 723,
    z_index: 0,
    selection_rotation: rotation,
    children: texts.map(text => ({ type: "text", id: text.id })),
  };
  const layout = baseLayout({
    group_contract: "nested-world-v2",
    text_labels: texts,
    groups: [group],
  });
  const initialBounds = getNodeBounds(layout, { type: "group", id: group.id });
  expectNear(initialBounds.width, 100, 0.01);
  expectNear(initialBounds.height, 200, 0.01);
  expectNear(initialBounds.centerX, pivot.x, 0.01);
  expectNear(initialBounds.centerY, pivot.y, 0.01);

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E rotated group geometry ${Date.now()}`,
    layout,
  );
  const canvas = await openEditor(page, templateId);
  await canvas.click({ position: canvasPoint(pivot.x, pivot.y) });
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();

  const readGroupGeometry = () => page.evaluate((groupId) => {
    const stage = window.Konva?.stages?.find(candidate => (
      candidate.findOne(node => node.id() === `group-${groupId}`)
    ));
    const control = stage?.findOne(node => node.id() === `group-${groupId}`);
    const visual = stage?.findOne(node => node.id() === `group-visual-${groupId}`);
    const transformer = stage?.findOne("Transformer");
    const anchorNames = ["top-left", "top-right", "bottom-right", "bottom-left"];
    const anchors = anchorNames.map(name => transformer?.findOne(`.${name}`));
    if (!control || !visual || !transformer || anchors.some(anchor => !anchor?.visible())) return null;
    const [topLeft, topRight, bottomRight, bottomLeft] = anchors.map(
      anchor => anchor.getAbsolutePosition(),
    );
    const center = {
      x: (topLeft.x + topRight.x + bottomRight.x + bottomLeft.x) / 4,
      y: (topLeft.y + topRight.y + bottomRight.y + bottomLeft.y) / 4,
    };
    const rawRotation = Math.atan2(
      topRight.y - topLeft.y,
      topRight.x - topLeft.x,
    ) * 180 / Math.PI;
    const normalizedRotation = ((rawRotation + 180) % 360 + 360) % 360 - 180;
    const nodeState = node => ({
      x: node.x(),
      y: node.y(),
      rotation: node.rotation(),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
    });
    return {
      control: {
        ...nodeState(control),
        localRect: control.getClientRect({
          skipTransform: true,
          skipShadow: true,
          skipStroke: true,
        }),
      },
      visual: nodeState(visual),
      transformer: {
        boundToControl: transformer.nodes().some(node => node === control),
        center,
        width: Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
        height: Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y),
        rotation: normalizedRotation,
        bottomRight,
      },
    };
  }, group.id);

  await expect.poll(readGroupGeometry).not.toBeNull();
  const beforeResize = await readGroupGeometry();
  assertGroupGeometry(beforeResize, initialBounds);

  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Template canvas has no bounding box");
  const { center, bottomRight } = beforeResize.transformer;
  const resizeFactor = 1.35;
  const target = {
    x: center.x + (bottomRight.x - center.x) * resizeFactor,
    y: center.y + (bottomRight.y - center.y) * resizeFactor,
  };
  await page.mouse.move(canvasBox.x + bottomRight.x, canvasBox.y + bottomRight.y);
  await page.mouse.down();
  // WebKit 會合併沒有 frame 間隔的 mousemove；逐步送出才能穩定驅動 Konva Transformer。
  for (let step = 1; step <= 12; step += 1) {
    const progress = step / 12;
    await page.mouse.move(
      canvasBox.x + bottomRight.x + (target.x - bottomRight.x) * progress,
      canvasBox.y + bottomRight.y + (target.y - bottomRight.y) * progress,
    );
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  await expect.poll(async () => (await readGroupGeometry())?.transformer.width ?? 0)
    .toBeGreaterThan(beforeResize.transformer.width * 1.15);
  await saveTemplateLayout(page);
  const savedLayout = await fetchTemplatePageLayout(page, templateId);
  const committedBounds = getNodeBounds(savedLayout, { type: "group", id: group.id });
  expect(committedBounds.width).toBeGreaterThan(initialBounds.width * 1.15);
  expectNear(committedBounds.rotation, rotation, 0.01);

  await expect.poll(readGroupGeometry).not.toBeNull();
  const afterResize = await readGroupGeometry();
  assertGroupGeometry(afterResize, committedBounds);
});

test("group corner resize preserves typography through transient commit undo and reload", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(
    page,
    `E2E group transformer typography ${Date.now()}`,
    baseLayout(),
  );
  const uploaded = await uploadMaterial(page, templateId, "transformer.png");
  const sticker = {
    id: 111,
    path: uploaded.path,
    filename: uploaded.filename,
    asset_revision: uploaded.asset_revision,
    x: 120,
    y: 170,
    width: 210,
    height: 140,
    rotation: 0,
    z_index: 0,
  };
  const text = {
    id: 222,
    x: 390,
    y: 330,
    width: 230,
    height: 110,
    rotation: 0,
    text: "四角縮放保留完整文字",
    text_role: "static",
    font_size: 33,
    font_color: "#123456",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.7,
    letter_spacing: 4,
    z_index: 1,
  };
  const group = {
    id: 333,
    z_index: 0,
    selection_rotation: 0,
    children: [{ type: "sticker", id: sticker.id }, { type: "text", id: text.id }],
  };
  const putResponse = await page.request.put(`/api/templates/${templateId}/pages/${pageId}/layout`, {
    data: baseLayout({
      group_contract: "nested-world-v2",
      stickers: [sticker],
      text_labels: [text],
      groups: [group],
    }),
  });
  expect(putResponse.ok()).toBeTruthy();

  const canvas = await openEditor(page, templateId);
  await canvas.click({ position: canvasPoint(200, 220) });
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();

  const readTransformerScene = () => page.evaluate(({ groupId, textId }) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#group-${groupId}`));
    const groupNode = stage?.findOne(`#group-${groupId}`);
    const textNode = stage?.findOne(`#text-${textId}`)?.findOne(".typography-content");
    const transformer = stage?.findOne("Transformer");
    const anchor = transformer?.findOne(".bottom-right");
    if (!groupNode || !textNode || !anchor?.visible()) return null;
    const anchorPosition = anchor.getAbsolutePosition();
    return {
      group: {
        scaleX: groupNode.scaleX(),
        scaleY: groupNode.scaleY(),
        width: groupNode.width(),
        height: groupNode.height(),
      },
      text: {
        fontSize: textNode.fontSize(),
        lineHeight: textNode.lineHeight(),
        letterSpacing: textNode.letterSpacing(),
        content: textNode.text(),
      },
      anchor: { x: anchorPosition.x, y: anchorPosition.y },
    };
  }, { groupId: group.id, textId: text.id });

  await expect.poll(async () => (await readTransformerScene())?.anchor ?? null).not.toBeNull();
  const before = await readTransformerScene();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("Template canvas has no bounding box");
  const dragX = 65;
  const dragY = dragX * before.group.height / before.group.width;
  await page.mouse.move(canvasBox.x + before.anchor.x, canvasBox.y + before.anchor.y);
  await page.mouse.down();
  await page.mouse.move(
    canvasBox.x + before.anchor.x + dragX,
    canvasBox.y + before.anchor.y + dragY,
    { steps: 12 },
  );
  await expect.poll(async () => (await readTransformerScene())?.group.scaleX ?? 1).toBeGreaterThan(1.2);
  const transient = await readTransformerScene();
  const transientScale = (transient.group.scaleX + transient.group.scaleY) / 2;
  expect(transient.group.scaleX).toBeCloseTo(transient.group.scaleY, 4);
  expect(transient.text.fontSize * transientScale).toBeCloseTo(before.text.fontSize, 1);
  expect(transient.text.letterSpacing * transientScale).toBeCloseTo(before.text.letterSpacing, 1);
  expect(transient.text.lineHeight).toBe(before.text.lineHeight);
  expect(transient.text.content).toBe(before.text.content);
  await page.mouse.up();

  await expect.poll(async () => (await readTransformerScene())?.group.scaleX ?? 0).toBeCloseTo(1, 4);
  await expect(page.getByRole("button", { name: "復原" })).toBeEnabled();
  await saveTemplateLayout(page);

  const scaledLayout = await fetchTemplatePageLayout(page, templateId);
  expect(scaledLayout.groups).toHaveLength(1);
  expect(scaledLayout.groups[0].children).toEqual(group.children);
  const scaledSticker = scaledLayout.stickers[0];
  const scaledText = scaledLayout.text_labels[0];
  const scale = scaledSticker.width / sticker.width;
  expect(scale).toBeGreaterThan(1.2);
  expect(scaledSticker.height / sticker.height).toBeCloseTo(scale, 3);
  expect(scaledText.width / text.width).toBeCloseTo(scale, 3);
  expect(scaledText.height / text.height).toBeCloseTo(scale, 3);
  expect((scaledText.x + scaledText.width / 2) - (scaledSticker.x + scaledSticker.width / 2))
    .toBeCloseTo(((text.x + text.width / 2) - (sticker.x + sticker.width / 2)) * scale, 2);
  expect((scaledText.y + scaledText.height / 2) - (scaledSticker.y + scaledSticker.height / 2))
    .toBeCloseTo(((text.y + text.height / 2) - (sticker.y + sticker.height / 2)) * scale, 2);
  expect(scaledSticker).toMatchObject({
    path: sticker.path,
    filename: sticker.filename,
    asset_revision: sticker.asset_revision,
  });
  expect(scaledText).toMatchObject({
    text: text.text,
    font_size: text.font_size,
    line_height: text.line_height,
    letter_spacing: text.letter_spacing,
  });

  await page.getByRole("button", { name: "進入群組" }).click();
  await canvas.click({
    position: canvasPoint(
      scaledText.x + scaledText.width / 2,
      scaledText.y + scaledText.height / 2,
    ),
  });
  await expect(page.getByText("純文字屬性")).toBeVisible();
  const positionInputs = page.locator('[data-guide="property-position-size"] input[type="number"]');
  const fontSizeInput = page.getByRole("spinbutton", { name: "字級數值", exact: true });
  const lineHeightInput = page.getByRole("spinbutton", { name: "行距數值", exact: true });
  const letterSpacingInput = page.getByRole("spinbutton", { name: "字間距數值", exact: true });
  const expectTypography = async () => {
    await expect(page.locator("textarea").first()).toHaveValue(text.text);
    await expect(fontSizeInput).toHaveValue(String(text.font_size));
    await expect(lineHeightInput).toHaveValue(String(text.line_height));
    await expect(letterSpacingInput).toHaveValue(String(text.letter_spacing));
  };
  await expectTypography();

  await page.getByRole("button", { name: "復原" }).click();
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible')).toContainText("群組 1");
  await expect(positionInputs.nth(0)).toHaveValue(String(text.x));
  await expect(positionInputs.nth(1)).toHaveValue(String(text.y));
  await expect(positionInputs.nth(2)).toHaveValue(String(text.width));
  await expect(positionInputs.nth(3)).toHaveValue(String(text.height));
  await expectTypography();

  await page.getByRole("button", { name: "重做" }).click();
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible')).toContainText("群組 1");
  await expect(positionInputs.nth(2)).toHaveValue(String(scaledText.width));
  await expect(positionInputs.nth(3)).toHaveValue(String(scaledText.height));
  await expectTypography();
  await saveTemplateLayout(page);

  await page.reload();
  await expect(page.getByText("模板編輯器")).toBeVisible();
  await expect(canvas).toBeVisible();
  const reloadedLayout = await fetchTemplatePageLayout(page, templateId);
  expect(reloadedLayout.groups).toEqual(scaledLayout.groups);
  expect(reloadedLayout.stickers[0]).toMatchObject(scaledSticker);
  expect(reloadedLayout.text_labels[0]).toMatchObject(scaledText);
  await canvas.click({
    position: canvasPoint(
      scaledSticker.x + scaledSticker.width / 2,
      scaledSticker.y + scaledSticker.height / 2,
    ),
  });
  await page.getByRole("button", { name: "進入群組" }).click();
  await canvas.click({
    position: canvasPoint(
      scaledText.x + scaledText.width / 2,
      scaledText.y + scaledText.height / 2,
    ),
  });
  await expect(page.getByText("純文字屬性")).toBeVisible();
  await expectTypography();
});

test("marquee selects every supported direct node type and a group without creating history", async ({ page }) => {
  await loginViaApi(page);
  const layout = baseLayout({
    photo_slots: [
      {
        id: 11,
        x: 90,
        y: 100,
        width: 140,
        height: 110,
        rotation: 12,
        border: false,
        z_index: 0,
      },
      {
        id: 22,
        x: 320,
        y: 110,
        width: 150,
        height: 90,
        rotation: 0,
        border: false,
        z_index: 1,
      },
    ],
    text_labels: [{
      id: 33,
      x: 90,
      y: 400,
      width: 160,
      height: 70,
      rotation: -8,
      text: "框選文字",
      text_role: "static",
      font_size: 22,
      font_color: "#333333",
      text_align: "center",
      line_height: 1.4,
      z_index: 2,
    }],
    stickers: [{
      id: 44,
      path: "templates/tmpl0/stickers/missing.png",
      filename: "missing.png",
      x: 340,
      y: 390,
      width: 150,
      height: 100,
      rotation: 7,
      z_index: 3,
    }],
  });
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E marquee ${Date.now()}`,
    layout,
  );
  const canvas = await openEditor(page, templateId);
  const undoButton = page.getByRole("button", { name: "復原" });
  await expect(undoButton).toBeDisabled();

  await dragCanvas(page, canvas, { x: 45, y: 60 }, { x: 510, y: 260 });
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await expect(undoButton).toBeDisabled();

  await dragCanvas(page, canvas, { x: 45, y: 350 }, { x: 540, y: 540 }, { additive: true });
  await expect(page.getByText("已選取 4 個物件")).toBeVisible();
  await expect(undoButton).toBeDisabled();

  await page.keyboard.press("Control+g");
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "圖層清單" })).toBeVisible();
  await dragCanvas(page, canvas, { x: 45, y: 70 }, { x: 105, y: 135 });
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();
});

test("layer metadata, ordering and multi-selection tools persist for direct leaves", async ({ page }) => {
  await loginViaApi(page);
  const textItems = [
    {
      id: 901,
      x: 100,
      y: 140,
      width: 180,
      height: 70,
      rotation: 0,
      text: "第一個文字",
      text_role: "static",
      font_family: "msjh",
      font_size: 24,
      font_color: "#333333",
      text_align: "center",
      line_height: 1.4,
      z_index: 0,
    },
    {
      id: 902,
      x: 350,
      y: 330,
      width: 230,
      height: 90,
      rotation: 0,
      text: "第二個文字",
      text_role: "static",
      font_family: "kaiu",
      font_size: 30,
      font_color: "#555555",
      text_align: "left",
      line_height: 1.4,
      z_index: 1,
    },
    {
      id: 903,
      x: 180,
      y: 540,
      width: 160,
      height: 60,
      rotation: 0,
      text: "第三個文字",
      text_role: "static",
      font_family: "msjh",
      font_size: 22,
      font_color: "#777777",
      text_align: "right",
      line_height: 1.4,
      z_index: 2,
    },
  ];
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E layer management ${Date.now()}`,
    baseLayout({ text_labels: textItems }),
  );
  await openEditor(page, templateId);
  await page.getByRole("tab", { name: "圖層", exact: true }).click();

  const layerRow = id => page.locator(`[data-layer-ref="text:${id}"]`);
  const selectLayer = id => layerRow(id).locator(":scope > button:not([aria-label])");
  const canvasHasTextNode = id => page.evaluate(textId => (
    window.Konva?.stages?.some(stage => Boolean(stage.findOne(`#text-${textId}`))) ?? false
  ), id);
  const textById = (layout, id) => layout.text_labels.find(item => String(item.id) === String(id));
  const rootOrder = layout => [...layout.text_labels]
    .sort((left, right) => left.z_index - right.z_index)
    .map(item => item.id);

  const firstRow = layerRow(901);
  await firstRow.getByRole("button", { name: "重新命名圖層", exact: true }).click();
  const renameInput = firstRow.getByRole("textbox", { name: /重新命名/ });
  await renameInput.fill("主標題圖層");
  await renameInput.press("Enter");
  await expect(firstRow).toContainText("主標題圖層");

  await firstRow.getByRole("button", { name: "隱藏圖層", exact: true }).click();
  await saveTemplateLayout(page);
  let saved = await fetchTemplatePageLayout(page, templateId);
  expect(textById(saved, 901)).toMatchObject({
    layer_name: "主標題圖層",
    visible: false,
  });
  await expect.poll(() => canvasHasTextNode(901)).toBe(false);

  await firstRow.getByRole("button", { name: "顯示圖層", exact: true }).click();
  await expect.poll(() => canvasHasTextNode(901)).toBe(true);
  await selectLayer(901).click();
  const xBeforeLockedMove = textById(saved, 901).x;
  await firstRow.getByRole("button", { name: "鎖定圖層", exact: true }).click();
  await page.locator("body").press("ArrowRight");
  await saveTemplateLayout(page);
  saved = await fetchTemplatePageLayout(page, templateId);
  expect(textById(saved, 901)).toMatchObject({
    visible: true,
    locked: true,
    x: xBeforeLockedMove,
  });

  await firstRow.getByRole("button", { name: "解除鎖定圖層", exact: true }).click();
  const sourceHandle = firstRow.getByRole("button", { name: "拖曳重新排序圖層", exact: true });
  await dragWithSteps(page, sourceHandle, layerRow(903));
  await saveTemplateLayout(page);
  saved = await fetchTemplatePageLayout(page, templateId);
  expect(textById(saved, 901).locked).toBe(false);
  expect(rootOrder(saved)).toEqual([902, 903, 901]);

  await selectLayer(901).click();
  await page.keyboard.down("Shift");
  await selectLayer(902).click();
  await page.keyboard.up("Shift");
  await page.getByRole("tab", { name: "屬性", exact: true }).click();
  const multiSelectionPanel = page.locator('[data-guide="group-selection-panel"]');
  await expect(multiSelectionPanel).toContainText("已選取 2 個物件");
  await multiSelectionPanel.getByRole("button", { name: "靠左", exact: true }).click();
  await multiSelectionPanel.getByLabel("字級（pt）", { exact: true }).fill("42");
  await saveTemplateLayout(page);

  saved = await fetchTemplatePageLayout(page, templateId);
  const firstSavedText = textById(saved, 901);
  const secondSavedText = textById(saved, 902);
  expect(firstSavedText.x).toBe(100);
  expect(secondSavedText.x).toBe(firstSavedText.x);
  expect(firstSavedText.font_size).toBe(42);
  expect(secondSavedText.font_size).toBe(42);
  expect(firstSavedText).toMatchObject({
    layer_name: "主標題圖層",
    visible: true,
    locked: false,
  });
  expect(rootOrder(saved)).toEqual([902, 903, 901]);
});

test("sticker analysis creates and linked text resets without changing topology or typography", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(
    page,
    `E2E material create reset ${Date.now()}`,
    baseLayout(),
  );
  const uploaded = await uploadMaterial(page, templateId);
  const originalSticker = {
    id: 301,
    path: uploaded.path,
    filename: uploaded.filename,
    asset_revision: uploaded.asset_revision,
    x: 140,
    y: 220,
    width: 300,
    height: 140,
    rotation: 12,
    z_index: 0,
  };
  const photo = {
    id: 302,
    x: 500,
    y: 520,
    width: 160,
    height: 90,
    rotation: 0,
    border: false,
    z_index: 1,
  };
  const initialLayout = baseLayout({
    group_contract: "nested-world-v2",
    photo_slots: [photo],
    stickers: [originalSticker],
    groups: [{
      id: 401,
      z_index: 0,
      selection_rotation: 37,
      children: [{ type: "sticker", id: originalSticker.id }, { type: "photo", id: photo.id }],
    }],
  });
  const putResponse = await page.request.put(`/api/templates/${templateId}/pages/${pageId}/layout`, {
    data: initialLayout,
  });
  expect(putResponse.ok()).toBeTruthy();

  const canvas = await openEditor(page, templateId);
  await canvas.click({ position: canvasPoint(210, 270) });
  await page.getByRole("button", { name: "進入群組" }).click();
  await canvas.click({ position: canvasPoint(210, 270) });
  await page.getByRole("button", { name: "分析圖片並建立文字框" }).click();
  await expect(page.getByText("已建立文字框")).toBeVisible();
  await saveTemplateLayout(page);

  let saved = await fetchTemplatePageLayout(page, templateId);
  expect(saved.groups).toHaveLength(1);
  expect(saved.groups[0]).toMatchObject({ id: 401, selection_rotation: 37 });
  expect(saved.groups[0]).not.toHaveProperty("links");
  expect(saved.groups[0].children.map(child => child.type)).toEqual(["sticker", "text", "photo"]);
  expect(saved.material_text_links).toHaveLength(1);
  expect(saved.stickers[0]).toMatchObject(originalSticker);
  const link = saved.material_text_links[0];
  const createdText = { ...saved.text_labels.find(item => String(item.id) === String(link.text_id)) };
  const groupsAfterCreate = JSON.parse(JSON.stringify(saved.groups));

  await page.locator("textarea").first().fill("保留這段文字");
  const fontSizeNumber = page.getByRole("spinbutton", { name: "字級數值", exact: true });
  await fontSizeNumber.fill("36");
  await page.locator('[data-guide="property-panel"]')
    .getByRole("button", { name: "位置與尺寸" })
    .click();
  const positionInputs = page.locator('[data-guide="property-position-size"] input[type="number"]');
  await positionInputs.nth(0).fill(String(createdText.x + 40));
  await page.getByRole("button", { name: "重新分析並重設文字框" }).click();
  await expect(page.getByText("已重設文字框")).toBeVisible();
  await saveTemplateLayout(page);

  saved = await fetchTemplatePageLayout(page, templateId);
  const resetText = saved.text_labels.find(item => String(item.id) === String(link.text_id));
  expect(resetText.text).toBe("保留這段文字");
  expect(resetText.font_size).toBe(36);
  for (const field of ["x", "y", "width", "height", "rotation"]) {
    expect(resetText[field]).toBe(createdText[field]);
  }
  expect(saved.stickers[0]).toMatchObject(originalSticker);
  expect(saved.groups).toEqual(groupsAfterCreate);
  expect(saved.groups[0].children.map(child => child.type)).toEqual(["sticker", "text", "photo"]);
  expect(saved.material_text_links).toEqual([link]);
});

test("pending root sticker analysis is discarded on page change without groups or media mutation", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId: firstPageId } = await createTemplateWithLayout(
    page,
    `E2E stale material analysis ${Date.now()}`,
    baseLayout(),
  );
  const uploaded = await uploadMaterial(page, templateId, "shared.png");
  const sharedSticker = {
    id: 451,
    path: uploaded.path,
    filename: uploaded.filename,
    asset_revision: uploaded.asset_revision,
    x: 140,
    y: 220,
    width: 300,
    height: 140,
    rotation: 0,
    z_index: 0,
  };
  const initialLayout = baseLayout({
    group_contract: "nested-world-v2",
    stickers: [sharedSticker],
    groups: [],
  });
  const firstLayoutResponse = await page.request.put(
    `/api/templates/${templateId}/pages/${firstPageId}/layout`,
    { data: initialLayout },
  );
  expect(firstLayoutResponse.ok()).toBeTruthy();

  const secondPageResponse = await page.request.post(`/api/templates/${templateId}/pages`);
  expect(secondPageResponse.ok()).toBeTruthy();
  const secondPage = await secondPageResponse.json();
  const secondLayoutResponse = await page.request.put(
    `/api/templates/${templateId}/pages/${secondPage.id}/layout`,
    { data: initialLayout },
  );
  expect(secondLayoutResponse.ok()).toBeTruthy();

  let markIntercepted;
  let releaseResponse;
  const intercepted = new Promise(resolve => { markIntercepted = resolve; });
  const release = new Promise(resolve => { releaseResponse = resolve; });
  await page.route("**/material-text-box-suggestion", async (route) => {
    const response = await route.fetch();
    markIntercepted();
    await release;
    try {
      await route.fulfill({ response });
    } catch {
      // Switching pages aborts the pending browser request; this is the expected path.
    }
  });

  const canvas = await openEditor(page, templateId);
  const undoButton = page.getByRole("button", { name: "復原" });
  await canvas.click({ position: canvasPoint(200, 260) });
  await expect(page.getByText("貼圖素材屬性")).toBeVisible();
  await page.getByRole("button", { name: "分析圖片並建立文字框" }).click();
  await intercepted;

  await page.getByRole("button", { name: "第 2 頁", exact: true }).click();
  releaseResponse();
  await expect(page.getByRole("button", { name: "第 2 頁", exact: true })).toHaveClass(/bg-indigo-600/);
  await canvas.click({ position: canvasPoint(200, 260) });
  await expect(page.getByText("貼圖素材屬性")).toBeVisible();
  await expect(page.getByRole("button", { name: "分析圖片並建立文字框" })).toBeEnabled();
  await expect(undoButton).toBeDisabled();
  await expect(page.getByText("已建立文字框")).toHaveCount(0);

  await page.getByRole("button", { name: "第 1 頁", exact: true }).click();
  await expect(page.getByRole("button", { name: "第 1 頁", exact: true })).toHaveClass(/bg-indigo-600/);
  await canvas.click({ position: canvasPoint(200, 260) });
  await expect(page.getByText("貼圖素材屬性")).toBeVisible();
  await expect(page.getByRole("button", { name: "分析圖片並建立文字框" })).toBeEnabled();
  await expect(undoButton).toBeDisabled();

  const detailResponse = await page.request.get(`/api/templates/${templateId}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = await detailResponse.json();
  for (const templatePage of detail.pages) {
    expect(templatePage.layout.groups ?? []).toEqual([]);
    expect(templatePage.layout.material_text_links ?? []).toEqual([]);
    expect(templatePage.layout.text_labels ?? []).toEqual([]);
    expect(templatePage.layout.stickers).toEqual([sharedSticker]);
  }
});

test("exact sticker and text shortcut links and fits without grouping or reordering", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(
    page,
    `E2E material pair ${Date.now()}`,
    baseLayout(),
  );
  const uploaded = await uploadMaterial(page, templateId, "pair.png");
  const sticker = {
    id: 501,
    path: uploaded.path,
    filename: uploaded.filename,
    asset_revision: uploaded.asset_revision,
    x: 120,
    y: 190,
    width: 300,
    height: 150,
    rotation: 0,
    z_index: 0,
  };
  const text = {
    id: 502,
    x: 480,
    y: 210,
    width: 190,
    height: 70,
    rotation: 0,
    text: "既有文字",
    text_role: "static",
    font_size: 26,
    font_color: "#123456",
    text_align: "center",
    line_height: 1.4,
    z_index: 1,
  };
  const photo = {
    id: 503,
    x: 300,
    y: 500,
    width: 180,
    height: 100,
    rotation: 0,
    border: false,
    z_index: 2,
  };
  const group = {
    id: 601,
    z_index: 0,
    selection_rotation: 0,
    children: [
      { type: "sticker", id: sticker.id },
      { type: "text", id: text.id },
      { type: "photo", id: photo.id },
    ],
  };
  const response = await page.request.put(`/api/templates/${templateId}/pages/${pageId}/layout`, {
    data: baseLayout({
      group_contract: "nested-world-v2",
      photo_slots: [photo],
      stickers: [sticker],
      text_labels: [text],
      groups: [group],
    }),
  });
  expect(response.ok()).toBeTruthy();

  const canvas = await openEditor(page, templateId);
  await canvas.click({ position: canvasPoint(180, 240) });
  await page.getByRole("button", { name: "進入群組" }).click();
  await canvas.click({ position: canvasPoint(180, 240) });
  await page.keyboard.down("Shift");
  await canvas.click({ position: canvasPoint(530, 240) });
  await page.keyboard.up("Shift");
  await expect(page.locator('[data-guide="group-selection-panel"]')
    .getByRole("button", { name: "建立群組", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "符合素材並連結文字框" }).click();
  await expect(page.getByText("已重設文字框")).toBeVisible();
  await saveTemplateLayout(page);

  const saved = await fetchTemplatePageLayout(page, templateId);
  expect(saved.groups).toHaveLength(1);
  expect(saved.groups[0].children).toEqual(group.children);
  expect(saved.material_text_links).toEqual([{
    kind: "material-text-v1",
    material_id: sticker.id,
    text_id: text.id,
  }]);
  expect(saved.stickers[0]).toMatchObject(sticker);
  const fittedText = saved.text_labels[0];
  expect(fittedText.text).toBe(text.text);
  expect(fittedText.font_size).toBe(text.font_size);
  expect(fittedText.font_color).toBe(text.font_color);
});

test("invalid layout-level material links show one-click repair", async ({ page }) => {
  await loginViaApi(page);
  const sticker = {
    id: 701,
    path: "templates/tmpl0/stickers/missing.png",
    filename: "missing.png",
    x: 120,
    y: 160,
    width: 180,
    height: 100,
    rotation: 0,
    z_index: 0,
  };
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E invalid material link ${Date.now()}`,
    baseLayout({ stickers: [sticker] }),
  );
  const templateRoute = `**/api/templates/${templateId}`;
  await page.route(templateRoute, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const detail = await response.json();
    detail.pages[0].layout = {
      ...detail.pages[0].layout,
      group_contract: "nested-world-v2",
      material_text_links: [{
        kind: "material-text-v1",
        material_id: 701,
        text_id: 999999,
      }],
    };
    await route.fulfill({ response, json: detail });
  });
  await openEditor(page, templateId);
  await expect(page.getByRole("button", { name: "清除失效素材連結" })).toBeVisible();
  await expect(page.getByRole("button", { name: "儲存" })).toBeDisabled();
  await page.getByRole("button", { name: "清除失效素材連結" }).click();
  await expect(page.getByRole("button", { name: "清除失效素材連結" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "復原" })).toBeEnabled();
  await page.unroute(templateRoute);
  await saveTemplateLayout(page);
  const saved = await fetchTemplatePageLayout(page, templateId);
  expect(saved).not.toHaveProperty("material_text_links");
});
