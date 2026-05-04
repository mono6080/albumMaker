import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const ADMIN_PASSWORD = "admin-password-123";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = resolve(repoRoot, "tests/fixtures/render_smoke_layout.json");


async function loginViaUi(page) {
  await page.goto("/login");
  await page.getByPlaceholder("請輸入帳號").fill("admin");
  await page.getByPlaceholder("請輸入密碼").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登入" }).click();
}


async function loginViaApi(page) {
  const response = await page.request.post("/api/auth/login", {
    form: { username: "admin", password: ADMIN_PASSWORD },
  });
  expect(response.ok()).toBeTruthy();
}


async function createTemplateWithLayout(page, templateName, layout) {
  const templateResponse = await page.request.post("/api/templates/", {
    form: { name: templateName },
  });
  expect(templateResponse.ok()).toBeTruthy();
  const template = await templateResponse.json();

  const pageResponse = await page.request.post(`/api/templates/${template.id}/pages`);
  expect(pageResponse.ok()).toBeTruthy();
  const templatePage = await pageResponse.json();

  const layoutResponse = await page.request.put(`/api/templates/${template.id}/pages/${templatePage.id}/layout`, {
    data: layout,
  });
  expect(layoutResponse.ok()).toBeTruthy();

  return { templateId: template.id, pageId: templatePage.id };
}


async function loadFixtureLayout() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}


async function saveTemplateLayout(page) {
  const saveResponse = page.waitForResponse(
    response => response.url().includes("/layout") && response.request().method() === "PUT" && response.ok(),
  );
  await page.getByRole("button", { name: "儲存" }).click();
  await saveResponse;
}


async function fetchTemplatePageLayout(page, templateId) {
  const detailResponse = await page.request.get(`/api/templates/${templateId}`);
  const detail = await detailResponse.json();
  return detail.pages[0].layout;
}


test("admin can create a template and place canvas elements", async ({ page }) => {
  const templateName = `E2E 模板 ${Date.now()}`;

  await loginViaUi(page);
  await expect(page.getByRole("heading", { name: "模板管理" })).toBeVisible();

  await page.getByPlaceholder(/模板名稱/).fill(templateName);
  await page.getByRole("button", { name: "建立" }).click();
  await expect(page.getByText(templateName)).toBeVisible();

  const templatesResponse = await page.request.get("/api/templates/");
  const templates = await templatesResponse.json();
  const template = templates.find(item => item.name === templateName);
  expect(template).toBeTruthy();

  await page.goto(`/templates/${template.id}/edit`);
  await page.getByRole("button", { name: "新增第一頁" }).click();
  await expect(page.getByText("模板編輯器")).toBeVisible();
  await expect(page.getByRole("button", { name: /第 1 頁/ })).toBeVisible();

  const canvas = page.locator(".konvajs-content canvas").first();
  await expect(canvas).toBeVisible();

  await page.getByRole("button", { name: /照片格/ }).click();
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

  await page.getByRole("button", { name: "雙頁預覽" }).click();
  await expect(page.getByRole("dialog", { name: "雙頁預覽" })).toBeVisible();
  await expect(page.getByRole("img", { name: "雙頁合併預覽" })).toBeVisible();
  await page.getByRole("button", { name: "關閉雙頁預覽" }).click();
  await expect(page.getByRole("dialog", { name: "雙頁預覽" })).toHaveCount(0);
});


test("admin can create a project and batch students from the browser", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 專案模板 ${Date.now()}`;
  const projectSuffix = `蘋果班 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);

  await page.goto("/projects");
  await page.getByRole("button", { name: "新建專案" }).click();
  await page.locator("select").selectOption(String(templateId));
  await page.getByPlaceholder("例：蘋果班 2026.01").fill(projectSuffix);
  await page.getByRole("button", { name: "建立" }).click();

  const projectName = `${templateName} ${projectSuffix}`;
  await expect(page.getByText(projectName)).toBeVisible();

  await page.locator(".group").filter({ hasText: projectName }).first().getByRole("link", { name: "專案設定" }).click();
  await expect(page.getByText(projectName)).toBeVisible();
  await expect(page.getByText("新增學生名單")).toBeVisible();

  await page.getByPlaceholder("每行一位，或用逗號 / 頓號分隔").fill("Alice\nBob\nAlice");
  await page.getByRole("button", { name: "新增" }).click();
  await expect(page.getByText("已登記學生（2 位）")).toBeVisible();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();

  const projectsResponse = await page.request.get("/api/projects/");
  const projects = await projectsResponse.json();
  const project = projects.find(item => item.name === projectName);
  expect(project.student_count).toBe(2);
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
