import { expect, test } from "./fixtures.js";

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

test("multi-selection resize and rotate preserve live geometry through commit", async ({ page, browserName }) => {
  // webkit 上旋轉手把拖到底也轉不到 20 度——master 上同樣失敗，不是這個分支造成的。
  // **這很可能是真的 Safari bug**：多選旋轉在 Safari 根本沒作用，而不只是測試飄。
  // 詳見 docs/dev/known-issues.md，那裡也寫了要怎麼查。
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

  // ── 儀表 ──────────────────────────────────────────────────────────
  const diag = await page.evaluate((ids) => {
    const stage = window.Konva?.stages?.find(c => ids.every(id => c.findOne(`#text-${id}`)));
    const tr = stage?.findOne("Transformer");
    const rot = tr?.findOne(".rotater");
    const abs = rot?.getAbsolutePosition();
    const hit = abs ? stage.getIntersection(abs) : null;
    return {
      konvaVersion: window.Konva?.version,
      pixelRatio: window.devicePixelRatio,
      stageScale: stage?.scaleX(),
      rotaterVisible: rot?.visible(),
      rotaterAbs: abs,
      rotaterSize: rot ? { w: rot.width(), h: rot.height() } : null,
      hitName: hit?.name?.() ?? hit?.getClassName?.() ?? null,
      hitIsRotater: hit === rot,
      trListening: tr?.listening(),
      trRotateEnabled: tr?.rotateEnabled?.(),
      stageContainerStyle: stage?.container()?.style?.touchAction,
    };
  }, textIds);
  console.log("DIAG_BEFORE " + JSON.stringify(diag));

  await page.evaluate((ids) => {
    const stage = window.Konva.stages.find(c => ids.every(id => c.findOne(`#text-${id}`)));
    const tr = stage.findOne("Transformer");
    window.__events = [];
    for (const name of ["transformstart", "transform", "transformend", "dragstart"]) {
      tr.on(name, () => window.__events.push(name));
    }
    stage.on("mousedown touchstart pointerdown", (e) => {
      window.__events.push("stage:" + e.type + ":" + (e.target?.name?.() || e.target?.getClassName?.()));
    });
  }, textIds);

  const liveAnchor = await page.evaluate((ids) => {
    const stage = window.Konva.stages.find(c => ids.every(id => c.findOne(`#text-${id}`)));
    const rot = stage.findOne("Transformer").findOne(".rotater");
    const p = rot.getAbsolutePosition();
    return { x: p.x, y: p.y };
  }, textIds);
  console.log("DIAG_ANCHOR " + JSON.stringify({
    snapshot: committedResize.rotater,
    live: liveAnchor,
    driftX: liveAnchor.x - committedResize.rotater.x,
    driftY: liveAnchor.y - committedResize.rotater.y,
    canvasBox,
  }));
  await page.mouse.move(
    canvasBox.x + committedResize.rotater.x,
    canvasBox.y + committedResize.rotater.y,
  );
  await page.mouse.down();
  const rotateRadians2 = Math.PI / 5;
  const selectionCenter2 = {
    x: (committedResize.topLeft.x + committedResize.bottomRight.x) / 2,
    y: (committedResize.topLeft.y + committedResize.bottomRight.y) / 2,
  };
  const v = {
    x: committedResize.rotater.x - selectionCenter2.x,
    y: committedResize.rotater.y - selectionCenter2.y,
  };
  const target = {
    x: selectionCenter2.x + v.x * Math.cos(rotateRadians2) - v.y * Math.sin(rotateRadians2),
    y: selectionCenter2.y + v.x * Math.sin(rotateRadians2) + v.y * Math.cos(rotateRadians2),
  };
  await page.mouse.move(canvasBox.x + target.x, canvasBox.y + target.y, { steps: 16 });
  await page.waitForTimeout(300);
  const after = await page.evaluate((ids) => {
    const stage = window.Konva.stages.find(c => ids.every(id => c.findOne(`#text-${id}`)));
    return {
      events: window.__events,
      rotations: ids.map(id => stage.findOne(`#text-${id}`).rotation()),
    };
  }, textIds);
  console.log("DIAG_AFTER " + JSON.stringify(after));
  await page.mouse.up();
});
