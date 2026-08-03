// 手機版模板編輯器 e2e：工作區、明確命令、camera view state 與斷點契約
import { expect, test } from "./fixtures.js";

import {
  createTemplateWithLayout,
  fetchTemplateDetail,
  fetchTemplatePageLayout,
  loginViaApi,
  saveTemplateLayout,
} from "./helpers.js";

const PHONE_CONTEXT = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

const FIRST_TEXT_ID = 8101;
const SECOND_TEXT_ID = 8102;
const LOWER_TEXT_ID = 8103;

function createMobileLayout({ includeSecondText = false } = {}) {
  const firstText = {
    id: FIRST_TEXT_ID,
    x: 100,
    y: 120,
    width: 240,
    height: 90,
    rotation: 0,
    text: "手機文字 A",
    text_role: "static",
    font_size: 28,
    font_color: "#333333",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.4,
    z_index: 0,
  };
  const secondText = {
    ...firstText,
    id: SECOND_TEXT_ID,
    x: 450,
    y: 470,
    text: "手機文字 B",
    z_index: 1,
  };
  return {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: includeSecondText ? [firstText, secondText] : [firstText],
    stickers: [],
    footer: null,
    logo: null,
  };
}

function createLowerCanvasLayout() {
  const layout = createMobileLayout();
  layout.text_labels = [{
    ...layout.text_labels[0],
    id: LOWER_TEXT_ID,
    x: 280,
    y: 1000,
    width: 220,
    height: 80,
    text: "畫布下方文字",
  }];
  return layout;
}

async function createAndOpenEditor(page, layout, nameSuffix) {
  await loginViaApi(page);
  const created = await createTemplateWithLayout(
    page,
    `E2E mobile editor ${nameSuffix} ${Date.now()}`,
    layout,
  );
  await page.goto(`/templates/${created.templateId}/edit`);
  await expect(page.locator('[data-guide="canvas-frame"]')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (window.Konva?.stages?.length ?? 0) > 0))
    .toBeTruthy();
  return created;
}

async function createAndOpenEmptyEditor(page, nameSuffix) {
  await loginViaApi(page);
  const response = await page.request.post("/api/templates/", {
    form: { name: `E2E empty mobile ${nameSuffix} ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const template = await response.json();
  await page.goto(`/templates/${template.id}/edit`);
  await expect(page.locator('[data-guide="mobile-editor-topbar"]')).toBeVisible();
  return template.id;
}

async function expectNoHorizontalOverflow(page) {
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 2);
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 2);
}

async function readSelectedNodeIds(page) {
  return page.evaluate(() => {
    for (const stage of window.Konva?.stages ?? []) {
      const transformer = stage.findOne("Transformer");
      const selectedNodes = transformer?.nodes?.() ?? [];
      if (selectedNodes.length > 0) return selectedNodes.map(node => node.id());
    }
    return [];
  });
}

async function readNodeScene(page, nodeId) {
  return page.evaluate((expectedNodeId) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#${expectedNodeId}`));
    const node = stage?.findOne(`#${expectedNodeId}`);
    if (!stage || !node) return null;
    return {
      x: node.x(),
      y: node.y(),
      width: node.width() * Math.abs(node.scaleX()),
      height: node.height() * Math.abs(node.scaleY()),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
    };
  }, nodeId);
}

async function readNodeScreenPoint(page, nodeId) {
  // 斷點切換時 Stage 尺寸與 camera 由兩次 React layout effect 更新；等整組幾何
  // 連續三個 animation frame 不變，避免第一個 touch 還落在舊 camera 座標。
  await expect.poll(() => page.evaluate(async (expectedNodeId) => {
    const readSignature = () => {
      const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#${expectedNodeId}`));
      const camera = stage?.findOne("#page-camera");
      const viewport = stage?.container().closest('[data-guide="editor-canvas-viewport"]');
      if (!stage || !camera || !viewport) return null;
      return [
        stage.width(), stage.height(),
        viewport.clientWidth, viewport.clientHeight,
        camera.x(), camera.y(), camera.scaleX(), camera.scaleY(),
      ];
    };
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const signatures = [readSignature()];
    await nextFrame();
    signatures.push(readSignature());
    await nextFrame();
    signatures.push(readSignature());
    if (signatures.some(signature => signature == null)) return false;
    const [first, second, third] = signatures;
    const isSame = (left, right) => left.every((value, index) => (
      Math.abs(value - right[index]) <= 0.01
    ));
    const stageMatchesViewport = Math.abs(third[0] - third[2]) <= 1
      && Math.abs(third[1] - third[3]) <= 1;
    return stageMatchesViewport && isSame(first, second) && isSame(second, third);
  }, nodeId)).toBeTruthy();

  return page.evaluate((expectedNodeId) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#${expectedNodeId}`));
    const node = stage?.findOne(`#${expectedNodeId}`);
    if (!stage || !node) return null;
    // 點物件可視 bounds 中心；左上邊界在 WebKit 的縮放小數像素下可能落在 hit area 外。
    const bounds = node.getClientRect({ relativeTo: stage });
    const position = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const stageRect = stage.container().getBoundingClientRect();
    return {
      x: stageRect.left + position.x * stageRect.width / stage.width(),
      y: stageRect.top + position.y * stageRect.height / stage.height(),
    };
  }, nodeId);
}

async function readTransformerAnchorScreenPoint(page, anchorName) {
  return page.evaluate((expectedAnchorName) => {
    const stage = window.Konva?.stages?.find(candidate => (
      (candidate.findOne("Transformer")?.nodes?.().length ?? 0) > 0
    ));
    const transformer = stage?.findOne("Transformer");
    const anchor = transformer?.findOne(`.${expectedAnchorName}`);
    if (!stage || !anchor) return null;
    const position = anchor.getAbsolutePosition();
    const stageRect = stage.container().getBoundingClientRect();
    return {
      x: stageRect.left + position.x * stageRect.width / stage.width(),
      y: stageRect.top + position.y * stageRect.height / stage.height(),
    };
  }, anchorName);
}

async function readCameraState(page) {
  return page.evaluate(() => {
    for (const stage of window.Konva?.stages ?? []) {
      const camera = stage.findOne("#page-camera") ?? stage.findOne(".page-camera");
      if (!camera) continue;
      return {
        x: camera.x(),
        y: camera.y(),
        scale: camera.scaleX(),
      };
    }
    return null;
  });
}

async function readTemplateEditorRenderCount(page) {
  return page.evaluate(() => (
    window.__ALBUM_EDITOR_RENDER_PROBE_COUNTS__?.TemplateEditor ?? 0
  ));
}

async function readTransformerBounds(page) {
  return page.evaluate(() => {
    const stage = window.Konva?.stages?.find(candidate => (
      (candidate.findOne("Transformer")?.nodes?.().length ?? 0) > 0
    ));
    const transformer = stage?.findOne("Transformer");
    return stage && transformer
      ? transformer.getClientRect({ relativeTo: stage })
      : null;
  });
}

test.describe("phone template editor", () => {
  test.use(PHONE_CONTEXT);

  test("empty template keeps the mobile shell and page mutations local until save", async ({ page }) => {
    const templateId = await createAndOpenEmptyEditor(page, "empty-state");
    await expect(page.locator('[data-guide="mobile-editor-dock"]')).toBeVisible();
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "false");
    await expect(page.locator('[data-guide="save-template"]')).toBeDisabled();
    await expect(page.getByRole("button", { name: "新增第一頁", exact: true })).toBeVisible();
    await expect(page.locator("nav")).toBeHidden();
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "新增第一頁", exact: true }).click();
    await expect(page.locator('[data-guide="editor-canvas-viewport"]')).toBeVisible();
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "true");
    expect((await fetchTemplateDetail(page, templateId)).pages).toHaveLength(0);

    await saveTemplateLayout(page);
    expect((await fetchTemplateDetail(page, templateId)).pages).toHaveLength(1);

    await page.locator('[data-guide="mobile-editor-dock"]')
      .getByRole("button", { name: "頁面", exact: true }).click();
    await expect(page.locator('[data-guide="editor-sheet"]')).toBeVisible();
    await page.getByRole("button", { name: "刪除此頁", exact: true }).click();
    await expect(page.locator('[data-guide="editor-sheet"]')).toBeHidden();
    const deleteDialog = page.getByRole("dialog", { name: "確定刪除" });
    await expect(deleteDialog).toBeVisible();
    await deleteDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator('[data-guide="editor-canvas-viewport"]')).toBeVisible();
  });

  test("390x844 keeps the save action, canvas, and 44px dock targets in the first fold", async ({ page }) => {
    await createAndOpenEditor(page, createMobileLayout(), "shell");

    const topbar = page.locator('[data-guide="mobile-editor-topbar"]');
    const dock = page.locator('[data-guide="mobile-editor-dock"]');
    const canvasViewport = page.locator('[data-guide="editor-canvas-viewport"]');
    const saveButton = page.locator('[data-guide="save-template"]');
    await expect(topbar).toBeVisible();
    await expect(dock).toBeVisible();
    await expect(canvasViewport).toBeVisible();
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toHaveAttribute("data-dirty", "false");
    await expect(page.locator("nav")).toBeHidden();
    await expectNoHorizontalOverflow(page);

    const workspaceMetrics = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const topbarRect = rect('[data-guide="mobile-editor-topbar"]');
      const dockRect = rect('[data-guide="mobile-editor-dock"]');
      const canvasRect = rect('[data-guide="editor-canvas-viewport"]');
      const saveRect = rect('[data-guide="save-template"]');
      return {
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        bodyHeight: document.body.scrollHeight,
        topbar: { top: topbarRect.top, bottom: topbarRect.bottom },
        dock: { top: dockRect.top, bottom: dockRect.bottom },
        canvas: { top: canvasRect.top, bottom: canvasRect.bottom, height: canvasRect.height },
        save: { top: saveRect.top, right: saveRect.right, bottom: saveRect.bottom },
      };
    });
    expect(workspaceMetrics.documentHeight).toBeLessThanOrEqual(workspaceMetrics.viewportHeight + 2);
    expect(workspaceMetrics.bodyHeight).toBeLessThanOrEqual(workspaceMetrics.viewportHeight + 2);
    expect(workspaceMetrics.topbar.top).toBeGreaterThanOrEqual(-1);
    expect(workspaceMetrics.canvas.top).toBeGreaterThanOrEqual(workspaceMetrics.topbar.bottom - 1);
    expect(workspaceMetrics.canvas.bottom).toBeLessThanOrEqual(workspaceMetrics.dock.top + 1);
    expect(workspaceMetrics.canvas.height).toBeGreaterThan(240);
    expect(workspaceMetrics.dock.bottom).toBeLessThanOrEqual(workspaceMetrics.viewportHeight + 1);
    expect(workspaceMetrics.save.top).toBeGreaterThanOrEqual(-1);
    expect(workspaceMetrics.save.right).toBeLessThanOrEqual(391);
    expect(workspaceMetrics.save.bottom).toBeLessThanOrEqual(workspaceMetrics.viewportHeight + 1);

    const touchTargets = topbar.locator("button:visible, a:visible")
      .or(dock.locator("button:visible, a:visible"));
    const targetSizes = await touchTargets.evaluateAll(elements => elements.map(element => {
      const targetRect = element.getBoundingClientRect();
      return { width: targetRect.width, height: targetRect.height, label: element.getAttribute("aria-label") || element.textContent };
    }));
    expect(targetSizes.length).toBeGreaterThanOrEqual(6);
    for (const target of targetSizes) {
      expect(target.width, target.label).toBeGreaterThanOrEqual(44);
      expect(target.height, target.label).toBeGreaterThanOrEqual(44);
    }
  });

  test("selection stays on canvas until properties is explicitly opened and center-add saves geometry", async ({ page }) => {
    const { templateId } = await createAndOpenEditor(page, createMobileLayout(), "commands");
    const dock = page.locator('[data-guide="mobile-editor-dock"]');
    const sheet = page.locator('[data-guide="editor-sheet"]');

    const textPoint = await readNodeScreenPoint(page, `text-${FIRST_TEXT_ID}`);
    expect(textPoint).not.toBeNull();
    await page.touchscreen.tap(textPoint.x, textPoint.y);
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);
    await expect(sheet).toBeHidden();

    const propertiesButton = dock.getByRole("button", { name: "屬性", exact: true });
    await propertiesButton.click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("role", "dialog");
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await expect(sheet.getByText("純文字屬性")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(propertiesButton).toBeFocused();
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);

    await dock.getByRole("button", { name: "新增", exact: true }).click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: /照片格 3:4 直式/ }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(async () => {
      const selectedIds = await readSelectedNodeIds(page);
      return selectedIds.length === 1 && selectedIds[0].startsWith("photo-") ? selectedIds[0] : null;
    }).not.toBeNull();
    const [addedNodeId] = await readSelectedNodeIds(page);
    const centeredScene = await readNodeScene(page, addedNodeId);
    expect(Math.abs(centeredScene.x - 530 / 2)).toBeLessThanOrEqual(12);
    expect(Math.abs(centeredScene.y - 750 / 2)).toBeLessThanOrEqual(12);
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "true");

    const beforeDrag = centeredScene;
    const dragStart = await readNodeScreenPoint(page, addedNodeId);
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 24, dragStart.y + 18, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await readNodeScene(page, addedNodeId))?.x)
      .toBeGreaterThan(beforeDrag.x + 5);

    const beforeResize = await readNodeScene(page, addedNodeId);
    const resizeStart = await readTransformerAnchorScreenPoint(page, "bottom-right");
    expect(resizeStart).not.toBeNull();
    await page.mouse.move(resizeStart.x, resizeStart.y);
    await page.mouse.down();
    await page.mouse.move(resizeStart.x + 24, resizeStart.y + 32, { steps: 12 });
    await page.mouse.up();
    const enlargedVisual = await readNodeScene(
      page,
      addedNodeId.replace("photo-", "photo-visual-"),
    );
    expect(enlargedVisual.scaleX).toBeCloseTo(1, 3);
    expect(enlargedVisual.scaleY).toBeCloseTo(1, 3);
    await expect.poll(async () => (await readNodeScene(page, addedNodeId))?.width)
      .toBeGreaterThan(beforeResize.width + 5);

    await saveTemplateLayout(page);
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "false");
    const savedLayout = await fetchTemplatePageLayout(page, templateId);
    expect(savedLayout.photo_slots).toHaveLength(1);
    const savedPhoto = savedLayout.photo_slots[0];
    expect(`photo-${savedPhoto.id}`).toBe(addedNodeId);
    expect(savedPhoto.width).toBeGreaterThan(240);
    expect(savedPhoto.x).toBeGreaterThan(530 / 2 - 240 / 2);

    await page.reload();
    await expect(page.locator('[data-guide="editor-canvas-viewport"]')).toBeVisible();
    await expect.poll(async () => (await readNodeScene(page, addedNodeId))?.width)
      .toBeGreaterThan(beforeResize.width + 5);
  });

  test("explicit multi-select exposes touch command entries without dirtying the template", async ({ page }) => {
    await createAndOpenEditor(page, createMobileLayout({ includeSecondText: true }), "multi-select");
    const dock = page.locator('[data-guide="mobile-editor-dock"]');
    const multiSelectButton = page.locator('[data-guide="multi-select-toggle"]');
    await expect(multiSelectButton).toHaveAttribute("aria-pressed", "false");
    await multiSelectButton.click();
    await expect(multiSelectButton).toHaveAttribute("aria-pressed", "true");

    for (const textId of [FIRST_TEXT_ID, SECOND_TEXT_ID]) {
      const point = await readNodeScreenPoint(page, `text-${textId}`);
      expect(point).not.toBeNull();
      await page.touchscreen.tap(point.x, point.y);
    }
    await expect.poll(() => readSelectedNodeIds(page))
      .toEqual([`text-${FIRST_TEXT_ID}`, `text-${SECOND_TEXT_ID}`]);
    await expect(page.getByRole("button", { name: "複製選取物件", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "剪下選取物件", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "貼上物件", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "建立群組", exact: true })).toBeVisible();
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "false");
    await expect(page.getByRole("button", { name: "復原", exact: true })).toBeDisabled();

    const firstPoint = await readNodeScreenPoint(page, `text-${FIRST_TEXT_ID}`);
    await page.touchscreen.tap(firstPoint.x, firstPoint.y);
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([`text-${SECOND_TEXT_ID}`]);
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "false");
    await expect(dock).toBeVisible();
  });

  test("zoom and fit remain view state and preserve pointer mapping", async ({ page }) => {
    const { templateId } = await createAndOpenEditor(page, createMobileLayout(), "camera");
    const initialTemplate = await fetchTemplateDetail(page, templateId);
    const mutationRequests = [];
    const recordMutation = (request) => {
      const pathname = new URL(request.url()).pathname;
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
        && (pathname === `/api/templates/${templateId}`
          || pathname.startsWith(`/api/templates/${templateId}/`))) {
        mutationRequests.push({ method: request.method(), pathname });
      }
    };
    page.on("request", recordMutation);

    const initialCamera = await readCameraState(page);
    expect(initialCamera).not.toBeNull();
    await page.locator('[data-guide="zoom-in"]').click();
    await expect.poll(async () => (await readCameraState(page))?.scale)
      .toBeGreaterThan(initialCamera.scale + 0.01);

    const zoomedTextPoint = await readNodeScreenPoint(page, `text-${FIRST_TEXT_ID}`);
    await page.touchscreen.tap(zoomedTextPoint.x, zoomedTextPoint.y);
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);
    await expect(page.locator('[data-guide="editor-sheet"]')).toBeHidden();

    await page.locator('[data-guide="zoom-fit"]').click();
    await expect.poll(async () => (await readCameraState(page))?.scale)
      .toBeCloseTo(initialCamera.scale, 3);
    const fittedCamera = await readCameraState(page);
    expect(fittedCamera.x).toBeCloseTo(initialCamera.x, 1);
    expect(fittedCamera.y).toBeCloseTo(initialCamera.y, 1);

    await page.waitForTimeout(750);
    expect(mutationRequests).toEqual([]);
    const unchangedTemplate = await fetchTemplateDetail(page, templateId);
    expect(unchangedTemplate.revision).toBe(initialTemplate.revision);
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "false");
    await expect(page.getByRole("button", { name: "復原", exact: true })).toBeDisabled();

    let beforeUnloadDialogs = 0;
    const acceptUnexpectedDialog = async (dialog) => {
      if (dialog.type() === "beforeunload") beforeUnloadDialogs += 1;
      await dialog.accept();
    };
    page.on("dialog", acceptUnexpectedDialog);
    await page.reload();
    page.off("dialog", acceptUnexpectedDialog);
    expect(beforeUnloadDialogs).toBe(0);
    page.off("request", recordMutation);
  });

  test("camera pan and pinch stay inside TemplateCanvas without rerendering TemplateEditor", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "CDP multi-touch characterization only runs in Chromium");
    await page.addInitScript(() => {
      window.__ALBUM_EDITOR_RENDER_PROBE_COUNTS__ = {};
      window.__ALBUM_EDITOR_RENDER_PROBE__ = (componentName) => {
        const counts = window.__ALBUM_EDITOR_RENDER_PROBE_COUNTS__;
        counts[componentName] = (counts[componentName] ?? 0) + 1;
      };
    });
    const { templateId } = await createAndOpenEditor(
      page,
      createMobileLayout(),
      "camera-render-boundary",
    );
    const textPoint = await readNodeScreenPoint(page, `text-${FIRST_TEXT_ID}`);
    await page.touchscreen.tap(textPoint.x, textPoint.y);
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);
    const beforeLayout = await fetchTemplatePageLayout(page, templateId);
    const mutationRequests = [];
    const recordMutation = (request) => {
      if (request.method() !== "GET" && request.url().includes(`/api/templates/${templateId}`)) {
        mutationRequests.push(`${request.method()} ${request.url()}`);
      }
    };
    page.on("request", recordMutation);
    await expect.poll(async () => {
      const first = await readTemplateEditorRenderCount(page);
      await page.waitForTimeout(50);
      return await readTemplateEditorRenderCount(page) === first ? first : null;
    }).not.toBeNull();

    const initialRenderCount = await readTemplateEditorRenderCount(page);
    expect(initialRenderCount).toBeGreaterThan(0);
    const viewportBox = await page.locator('[data-guide="editor-canvas-viewport"]').boundingBox();
    if (!viewportBox) throw new Error("Template canvas viewport has no bounding box");
    const center = {
      x: viewportBox.x + viewportBox.width / 2,
      y: viewportBox.y + viewportBox.height / 2,
    };

    const beforePinch = await readCameraState(page);
    const beforeTransformer = await readTransformerBounds(page);
    expect(beforeTransformer).not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    const touchPoint = (id, x, y) => ({ id, x, y, radiusX: 1, radiusY: 1, force: 1 });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        touchPoint(1, center.x - 25, center.y),
        touchPoint(2, center.x + 25, center.y),
      ],
    });
    for (const distance of [35, 45, 55, 65, 80]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          touchPoint(1, center.x - distance, center.y),
          touchPoint(2, center.x + distance, center.y),
        ],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => (await readCameraState(page))?.scale)
      .toBeGreaterThan(beforePinch.scale + 0.01);
    const afterPinchScale = (await readCameraState(page)).scale;
    expect(await readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);
    const afterTransformer = await readTransformerBounds(page);
    expect(afterTransformer).not.toBeNull();
    expect(afterTransformer.width).toBeGreaterThan(beforeTransformer.width);
    await expect(page.getByRole("toolbar", { name: "畫布縮放" })).toContainText(
      `${Math.round(afterPinchScale * 100)}%`,
    );
    expect(await readTemplateEditorRenderCount(page)).toBe(initialRenderCount);

    const beforePan = await readCameraState(page);
    await page.mouse.move(center.x, center.y);
    await page.keyboard.down("Space");
    await page.mouse.down();
    await page.mouse.move(center.x + 28, center.y + 20, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await expect.poll(async () => (await readCameraState(page))?.x)
      .not.toBeCloseTo(beforePan.x, 2);
    expect(await readTemplateEditorRenderCount(page)).toBe(initialRenderCount);
    expect(await readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "false");
    await expect(page.getByRole("button", { name: "復原", exact: true })).toBeDisabled();
    expect(mutationRequests).toEqual([]);
    expect(await fetchTemplatePageLayout(page, templateId)).toEqual(beforeLayout);
    expect(await page.evaluate(() => (
      (window.Konva?.stages ?? []).filter(stage => stage.container()?.isConnected).length
    ))).toBe(1);
    page.off("request", recordMutation);
  });

  test("dirty browser back and editor return preserve drafts until discard is confirmed", async ({ page }) => {
    await createAndOpenEditor(page, createMobileLayout(), "dirty-exit");
    await expect.poll(() => page.evaluate(() => (
      window.history.state?.usr?.templateEditorGuard === true
    ))).toBeTruthy();

    const dock = page.locator('[data-guide="mobile-editor-dock"]');
    await dock.getByRole("button", { name: "新增", exact: true }).click();
    await page.locator('[data-guide="editor-sheet"]')
      .getByRole("button", { name: /純文字/ }).click();
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "true");
    const [draftNodeId] = await readSelectedNodeIds(page);
    expect(draftNodeId).toMatch(/^text-/);
    const draftScene = await readNodeScene(page, draftNodeId);

    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("未儲存");
      await dialog.dismiss();
    });
    await page.goBack();
    await expect.poll(() => page.evaluate(() => (
      window.history.state?.usr?.templateEditorGuard === true
    ))).toBeTruthy();
    await expect(page.locator('[data-guide="mobile-editor-topbar"]')).toBeVisible();
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "true");
    await expect.poll(() => readNodeScene(page, draftNodeId)).toEqual(draftScene);

    await page.getByRole("button", { name: "返回模板列表", exact: true }).click();
    const exitDialog = page.getByRole("dialog", { name: "放棄變更並離開" });
    await expect(exitDialog).toBeVisible();
    await exitDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(page.locator('[data-guide="save-template"]')).toHaveAttribute("data-dirty", "true");
    await expect.poll(() => readNodeScene(page, draftNodeId)).toEqual(draftScene);

    await page.getByRole("button", { name: "返回模板列表", exact: true }).click();
    await page.getByRole("dialog", { name: "放棄變更並離開" })
      .getByRole("button", { name: "放棄變更並離開", exact: true }).click();
    await expect(page).toHaveURL(/\/templates\/?$/);
  });

  test("844x390 switches cleanly to the tablet workspace and back", async ({ page }) => {
    await createAndOpenEditor(page, createMobileLayout(), "landscape");
    await expect(page.locator('[data-guide="mobile-editor-dock"]')).toBeVisible();

    await page.setViewportSize({ width: 844, height: 390 });
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.locator('[data-guide="tool-panel"]')).toBeVisible();
    await expect(page.locator('[data-guide="mobile-editor-dock"]')).toBeHidden();
    const tabletMetrics = await page.evaluate(() => {
      const saveRect = document.querySelector('[data-guide="save-template"]').getBoundingClientRect();
      const canvasRect = document.querySelector('[data-guide="editor-canvas-viewport"]').getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        saveTop: saveRect.top,
        saveBottom: saveRect.bottom,
        canvasHeight: canvasRect.height,
        canvasBottom: canvasRect.bottom,
      };
    });
    expect(tabletMetrics.documentHeight).toBeLessThanOrEqual(tabletMetrics.viewportHeight + 2);
    expect(tabletMetrics.saveTop).toBeGreaterThanOrEqual(0);
    expect(tabletMetrics.saveBottom).toBeLessThanOrEqual(tabletMetrics.viewportHeight + 1);
    expect(tabletMetrics.canvasHeight).toBeGreaterThan(120);
    expect(tabletMetrics.canvasBottom).toBeLessThanOrEqual(tabletMetrics.viewportHeight + 1);
    const tabletToolTargets = await page.locator('[data-guide="tool-panel"] button:visible')
      .evaluateAll(buttons => buttons.slice(0, 4).map(button => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
    expect(tabletToolTargets).toHaveLength(4);
    for (const target of tabletToolTargets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    const inspectorTrigger = page.locator('button[aria-controls="editor-inspector"]');
    await expect(inspectorTrigger).toBeVisible();
    await expect(page.locator("#editor-inspector")).toBeHidden();

    const textPoint = await readNodeScreenPoint(page, `text-${FIRST_TEXT_ID}`);
    await page.touchscreen.tap(textPoint.x, textPoint.y);
    await expect(page.locator("#editor-inspector")).toBeHidden();
    await inspectorTrigger.click();
    await expect(page.getByRole("dialog", { name: "編輯器檢查器" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("nav")).toBeHidden();
    await expect(page.locator('[data-guide="mobile-editor-dock"]')).toBeVisible();
    const portraitTextPoint = await readNodeScreenPoint(page, `text-${FIRST_TEXT_ID}`);
    await page.touchscreen.tap(portraitTextPoint.x, portraitTextPoint.y);
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([`text-${FIRST_TEXT_ID}`]);
    await expect(page.locator('[data-guide="editor-sheet"]')).toBeHidden();
  });
});

test.describe("computer-width tablet template editor", () => {
  test.use({
    viewport: { width: 1023, height: 720 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  });

  test("lower canvas objects remain draggable and resizable outside the zoom controls", async ({
    page,
  }) => {
    const { templateId } = await createAndOpenEditor(
      page,
      createLowerCanvasLayout(),
      "computer-tablet-lower-canvas",
    );
    const canvasViewport = page.locator('[data-guide="editor-canvas-viewport"]');
    const zoomRail = page.locator('[data-guide="canvas-zoom-rail"]');
    await expect(zoomRail).toBeVisible();
    const [canvasBox, zoomRailBox] = await Promise.all([
      canvasViewport.boundingBox(),
      zoomRail.boundingBox(),
    ]);
    if (!canvasBox || !zoomRailBox) throw new Error("Canvas or zoom rail has no bounding box");
    expect(zoomRailBox.y).toBeGreaterThanOrEqual(canvasBox.y + canvasBox.height - 1);

    const nodeId = `text-${LOWER_TEXT_ID}`;
    const initialScene = await readNodeScene(page, nodeId);
    const nodePoint = await readNodeScreenPoint(page, nodeId);
    expect(initialScene).not.toBeNull();
    expect(nodePoint).not.toBeNull();
    expect(nodePoint.y).toBeGreaterThan(canvasBox.y + canvasBox.height * 2 / 3);

    await page.mouse.move(nodePoint.x, nodePoint.y);
    await page.mouse.down();
    await page.mouse.move(nodePoint.x + 24, nodePoint.y - 18, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await readNodeScene(page, nodeId))?.x)
      .toBeGreaterThan(initialScene.x + 5);

    const movedPoint = await readNodeScreenPoint(page, nodeId);
    await page.mouse.click(movedPoint.x, movedPoint.y);
    await expect.poll(() => readSelectedNodeIds(page)).toEqual([nodeId]);
    const beforeResize = await readNodeScene(page, nodeId);
    const resizeStart = await readTransformerAnchorScreenPoint(page, "bottom-right");
    expect(resizeStart).not.toBeNull();
    await page.mouse.move(resizeStart.x, resizeStart.y);
    await page.mouse.down();
    await page.mouse.move(resizeStart.x + 24, resizeStart.y + 8, { steps: 12 });
    await page.mouse.up();
    await expect.poll(async () => (await readNodeScene(page, nodeId))?.width)
      .toBeGreaterThan(beforeResize.width + 5);
    const resizedScene = await readNodeScene(page, nodeId);
    expect(resizedScene.scaleX).toBeCloseTo(1, 3);
    expect(resizedScene.scaleY).toBeCloseTo(1, 3);

    await saveTemplateLayout(page);
    const savedLayout = await fetchTemplatePageLayout(page, templateId);
    const savedText = savedLayout.text_labels.find(textLabel => textLabel.id === LOWER_TEXT_ID);
    expect(savedText.x).toBeGreaterThan(280);
    expect(savedText.y).toBeLessThan(1000);
    expect(savedText.width).toBeGreaterThan(220);
  });
});

test.describe("desktop template editor breakpoint", () => {
  test.use({
    viewport: { width: 1024, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  });

  test("1024px keeps the desktop inspector and hides phone controls", async ({ page }) => {
    await createAndOpenEditor(page, createMobileLayout(), "desktop-1024");
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.locator('[data-guide="tool-panel"]')).toBeVisible();
    await expect(page.locator('[data-guide="page-list"]')).toBeVisible();
    await expect(page.locator('[data-guide="mobile-editor-dock"]')).toBeHidden();
    await expect(page.locator('[data-guide="mobile-editor-topbar"]')).toBeHidden();
    const inspector = page.getByRole("complementary", { name: "編輯器檢查器" });
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveCSS("position", "static");
    await expect(page.locator('button[aria-controls="editor-inspector"]')).toBeHidden();

    const stageSize = await page.evaluate(() => {
      const stage = window.Konva?.stages?.[0];
      const layer = stage?.getLayers?.()[0];
      const sceneCanvas = layer?.getNativeCanvasElement?.();
      return stage && layer && sceneCanvas ? {
        width: stage.width(),
        height: stage.height(),
        scale: stage.scaleX(),
        scenePixelRatio: layer.getCanvas().getPixelRatio(),
        hitPixelRatio: layer.getHitCanvas().getPixelRatio(),
        sceneBackingWidth: sceneCanvas.width,
        sceneBackingHeight: sceneCanvas.height,
        sceneCssWidth: sceneCanvas.style.width,
        sceneCssHeight: sceneCanvas.style.height,
      } : null;
    });
    expect(stageSize).not.toBeNull();
    expect(stageSize.width).toBe(530);
    expect(stageSize.height).toBe(750);
    expect(stageSize.scale).toBe(1);
    expect(stageSize.scenePixelRatio).toBeCloseTo(794 / 530, 10);
    expect(stageSize.hitPixelRatio).toBe(1);
    expect(stageSize.sceneBackingWidth).toBe(794);
    expect(stageSize.sceneBackingHeight).toBe(1123);
    expect(stageSize.sceneCssWidth).toBe("530px");
    expect(stageSize.sceneCssHeight).toBe("750px");
  });
});
