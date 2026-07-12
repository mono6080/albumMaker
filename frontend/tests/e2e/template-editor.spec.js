// 模板編輯器 e2e：畫布元素放置與 PIL 渲染 parity
import { expect, test } from "@playwright/test";
import {
  loginViaUi,
  loginViaApi,
  createTemplateWithLayout,
  loadFixtureLayout,
  saveTemplateLayout,
  closeProductGuide,
  fetchTemplatePageLayout,
} from "./helpers.js";


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
  await expect(page.getByText("純文字屬性")).toBeVisible();
  const templateTextArea = page.locator("textarea").first();
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
      bubbleDiff: pixelDiff(readPixel(canvasContext, 308, 70), readPixel(previewContext, 308, 70)),
      canvasTextPixels: countNonWhite(canvasContext, { x: 58, y: 250, width: 300, height: 82 }),
      previewTextPixels: countNonWhite(previewContext, { x: 58, y: 250, width: 300, height: 82 }),
      canvasFooterPixels: countNonWhite(canvasContext, { x: 36, y: 1058, width: 250, height: 44 }),
      previewFooterPixels: countNonWhite(previewContext, { x: 36, y: 1058, width: 250, height: 44 }),
    };
  }, `/api/templates/${templateId}/pages/${pageId}/preview`);

  expect(comparison.photoDiff).toBeLessThanOrEqual(14);
  expect(comparison.bubbleDiff).toBeLessThanOrEqual(18);
  expect(comparison.canvasTextPixels).toBeGreaterThan(20);
  expect(comparison.previewTextPixels).toBeGreaterThan(20);
  expect(comparison.canvasFooterPixels).toBeGreaterThan(10);
  expect(comparison.previewFooterPixels).toBeGreaterThan(10);
});
