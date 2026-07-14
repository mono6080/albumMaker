// e2e 共用 helpers：登入、建模板/專案/學生、上傳與預覽抓取
// 各 spec 檔依需要具名 import
import { expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";


export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin-password-123";
export const E2E_SECRET_KEY = "e2e-secret-do-not-use";
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const fixturePath = resolve(repoRoot, "tests/fixtures/render_smoke_layout.json");
export const redPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAAIklEQVR4nGP84OHxn4ECwESJ5lEDIICJgULANGoAA8VhAAC8pQKXSjbPdAAAAABJRU5ErkJggg==",
  "base64",
);
export const bluePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAAIklEQVR4nGP0qPjwn4ECwESJ5lEDIICJgULANGoAA8VhAABNRALHqomXiwAAAABJRU5ErkJggg==",
  "base64",
);
export const uploadPngs = [redPng, bluePng, redPng, bluePng, redPng];


export async function loginViaUi(page) {
  await page.goto("/login");
  await page.getByPlaceholder("請輸入帳號").fill("admin");
  await page.getByPlaceholder("請輸入密碼").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登入" }).click();
}


export async function loginViaApi(page) {
  const token = createE2eAccessToken({ userId: 1, username: "admin", role: "admin" });
  await page.context().addCookies([{
    name: "access_token",
    value: token,
    url: "http://127.0.0.1:5173",
    httpOnly: true,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  }]);
}


export function createE2eAccessToken({ userId, username, role }) {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: String(userId),
    username,
    role,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  };
  const body = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac("sha256", E2E_SECRET_KEY).update(body).digest("base64url");
  return `${body}.${signature}`;
}


export function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}


export async function createTemplateWithLayout(page, templateName, layout) {
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


export async function createProject(page, projectName, templateId) {
  const projectResponse = await page.request.post("/api/projects/", {
    form: { name: projectName, template_id: String(templateId) },
  });
  expect(projectResponse.ok()).toBeTruthy();
  return await projectResponse.json();
}


export async function addStudents(page, projectId, names) {
  const batchResponse = await page.request.post(`/api/projects/${projectId}/students/batch`, {
    data: names,
  });
  expect(batchResponse.ok()).toBeTruthy();
  return await batchResponse.json();
}


export async function fetchProjectDetail(page, projectId) {
  const detailResponse = await page.request.get(`/api/projects/${projectId}`);
  expect(detailResponse.ok()).toBeTruthy();
  return await detailResponse.json();
}


export async function uploadStudentPhoto(page, projectId, studentId, slotId, name, buffer) {
  const uploadResponse = await page.request.post(
    `/api/projects/${projectId}/students/${studentId}/pages/0/photos/${slotId}`,
    {
      multipart: {
        file: {
          name,
          mimeType: "image/png",
          buffer,
        },
      },
    },
  );
  expect(uploadResponse.ok()).toBeTruthy();
  return await uploadResponse.json();
}


export async function fetchStudentPreview(page, projectId, studentId, cacheBuster = Date.now()) {
  const previewResponse = await page.request.get(
    `/api/projects/${projectId}/students/${studentId}/preview/0?t=${cacheBuster}`,
  );
  expect(previewResponse.ok()).toBeTruthy();
  expect(previewResponse.headers()["content-type"]).toContain("image/jpeg");
  expect(previewResponse.headers()["cache-control"]).toContain("max-age");
  const body = await previewResponse.body();
  expect(body[0]).toBe(0xff);
  expect(body[1]).toBe(0xd8);
  return previewResponse;
}


export async function loadFixtureLayout() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}


export function layoutWithTwoPhotoSlots(layout) {
  return layoutWithPhotoSlots(layout, 2);
}


export function layoutWithPhotoSlots(layout, count) {
  const nextLayout = JSON.parse(JSON.stringify(layout));
  const firstSlot = nextLayout.photo_slots[0];
  nextLayout.photo_slots = Array.from({ length: count }, (_, index) => ({
      ...firstSlot,
      id: index + 1,
      x: firstSlot.x + (index % 2) * (firstSlot.width + 40),
      y: firstSlot.y + Math.floor(index / 2) * (firstSlot.height + 36),
    }));
  return nextLayout;
}


export async function saveTemplateLayout(page) {
  const saveButton = page.getByRole("button", { name: "儲存", exact: true });
  const saveResponse = page.waitForResponse(
    response => (
      response.request().method() === "PUT"
      && /^\/api\/templates\/\d+\/pages\/?$/.test(new URL(response.url()).pathname)
      && response.ok()
    ),
  );
  await saveButton.click();
  await saveResponse;
  await expect.poll(async () => (
    await saveButton.count() === 0 || await saveButton.isEnabled()
  )).toBeTruthy();
}


export async function closeProductGuide(page) {
  await page.locator(".driver-popover-close-btn").click();
  await expect(page.locator(".driver-popover")).toHaveCount(0);
}

// dnd-kit 的 MouseSensor 需要漸進式滑鼠移動才會啟動與計算 over 目標，
// Playwright 內建 dragTo 只做單步跳躍，無法觸發。
export async function dragWithSteps(page, sourceLocator, targetLocator) {
  const sourceBox = await sourceLocator.boundingBox();
  const targetBox = await targetLocator.boundingBox();
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (endX - startX) * i / steps, startY + (endY - startY) * i / steps);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
}


export async function waitForResponseAfter(page, predicate, action) {
  const responsePromise = page.waitForResponse(predicate);
  await action();
  await responsePromise;
}


export async function fetchTemplatePageLayout(page, templateId) {
  const detail = await fetchTemplateDetail(page, templateId);
  return detail.pages[0].layout;
}


export async function fetchTemplateDetail(page, templateId) {
  const detailResponse = await page.request.get(`/api/templates/${templateId}`);
  expect(detailResponse.ok()).toBeTruthy();
  return await detailResponse.json();
}
