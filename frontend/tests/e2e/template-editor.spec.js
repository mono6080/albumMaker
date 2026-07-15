// 模板編輯器 e2e：畫布元素放置與 PIL 渲染 parity
import { expect, test } from "@playwright/test";
import {
  loginViaUi,
  loginViaApi,
  createTemplateWithLayout,
  loadFixtureLayout,
  saveTemplateLayout,
  closeProductGuide,
  fetchTemplateDetail,
  fetchTemplatePageLayout,
} from "./helpers.js";


function createTextLayout(textId, text) {
  return {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: [{
      id: textId,
      x: 120,
      y: 130,
      width: 300,
      height: 90,
      rotation: 0,
      text,
      text_role: "static",
      font_size: 28,
      font_color: "#333333",
      font_family: "msjh",
      text_align: "center",
      line_height: 1.4,
      z_index: 0,
    }],
    stickers: [],
    footer: null,
    logo: null,
  };
}


async function addPersistedTemplatePage(page, templateId, layout) {
  const pageResponse = await page.request.post(`/api/templates/${templateId}/pages`);
  expect(pageResponse.ok()).toBeTruthy();
  const templatePage = await pageResponse.json();
  const layoutResponse = await page.request.put(
    `/api/templates/${templateId}/pages/${templatePage.id}/layout`,
    { data: layout },
  );
  expect(layoutResponse.ok()).toBeTruthy();
  return templatePage;
}


async function selectTextLayer(page, textId, text) {
  await page.locator(`[data-layer-ref="text:${textId}"]`)
    .locator("button")
    .filter({ hasText: text })
    .click();
  await page.getByRole("tab", { name: "屬性", exact: true }).click();
  return page.locator('[data-guide="property-panel"] textarea:visible').first();
}


async function addTextToCurrentPage(page, canvas, text) {
  await page.locator('[data-guide="tool-add-text"]').click();
  await canvas.click({ position: { x: 220, y: 260 } });
  const textarea = page.locator('[data-guide="property-panel"] textarea:visible').first();
  await textarea.fill(text);
}


async function readFirstKonvaNodeScreenPoint(page, nodeIdPrefix) {
  return page.evaluate((expectedPrefix) => {
    const stage = window.Konva?.stages?.find(candidate => (
      candidate.find(node => node.id()?.startsWith(expectedPrefix)).length > 0
    ));
    const node = stage?.find(nodeCandidate => nodeCandidate.id()?.startsWith(expectedPrefix))?.[0];
    if (!stage || !node) return null;
    const position = node.getAbsolutePosition();
    const stageRect = stage.container().getBoundingClientRect();
    return {
      x: stageRect.left + position.x * stageRect.width / stage.width(),
      y: stageRect.top + position.y * stageRect.height / stage.height(),
    };
  }, nodeIdPrefix);
}


async function deleteCurrentTemplatePage(page) {
  await page.getByRole("button", { name: "刪除此頁", exact: true }).click();
  await page.getByRole("dialog", { name: "確定刪除" })
    .getByRole("button", { name: "確定刪除", exact: true })
    .click();
}


test("admin can create a template and place canvas elements", async ({ page }) => {
  const templateName = `E2E 模板 ${Date.now()}`;

  await loginViaUi(page);
  await expect(page.getByRole("heading", { name: "模板管理" })).toBeVisible();

  // 建立表單已改為 Modal，先開啟
  await page.getByRole("button", { name: "建立模板" }).click();
  await page.locator('[data-guide="template-name-input"]').fill(templateName);
  await page.locator('[data-guide="template-create-button"]').click();
  await expect(page.getByText(templateName)).toBeVisible();

  const templatesResponse = await page.request.get("/api/templates/");
  const templates = await templatesResponse.json();
  const template = templates.find(item => item.name === templateName);
  expect(template).toBeTruthy();

  await page.goto(`/templates/${template.id}/edit`);
  await page.getByRole("button", { name: "新增第一頁" }).click();
  await expect(page.getByText("模板編輯器")).toBeVisible();
  await expect(page.getByRole("button", { name: /第 1 頁/ })).toBeVisible();

  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("照片總計");
  await expect(page.locator(".driver-popover")).toContainText("整份模板的照片格總數");
  await closeProductGuide(page);

  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();

  await page.getByRole("button", { name: /照片格 3:4 直式/ }).click();
  await canvas.click({ position: { x: 90, y: 90 } });
  await expect(page.getByText("照片總計 1 張")).toBeVisible();
  await page.getByRole("button", { name: /純文字/ }).click();
  await canvas.click({ position: { x: 190, y: 260 } });

  await page.keyboard.press("Control+Z");
  await saveTemplateLayout(page);
  let layout = await fetchTemplatePageLayout(page, template.id);
  expect(layout.photo_slots).toHaveLength(1);
  expect(layout.text_labels).toHaveLength(0);

  await page.keyboard.press("Control+Y");
  await saveTemplateLayout(page);
  layout = await fetchTemplatePageLayout(page, template.id);
  expect(layout.photo_slots).toHaveLength(1);
  expect(layout.text_labels).toHaveLength(1);

  await page.getByRole("button", { name: "復原" }).click();
  await saveTemplateLayout(page);
  layout = await fetchTemplatePageLayout(page, template.id);
  expect(layout.photo_slots).toHaveLength(1);
  expect(layout.text_labels).toHaveLength(0);

  await page.getByRole("button", { name: "重做" }).click();
  await saveTemplateLayout(page);

  layout = await fetchTemplatePageLayout(page, template.id);
  expect(layout.photo_slots).toHaveLength(1);
  expect(layout.text_labels).toHaveLength(1);

  await page.getByRole("button", { name: /選取/ }).click();
  await canvas.click({ position: { x: 270, y: 287 } });
  const inspector = page.getByRole("complementary", { name: "編輯器檢查器" });
  const propertiesTab = inspector.getByRole("tab", { name: "屬性" });
  const layersTab = inspector.getByRole("tab", { name: "圖層" });
  await expect(propertiesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("純文字屬性")).toBeVisible();
  const transformSection = inspector.getByRole("button", { name: "位置與尺寸", exact: true });
  await transformSection.click();
  await expect(transformSection).toHaveAttribute("aria-expanded", "true");
  await propertiesTab.press("ArrowRight");
  await expect(layersTab).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("heading", { name: "圖層清單" })).toBeVisible();
  await inspector.getByRole("button", { name: /\{name\}的文字標題/ }).click();
  await expect(layersTab).toHaveAttribute("aria-selected", "true");
  await layersTab.press("Home");
  await expect(propertiesTab).toHaveAttribute("aria-selected", "true");
  await expect(transformSection).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("純文字屬性")).toBeVisible();
  const templateTextArea = page.locator('[data-guide="property-panel"] textarea').first();
  await templateTextArea.fill("主角：");
  await page.getByRole("button", { name: "插入 {name}" }).click();
  await expect(templateTextArea).toHaveValue("主角：{name}");
  await saveTemplateLayout(page);

  layout = await fetchTemplatePageLayout(page, template.id);
  expect(layout.text_labels[0].text).toBe("主角：{name}");

  await page.getByRole("button", { name: "雙頁預覽" }).click();
  await expect(page.getByRole("dialog", { name: "雙頁預覽" })).toBeVisible();
  await expect(page.getByRole("img", { name: "雙頁合併預覽" })).toBeVisible();
  await page.getByRole("button", { name: "關閉雙頁預覽" }).click();
  await expect(page.getByRole("dialog", { name: "雙頁預覽" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(layersTab).toHaveAttribute("aria-selected", "true");
  await expect(inspector.getByRole("heading", { name: "圖層清單" })).toBeVisible();

  const expectNoHorizontalOverflow = async () => {
    const hasHorizontalOverflow = await page.evaluate(() => (
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    ));
    expect(hasHorizontalOverflow).toBe(false);
  };

  await page.setViewportSize({ width: 1024, height: 900 });
  const staticInspector = page.getByRole("complementary", { name: "編輯器檢查器" });
  await staticInspector.scrollIntoViewIfNeeded();
  await expect(staticInspector).toBeVisible();
  await expect(staticInspector).toHaveCSS("position", "static");
  const drawerTrigger = page.locator('button[aria-controls="editor-inspector"]');
  await expect(drawerTrigger).toBeHidden();
  await expectNoHorizontalOverflow();

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(drawerTrigger).toBeVisible();
  await expect(drawerTrigger).toHaveCSS("position", "fixed");
  await expect(page.locator("#editor-inspector")).toBeHidden();
  await drawerTrigger.click();

  const inspectorDrawer = page.getByRole("dialog", { name: "編輯器檢查器" });
  await expect(inspectorDrawer).toBeVisible();
  await expect(inspectorDrawer).toHaveAttribute("aria-modal", "true");
  await expectNoHorizontalOverflow();
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor-inspector")).toBeHidden();
  await expect(drawerTrigger).toBeFocused();

  // 平板從畫布選取物件時保留 selection，但 drawer 必須由使用者明確開啟。
  const tabletPhotoPoint = await readFirstKonvaNodeScreenPoint(page, "photo-");
  expect(tabletPhotoPoint).not.toBeNull();
  await page.mouse.click(tabletPhotoPoint.x, tabletPhotoPoint.y);
  await expect(page.locator("#editor-inspector")).toBeHidden();
  await expect(drawerTrigger).toBeVisible();
  await expect(drawerTrigger).toHaveAttribute("aria-label", "開啟屬性面板");
  await drawerTrigger.click();
  await expect(inspectorDrawer).toBeVisible();
  await expect(inspectorDrawer.getByRole("tab", { name: "屬性" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(inspectorDrawer.getByText("照片格屬性")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#editor-inspector")).toBeHidden();
  await expect(drawerTrigger).toBeVisible();
  await expect(drawerTrigger).toHaveAttribute("aria-label", "開啟屬性面板");
});


test("select mode shows hover outlines for the current direct canvas object", async ({ page }) => {
  const photo = {
    id: 101,
    x: 60,
    y: 100,
    width: 180,
    height: 240,
    rotation: 0,
    border: false,
    z_index: 0,
  };
  const text = {
    id: 202,
    x: 350,
    y: 110,
    width: 180,
    height: 80,
    rotation: 0,
    text: "群組文字",
    text_role: "fillable",
    font_size: 24,
    font_color: "#333333",
    text_align: "center",
    line_height: 1.4,
    z_index: 1,
  };
  const sticker = {
    id: 303,
    path: "templates/missing/stickers/missing.png",
    filename: "missing.png",
    x: 360,
    y: 260,
    width: 140,
    height: 100,
    rotation: 0,
    z_index: 2,
  };
  const group = {
    id: 404,
    z_index: 1,
    selection_rotation: 0,
    children: [{ type: "text", id: text.id }, { type: "sticker", id: sticker.id }],
  };
  const layout = {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [photo],
    text_labels: [text],
    stickers: [sticker],
    groups: [group],
    group_contract: "nested-world-v2",
    footer: null,
    logo: null,
  };

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E hover outline ${Date.now()}`,
    layout,
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();
  const toCanvasPosition = (x, y) => ({
    x: Math.round(x * 530 / 794),
    y: Math.round(y * 530 / 794),
  });
  const readHoverOutline = () => page.evaluate((photoId) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#photo-${photoId}`));
    const outlines = stage?.find(".object-hover-outline") ?? [];
    return {
      count: outlines.length,
      parentId: outlines[0]?.getParent()?.id() ?? null,
    };
  }, photo.id);
  const readTextFrame = () => page.evaluate((textId) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#text-${textId}`));
    const frame = stage?.findOne(`#text-${textId}`)?.getChildren()?.[0];
    return frame ? {
      stroke: frame.stroke(),
      strokeWidth: frame.strokeWidth(),
      dash: frame.dash(),
    } : null;
  }, text.id);

  await expect.poll(readTextFrame).toEqual({ stroke: "transparent", strokeWidth: 0, dash: [] });

  await canvas.hover({ position: toCanvasPosition(140, 180) });
  await expect.poll(readHoverOutline).toEqual({ count: 1, parentId: `photo-${photo.id}` });

  await page.getByRole("button", { name: /純文字/ }).click();
  await expect.poll(readHoverOutline).toEqual({ count: 0, parentId: null });
  await canvas.hover({ position: toCanvasPosition(140, 180) });
  await expect.poll(readHoverOutline).toEqual({ count: 0, parentId: null });

  await page.getByRole("button", { name: /選取/ }).click();
  await canvas.hover({ position: toCanvasPosition(400, 150) });
  await expect.poll(readHoverOutline).toEqual({ count: 1, parentId: `group-${group.id}` });

  await canvas.click({ position: toCanvasPosition(400, 150) });
  await expect(page.getByRole("heading", { name: /物件群組/ })).toBeVisible();
  await expect.poll(readHoverOutline).toEqual({ count: 0, parentId: null });
  await page.getByRole("button", { name: "進入群組" }).click();
  await expect(page.locator('[data-guide="isolation-breadcrumb"]:visible')).toContainText("群組 1");

  await canvas.hover({ position: toCanvasPosition(400, 300) });
  await expect.poll(readHoverOutline).toEqual({ count: 1, parentId: `sticker-${sticker.id}` });
  await canvas.click({ position: toCanvasPosition(400, 300) });
  await canvas.hover({ position: toCanvasPosition(400, 150) });
  await expect.poll(readHoverOutline).toEqual({ count: 1, parentId: `text-${text.id}` });
  await canvas.hover({ position: toCanvasPosition(700, 1000) });
  await expect.poll(readHoverOutline).toEqual({ count: 0, parentId: null });
});


test("continuous property typing is restored as one undo transaction", async ({ page }) => {
  const text = {
    id: 707,
    x: 180,
    y: 180,
    width: 300,
    height: 90,
    rotation: 0,
    text: "原始文字",
    text_role: "static",
    font_size: 28,
    font_color: "#333333",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.4,
    z_index: 0,
  };
  const layout = {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: [text],
    stickers: [],
    footer: null,
    logo: null,
  };

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E property history ${Date.now()}`,
    layout,
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  const canvas = page.locator(".konvajs-content canvas").first();
  await canvas.click({ position: { x: 220, y: 150 } });
  const textarea = page.locator('[data-guide="property-panel"] textarea').first();
  await expect(textarea).toHaveValue(text.text);
  await textarea.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("一次復原整段輸入");
  await page.getByRole("tab", { name: "圖層" }).click();

  await page.keyboard.press("Control+Z");
  await page.getByRole("tab", { name: "屬性" }).click();
  await expect(textarea).toHaveValue(text.text);

  await page.keyboard.press("Control+Y");
  await expect(textarea).toHaveValue("一次復原整段輸入");

  const fontPicker = page.locator('[data-guide="text-font-picker"]');
  for (const fontName of ["標楷體", "細明體", "新細明體", "微軟雅黑", "微軟正黑體 Bold"]) {
    await fontPicker.getByRole("button", { name: fontName, exact: true }).click();
  }
  await expect(fontPicker.getByRole("button")).toHaveCount(6);
  await expect(fontPicker.getByRole("button", { name: "微軟正黑體 Bold", exact: true }))
    .toHaveClass(/border-indigo-500/);

  const colorPicker = page.locator('[data-guide="text-color"]');
  for (const color of ["#FDED6E", "#FF4444", "#00AAFF", "#9B59B6", "#212121"]) {
    await colorPicker.getByRole("button", { name: `使用顏色 ${color}`, exact: true }).click();
  }
  await expect(colorPicker.locator('button[aria-label^="使用顏色 "]')).toHaveCount(48);
  await expect(colorPicker.locator('input[type="text"]')).toHaveValue("#212121");
});


test("internal copy and paste duplicates the selected canvas object", async ({ page }) => {
  const text = {
    id: 808,
    x: 120,
    y: 140,
    width: 260,
    height: 90,
    rotation: 0,
    text: "剪貼簿文字",
    text_role: "static",
    font_size: 28,
    font_color: "#333333",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.4,
    z_index: 0,
  };
  const layout = {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: [text],
    stickers: [],
    footer: null,
    logo: null,
  };

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E copy paste ${Date.now()}`,
    layout,
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  await page.locator(`[data-layer-ref="text:${text.id}"]`)
    .locator("button")
    .filter({ hasText: text.text })
    .click();
  await page.keyboard.press("Control+C");
  await expect(page.getByText("已複製 1 個物件")).toBeVisible();
  await page.keyboard.press("Control+V");
  await saveTemplateLayout(page);

  const saved = await fetchTemplatePageLayout(page, templateId);
  expect(saved.text_labels).toHaveLength(2);
  const copiedText = saved.text_labels.find(item => item.id !== text.id);
  expect(copiedText).toMatchObject({
    text: text.text,
    x: text.x + 20,
    y: text.y + 20,
    width: text.width,
    height: text.height,
    font_size: text.font_size,
  });
});


test("cut is restored by one undo and remains available for paste", async ({ page }) => {
  const text = {
    id: 909,
    x: 160,
    y: 170,
    width: 280,
    height: 100,
    rotation: 0,
    text: "可復原剪下文字",
    text_role: "static",
    font_size: 30,
    font_color: "#222222",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.4,
    z_index: 0,
  };
  const layout = {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [],
    text_labels: [text],
    stickers: [],
    footer: null,
    logo: null,
  };

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E cut paste ${Date.now()}`,
    layout,
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  await page.locator(`[data-layer-ref="text:${text.id}"]`)
    .locator("button")
    .filter({ hasText: text.text })
    .click();
  await page.keyboard.press("Control+X");
  await expect(page.getByText("已剪下 1 個物件")).toBeVisible();
  await expect.poll(() => page.evaluate((textId) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#text-${textId}`));
    return stage?.find(`#text-${textId}`).length ?? 0;
  }, text.id)).toBe(0);

  await page.keyboard.press("Control+Z");
  await expect.poll(() => page.evaluate((textId) => {
    const stage = window.Konva?.stages?.find(candidate => candidate.findOne(`#text-${textId}`));
    return stage?.find(`#text-${textId}`).length ?? 0;
  }, text.id)).toBe(1);
  await saveTemplateLayout(page);
  let saved = await fetchTemplatePageLayout(page, templateId);
  expect(saved.text_labels).toHaveLength(1);
  expect(saved.text_labels[0].id).toBe(text.id);

  await page.keyboard.press("Control+V");
  await saveTemplateLayout(page);
  saved = await fetchTemplatePageLayout(page, templateId);
  expect(saved.text_labels).toHaveLength(2);
  expect(saved.text_labels).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: text.id, x: text.x, y: text.y }),
    expect.objectContaining({ text: text.text, x: text.x, y: text.y }),
  ]));
});


test("page edits and structural mutations stay local until reload or save", async ({ page }) => {
  const firstText = { id: 1001, value: "伺服器第一頁" };
  const secondText = { id: 1002, value: "伺服器第二頁" };
  const localFirstText = "只留在前端的第一頁草稿";
  const localNewPageText = "只留在新增頁的內容";

  await loginViaApi(page);
  const { templateId, pageId: firstPageId } = await createTemplateWithLayout(
    page,
    `E2E local page mutations ${Date.now()}`,
    createTextLayout(firstText.id, firstText.value),
  );
  const secondPage = await addPersistedTemplatePage(
    page,
    templateId,
    createTextLayout(secondText.id, secondText.value),
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  const initialPersisted = await fetchTemplateDetail(page, templateId);

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

  const firstTextarea = await selectTextLayer(page, firstText.id, firstText.value);
  await firstTextarea.fill(localFirstText);
  const canvas = page.locator(".konvajs-content canvas").first();
  await page.locator('[data-guide="add-page"]').click();
  await expect(page.getByRole("button", { name: /^第 3 頁/ })).toHaveClass(/bg-indigo-600/);
  await addTextToCurrentPage(page, canvas, localNewPageText);

  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  await deleteCurrentTemplatePage(page);
  await expect(page.getByRole("button", { name: /^第 3 頁/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  await expect(page.locator('[data-layer-ref^="text:"]')
    .locator("button")
    .filter({ hasText: localNewPageText })).toBeVisible();

  // 明確跨過一般防抖儲存時窗，避免延遲寫入在斷言後才發生。
  await page.waitForTimeout(750);
  expect(mutationRequests).toHaveLength(0);
  let persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.revision).toBe(initialPersisted.revision);
  expect(persisted.pages.map(item => item.id)).toEqual([firstPageId, secondPage.id]);
  expect(persisted.pages[0].layout.text_labels[0].text).toBe(firstText.value);
  expect(persisted.pages[1].layout.text_labels[0].text).toBe(secondText.value);

  await page.reload();
  await expect(page.getByText("模板編輯器")).toBeVisible();
  await expect(page.getByRole("button", { name: /^第 2 頁/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^第 3 頁/ })).toHaveCount(0);
  const restoredFirstTextarea = await selectTextLayer(page, firstText.id, firstText.value);
  await expect(restoredFirstTextarea).toHaveValue(firstText.value);
  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  const restoredSecondTextarea = await selectTextLayer(page, secondText.id, secondText.value);
  await expect(restoredSecondTextarea).toHaveValue(secondText.value);
  await page.waitForTimeout(750);
  expect(mutationRequests).toHaveLength(0);
  page.off("request", recordMutation);

  persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages.map(item => item.id)).toEqual([firstPageId, secondPage.id]);
});


test("explicit save atomically persists mixed page changes and new-page content", async ({ page }) => {
  const firstText = { id: 1101, value: "第一頁原始內容" };
  const secondText = { id: 1102, value: "第二頁將刪除" };
  const savedFirstText = "第一頁原子儲存後內容";
  const savedNewPageText = "新增頁與內容一起落盤";
  const discardedNewPageText = "儲存前已刪除的新頁";

  await loginViaApi(page);
  const { templateId, pageId: firstPageId } = await createTemplateWithLayout(
    page,
    `E2E atomic page save ${Date.now()}`,
    createTextLayout(firstText.id, firstText.value),
  );
  const secondPage = await addPersistedTemplatePage(
    page,
    templateId,
    createTextLayout(secondText.id, secondText.value),
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  const firstTextarea = await selectTextLayer(page, firstText.id, firstText.value);
  await firstTextarea.fill(savedFirstText);
  const canvas = page.locator(".konvajs-content canvas").first();
  await page.locator('[data-guide="add-page"]').click();
  await addTextToCurrentPage(page, canvas, savedNewPageText);
  await page.locator('[data-guide="add-page"]').click();
  await addTextToCurrentPage(page, canvas, discardedNewPageText);
  await deleteCurrentTemplatePage(page);

  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  await deleteCurrentTemplatePage(page);
  await expect(page.getByRole("button", { name: /^第 2 頁/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^第 3 頁/ })).toHaveCount(0);

  const snapshotPayloads = [];
  const recordSnapshot = (request) => {
    if (request.method() === "PUT"
      && new URL(request.url()).pathname === `/api/templates/${templateId}/pages`) {
      snapshotPayloads.push(request.postDataJSON());
    }
  };
  page.on("request", recordSnapshot);
  await saveTemplateLayout(page);
  page.off("request", recordSnapshot);

  expect(snapshotPayloads).toHaveLength(1);
  expect(snapshotPayloads[0].expected_page_ids).toEqual([firstPageId, secondPage.id]);
  expect(snapshotPayloads[0].pages).toHaveLength(2);
  expect(snapshotPayloads[0].pages[0]).toMatchObject({ id: firstPageId });
  expect(snapshotPayloads[0].pages[0].layout.text_labels[0].text).toBe(savedFirstText);
  expect(snapshotPayloads[0].pages[1].client_id).toMatch(/^draft-page:/);
  expect(snapshotPayloads[0].pages[1].layout.text_labels[0].text).toBe(savedNewPageText);

  let persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages).toHaveLength(2);
  expect(persisted.pages.map(item => item.page_number)).toEqual([0, 1]);
  expect(persisted.pages[0].id).toBe(firstPageId);
  expect(persisted.pages[0].layout.text_labels[0].text).toBe(savedFirstText);
  expect(persisted.pages[1].id).not.toBe(secondPage.id);
  expect(persisted.pages[1].layout.text_labels[0].text).toBe(savedNewPageText);
  expect(persisted.pages.flatMap(item => item.layout.text_labels).some(
    item => item.text === discardedNewPageText,
  )).toBe(false);

  await page.reload();
  await expect(page.getByText("模板編輯器")).toBeVisible();
  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  await expect(page.locator('[data-layer-ref^="text:"]')
    .locator("button")
    .filter({ hasText: savedNewPageText })).toBeVisible();
  persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages.filter(item => item.layout.text_labels.some(
    label => label.text === savedNewPageText,
  ))).toHaveLength(1);
});


test("failed page snapshot keeps every draft and retries without duplicate pages", async ({ page }) => {
  const firstText = { id: 1151, value: "失敗測試原始第一頁" };
  const secondText = { id: 1152, value: "失敗測試原始第二頁" };
  const retainedFirstText = "失敗後仍保留的第一頁修改";
  const retainedNewPageText = "失敗後仍保留的新增頁";

  await loginViaApi(page);
  const { templateId, pageId: firstPageId } = await createTemplateWithLayout(
    page,
    `E2E failed page save ${Date.now()}`,
    createTextLayout(firstText.id, firstText.value),
  );
  const secondPage = await addPersistedTemplatePage(
    page,
    templateId,
    createTextLayout(secondText.id, secondText.value),
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  const firstTextarea = await selectTextLayer(page, firstText.id, firstText.value);
  await firstTextarea.fill(retainedFirstText);
  const canvas = page.locator(".konvajs-content canvas").first();
  await page.locator('[data-guide="add-page"]').click();
  await addTextToCurrentPage(page, canvas, retainedNewPageText);
  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  await deleteCurrentTemplatePage(page);

  const snapshotRoute = `**/api/templates/${templateId}/pages`;
  await page.route(snapshotRoute, async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "forced snapshot failure" }),
      });
      return;
    }
    await route.continue();
  });
  const failedResponse = page.waitForResponse(response => (
    response.request().method() === "PUT"
      && new URL(response.url()).pathname === `/api/templates/${templateId}/pages`
      && response.status() === 500
  ));
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await failedResponse;
  await expect(page.getByText("儲存失敗，草稿仍保留在畫面上")).toBeVisible();
  await expect(page.getByRole("button", { name: "儲存", exact: true })).toBeEnabled();

  const retainedTextarea = await selectTextLayer(page, firstText.id, retainedFirstText);
  await expect(retainedTextarea).toHaveValue(retainedFirstText);
  await page.getByRole("button", { name: /^第 2 頁/ }).click();
  await expect(page.locator('[data-layer-ref^="text:"]')
    .locator("button")
    .filter({ hasText: retainedNewPageText })).toBeVisible();

  let persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages.map(item => item.id)).toEqual([firstPageId, secondPage.id]);
  expect(persisted.pages[0].layout.text_labels[0].text).toBe(firstText.value);
  expect(persisted.pages[1].layout.text_labels[0].text).toBe(secondText.value);

  await page.unroute(snapshotRoute);
  await saveTemplateLayout(page);
  persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages).toHaveLength(2);
  expect(persisted.pages[0].id).toBe(firstPageId);
  expect(persisted.pages[0].layout.text_labels[0].text).toBe(retainedFirstText);
  expect(persisted.pages.some(item => item.id === secondPage.id)).toBe(false);
  expect(persisted.pages.filter(item => item.layout.text_labels.some(
    label => label.text === retainedNewPageText,
  ))).toHaveLength(1);
});


test("deleting the final page stays local and can be explicitly saved from the empty state", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(
    page,
    `E2E empty template page save ${Date.now()}`,
    createTextLayout(1191, "最後一頁"),
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  await deleteCurrentTemplatePage(page);
  await expect(page.getByRole("button", { name: "新增第一頁", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "儲存", exact: true })).toBeVisible();
  let persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages.map(item => item.id)).toEqual([pageId]);

  await saveTemplateLayout(page);
  persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages).toEqual([]);

  await page.getByRole("button", { name: "新增第一頁", exact: true }).click();
  await expect(page.getByRole("button", { name: /^第 1 頁/ })).toBeVisible();
  persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages).toEqual([]);

  await saveTemplateLayout(page);
  persisted = await fetchTemplateDetail(page, templateId);
  expect(persisted.pages).toHaveLength(1);
  expect(persisted.pages[0].page_number).toBe(0);
  expect(persisted.pages[0].layout.text_labels).toEqual([]);
});


test("manual save persists edits made while an earlier request is in flight", async ({ page }) => {
  const text = {
    id: 1201,
    x: 140,
    y: 150,
    width: 300,
    height: 90,
    rotation: 0,
    text: "原始內容",
    text_role: "static",
    font_size: 28,
    font_color: "#333333",
    font_family: "msjh",
    text_align: "center",
    line_height: 1.4,
    z_index: 0,
  };
  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(
    page,
    `E2E manual save race ${Date.now()}`,
    {
      canvas_width: 794,
      canvas_height: 1123,
      photo_slots: [],
      text_labels: [text],
      stickers: [],
      footer: null,
      logo: null,
    },
  );
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  await page.locator(`[data-layer-ref="text:${text.id}"]`)
    .locator("button")
    .filter({ hasText: text.text })
    .click();
  await page.getByRole("tab", { name: "屬性", exact: true }).click();
  const textarea = page.locator('[data-guide="property-panel"] textarea:visible').first();
  await textarea.fill("第一版修改");

  let releaseFirstSave;
  const firstSaveRelease = new Promise(resolve => { releaseFirstSave = resolve; });
  let announceFirstSave;
  const firstSaveSeen = new Promise(resolve => { announceFirstSave = resolve; });
  const savedPayloads = [];
  await page.route(`**/api/templates/${templateId}/pages`, async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    savedPayloads.push(route.request().postDataJSON());
    if (savedPayloads.length === 1) {
      announceFirstSave();
      await firstSaveRelease;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await firstSaveSeen;
  await textarea.fill("請求期間的最新版");
  releaseFirstSave();

  await expect.poll(() => savedPayloads.length).toBe(2);
  await expect(page.getByRole("button", { name: "儲存", exact: true })).toBeEnabled();
  expect(savedPayloads.map(payload => payload.pages
    .find(item => item.id === pageId)
    .layout.text_labels[0].text)).toEqual([
    "第一版修改",
    "請求期間的最新版",
  ]);

  const detailResponse = await page.request.get(`/api/templates/${templateId}`);
  const detail = await detailResponse.json();
  expect(detail.pages.find(item => item.id === pageId).layout.text_labels[0].text)
    .toBe("請求期間的最新版");
});


test("TemplateEditor browser canvas matches PIL preview in stable regions", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 視覺 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(page, templateName, layout);

  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();

  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();

  const comparison = await canvas.evaluate(async (canvasElement, previewUrl) => {
    const canvasContext = canvasElement.getContext("2d");
    const previewResponse = await fetch(previewUrl);
    const previewBlob = await previewResponse.blob();
    const previewBitmap = await createImageBitmap(previewBlob);
    const previewCanvas = document.createElement("canvas");
    previewCanvas.width = canvasElement.width;
    previewCanvas.height = canvasElement.height;
    const previewContext = previewCanvas.getContext("2d");
    previewContext.drawImage(previewBitmap, 0, 0, previewCanvas.width, previewCanvas.height);

    const toDisplay = (realValue) => Math.round(realValue * canvasElement.width / 794);
    const readPixel = (context, realX, realY) => {
      const data = context.getImageData(toDisplay(realX), toDisplay(realY), 1, 1).data;
      return [data[0], data[1], data[2]];
    };
    const pixelDiff = (a, b) => Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
    const countNonWhite = (context, box) => {
      const x = toDisplay(box.x);
      const y = toDisplay(box.y);
      const width = Math.max(1, toDisplay(box.width));
      const height = Math.max(1, toDisplay(box.height));
      const data = context.getImageData(x, y, width, height).data;
      let count = 0;
      for (let index = 0; index < data.length; index += 4) {
        if (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245) count += 1;
      }
      return count;
    };

    return {
      photoDiff: pixelDiff(readPixel(canvasContext, 55, 67), readPixel(previewContext, 55, 67)),
      canvasTextPixels: countNonWhite(canvasContext, { x: 58, y: 250, width: 300, height: 82 }),
      previewTextPixels: countNonWhite(previewContext, { x: 58, y: 250, width: 300, height: 82 }),
      canvasFooterPixels: countNonWhite(canvasContext, { x: 36, y: 1058, width: 250, height: 44 }),
      previewFooterPixels: countNonWhite(previewContext, { x: 36, y: 1058, width: 250, height: 44 }),
    };
  }, `/api/templates/${templateId}/pages/${pageId}/preview`);

  expect(comparison.photoDiff).toBeLessThanOrEqual(14);
  expect(comparison.canvasTextPixels).toBeGreaterThan(20);
  expect(comparison.previewTextPixels).toBeGreaterThan(20);
  expect(comparison.canvasFooterPixels).toBeGreaterThan(10);
  expect(comparison.previewFooterPixels).toBeGreaterThan(10);
});
