import { expect, test } from "@playwright/test";

import {
  createTemplateWithLayout,
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
    text_bubbles: [],
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

async function openEditor(page, templateId) {
  await page.goto(`/templates/${templateId}/edit`);
  await expect(page.getByText("模板編輯器")).toBeVisible();
  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();
  return canvas;
}

test("group, isolation, free child ratio, undo and reload keep one structural group", async ({ page }) => {
  await loginViaApi(page);
  const sticker = {
    id: 101,
    path: "templates/tmpl0/stickers/missing.png",
    filename: "missing.png",
    x: 80,
    y: 150,
    width: 180,
    height: 100,
    rotation: 0,
    z_index: 0,
  };
  const text = {
    id: 202,
    x: 340,
    y: 160,
    width: 220,
    height: 80,
    rotation: 0,
    text: "群組示範文字",
    text_role: "static",
    font_size: 24,
    font_color: "#333333",
    text_align: "center",
    line_height: 1.4,
    z_index: 1,
  };
  const { templateId } = await createTemplateWithLayout(
    page,
    `E2E Illustrator group ${Date.now()}`,
    baseLayout({ stickers: [sticker], text_labels: [text] }),
  );
  const canvas = await openEditor(page, templateId);

  await canvas.click({ position: canvasPoint(110, 175) });
  await page.keyboard.down("Shift");
  await canvas.click({ position: canvasPoint(390, 185) });
  await page.keyboard.up("Shift");
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await expect(page.getByRole("button", { name: "建立群組", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "群組並連結文字＋圖片" })).toBeVisible();

  await page.getByRole("button", { name: "建立群組", exact: true }).click();
  await expect(page.getByText("物件群組")).toBeVisible();
  await saveTemplateLayout(page);
  let layout = await fetchTemplatePageLayout(page, templateId);
  expect(layout.groups).toHaveLength(1);
  expect(layout.groups[0].links).toEqual([]);
  expect(layout.stickers[0]).toMatchObject(sticker);
  expect(layout.text_labels[0]).toMatchObject(text);

  await page.getByRole("button", { name: "進入群組" }).click();
  await expect(page.getByText("貼圖素材屬性")).toBeVisible();
  const sizeInputs = page.locator('[data-guide="property-position-size"] input[type="number"]');
  await sizeInputs.nth(2).fill("300");
  await sizeInputs.nth(2).evaluate(input => input.blur());
  await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name: "離開群組" }).click();
  await expect(page.getByText("物件群組")).toBeVisible();

  await page.getByRole("button", { name: "解除群組" }).click();
  await expect(page.getByText("已選取 2 個物件")).toBeVisible();
  await page.getByRole("button", { name: "復原" }).click();
  await page.getByRole("button", { name: /物件群組/ }).click();
  await saveTemplateLayout(page);

  layout = await fetchTemplatePageLayout(page, templateId);
  expect(layout.groups).toHaveLength(1);
  expect(layout.stickers[0].width).toBe(300);
  expect(layout.stickers[0].height).toBe(100);
  expect(layout.stickers[0].x).toBe(81);
  expect(layout.text_labels[0]).toMatchObject(text);

  await page.reload();
  await expect(page.getByText("模板編輯器")).toBeVisible();
  await page.getByRole("button", { name: /物件群組/ }).dblclick();
  await expect(page.getByRole("button", { name: "離開群組" })).toBeVisible();
  await expect(page.getByText("貼圖素材屬性")).toBeVisible();
  await expect(page.getByText("物件群組", { exact: true })).toBeVisible();
  const reloadedSizeInputs = page.locator('[data-guide="property-position-size"] input[type="number"]');
  await reloadedSizeInputs.nth(2).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "離開群組" })).toHaveCount(0);
  await expect(page.getByText("物件群組")).toBeVisible();
});

test("image analysis creates then resets a normal linked text box without changing media", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(
    page,
    `E2E material text box ${Date.now()}`,
    baseLayout(),
  );
  const uploadResponse = await page.request.post(`/api/templates/${templateId}/stickers`, {
    multipart: {
      file: { name: "material.png", mimeType: "image/png", buffer: redPng },
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploaded = await uploadResponse.json();
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
  const existingText = {
    id: 302,
    x: 500,
    y: 420,
    width: 180,
    height: 60,
    rotation: 0,
    text: "既有群組文字",
    text_role: "static",
    font_size: 20,
    font_color: "#333333",
    text_align: "center",
    line_height: 1.4,
    z_index: 1,
  };
  const putResponse = await page.request.put(
    `/api/templates/${templateId}/pages/${pageId}/layout`,
    {
      data: baseLayout({
        group_contract: "flat-world-v1",
        stickers: [originalSticker],
        text_labels: [existingText],
        groups: [{
          id: 401,
          z_index: 0,
          selection_rotation: 37,
          children: [{ type: "sticker", id: originalSticker.id }, { type: "text", id: existingText.id }],
          links: [],
        }],
      }),
    },
  );
  expect(putResponse.ok()).toBeTruthy();

  const canvas = await openEditor(page, templateId);
  await canvas.click({ position: canvasPoint(200, 260) });
  await expect(page.getByText("物件群組")).toBeVisible();
  await page.getByRole("button", { name: "分析圖片並建立文字框" }).click();
  await expect(page.getByText("已建立文字框")).toBeVisible();
  await saveTemplateLayout(page);

  let layout = await fetchTemplatePageLayout(page, templateId);
  expect(layout.groups).toHaveLength(1);
  expect(layout.groups[0].links).toHaveLength(1);
  expect(layout.groups[0].selection_rotation).toBe(37);
  expect(layout.stickers[0]).toMatchObject(originalSticker);
  const { z_index: savedExistingZ, ...savedExistingText } = layout.text_labels.find(label => label.id === existingText.id);
  const { z_index: originalExistingZ, ...originalExistingText } = existingText;
  expect(savedExistingZ).toBeGreaterThanOrEqual(0);
  expect(originalExistingZ).toBe(1);
  expect(savedExistingText).toMatchObject(originalExistingText);
  expect(layout).not.toHaveProperty("normalized_box");
  const materialLink = layout.groups[0].links[0];
  const initialText = { ...layout.text_labels.find(label => String(label.id) === String(materialLink.text_id)) };

  await page.getByRole("button", { name: "進入群組" }).click();
  const textCenter = canvasPoint(
    initialText.x + initialText.width / 2,
    initialText.y + initialText.height / 2,
  );
  await canvas.click({ position: textCenter });
  await expect(page.getByText("純文字屬性")).toBeVisible();
  await page.locator("textarea").first().fill("保留這段文字");
  const fontSizeNumber = page.locator("label").filter({ hasText: "字級（pt）" }).locator('input[type="number"]');
  await fontSizeNumber.fill("36");
  const positionInputs = page.locator('[data-guide="property-position-size"] input[type="number"]');
  await positionInputs.nth(0).fill(String(initialText.x + 40));
  await page.getByRole("button", { name: "離開群組" }).click();

  await page.getByRole("button", { name: "重新分析並重設文字框" }).click();
  await expect(page.getByText("已重設文字框")).toBeVisible();
  await saveTemplateLayout(page);
  layout = await fetchTemplatePageLayout(page, templateId);
  const resetText = layout.text_labels.find(label => String(label.id) === String(materialLink.text_id));
  expect(resetText.text).toBe("保留這段文字");
  expect(resetText.font_size).toBe(36);
  for (const field of ["x", "y", "width", "height", "rotation"]) {
    expect(resetText[field]).toBe(initialText[field]);
  }
  expect(layout.stickers[0]).toMatchObject(originalSticker);
  expect(layout.groups[0].links).toEqual([{
    kind: "material-text-v1",
    material_id: originalSticker.id,
    text_id: resetText.id,
  }]);
  expect(layout.groups[0].selection_rotation).toBe(37);
});

test("pending image analysis is discarded when the editor changes page", async ({ page }) => {
  await loginViaApi(page);
  const { templateId, pageId: firstPageId } = await createTemplateWithLayout(
    page,
    `E2E stale material analysis ${Date.now()}`,
    baseLayout(),
  );
  const uploadResponse = await page.request.post(`/api/templates/${templateId}/stickers`, {
    multipart: { file: { name: "shared.png", mimeType: "image/png", buffer: redPng } },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploaded = await uploadResponse.json();
  const sharedSticker = {
    id: 501,
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
  for (const targetPageId of [firstPageId]) {
    const response = await page.request.put(
      `/api/templates/${templateId}/pages/${targetPageId}/layout`,
      { data: baseLayout({ stickers: [sharedSticker] }) },
    );
    expect(response.ok()).toBeTruthy();
  }
  const secondPageResponse = await page.request.post(`/api/templates/${templateId}/pages`);
  expect(secondPageResponse.ok()).toBeTruthy();
  const secondPage = await secondPageResponse.json();
  const secondLayoutResponse = await page.request.put(
    `/api/templates/${templateId}/pages/${secondPage.id}/layout`,
    { data: baseLayout({ stickers: [sharedSticker] }) },
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
      // Page switching aborts the pending browser request; that is the expected path.
    }
  });

  const canvas = await openEditor(page, templateId);
  await canvas.click({ position: canvasPoint(200, 260) });
  await page.getByRole("button", { name: "分析圖片並建立／重設文字框" }).click();
  await intercepted;
  await page.getByRole("button", { name: "第 2 頁", exact: true }).click();
  releaseResponse();
  await expect(page.getByRole("button", { name: "第 2 頁", exact: true })).toHaveClass(/bg-indigo-600/);
  await canvas.click({ position: canvasPoint(200, 260) });
  await expect(page.getByText("貼圖素材屬性")).toBeVisible();
  await expect(page.getByText("文字＋圖片群組")).toHaveCount(0);
});
