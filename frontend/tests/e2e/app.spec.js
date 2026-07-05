import { expect, test } from "@playwright/test";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";


const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin-password-123";
const E2E_SECRET_KEY = "e2e-secret-do-not-use";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixturePath = resolve(repoRoot, "tests/fixtures/render_smoke_layout.json");
const redPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAAIklEQVR4nGP84OHxn4ECwESJ5lEDIICJgULANGoAA8VhAAC8pQKXSjbPdAAAAABJRU5ErkJggg==",
  "base64",
);
const bluePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAYAAABr5z2BAAAAIklEQVR4nGP0qPjwn4ECwESJ5lEDIICJgULANGoAA8VhAABNRALHqomXiwAAAABJRU5ErkJggg==",
  "base64",
);
const uploadPngs = [redPng, bluePng, redPng, bluePng, redPng];


async function loginViaUi(page) {
  await page.goto("/login");
  await page.getByPlaceholder("請輸入帳號").fill("admin");
  await page.getByPlaceholder("請輸入密碼").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登入" }).click();
}


async function loginViaApi(page) {
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


function createE2eAccessToken({ userId, username, role }) {
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


function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
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


async function createProject(page, projectName, templateId) {
  const projectResponse = await page.request.post("/api/projects/", {
    form: { name: projectName, template_id: String(templateId) },
  });
  expect(projectResponse.ok()).toBeTruthy();
  return await projectResponse.json();
}


async function addStudents(page, projectId, names) {
  const batchResponse = await page.request.post(`/api/projects/${projectId}/students/batch`, {
    data: names,
  });
  expect(batchResponse.ok()).toBeTruthy();
  return await batchResponse.json();
}


async function fetchProjectDetail(page, projectId) {
  const detailResponse = await page.request.get(`/api/projects/${projectId}`);
  expect(detailResponse.ok()).toBeTruthy();
  return await detailResponse.json();
}


async function uploadStudentPhoto(page, projectId, studentId, slotId, name, buffer) {
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


async function fetchStudentPreview(page, projectId, studentId, cacheBuster = Date.now()) {
  const previewResponse = await page.request.get(
    `/api/projects/${projectId}/students/${studentId}/preview/0?t=${cacheBuster}`,
  );
  expect(previewResponse.ok()).toBeTruthy();
  expect(previewResponse.headers()["content-type"]).toContain("image/jpeg");
  expect(previewResponse.headers()["cache-control"]).toContain("no-store");
  const body = await previewResponse.body();
  expect(body[0]).toBe(0xff);
  expect(body[1]).toBe(0xd8);
  return previewResponse;
}


async function loadFixtureLayout() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}


function layoutWithTwoPhotoSlots(layout) {
  return layoutWithPhotoSlots(layout, 2);
}


function layoutWithPhotoSlots(layout, count) {
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


async function saveTemplateLayout(page) {
  const saveButton = page.getByRole("button", { name: "儲存" });
  const saveResponse = page.waitForResponse(
    response => response.url().includes("/layout") && response.request().method() === "PUT" && response.ok(),
  );
  await saveButton.click();
  await saveResponse;
  await expect(saveButton).toBeEnabled();
}


async function closeProductGuide(page) {
  await page.locator(".driver-popover-close-btn").click();
  await expect(page.locator(".driver-popover")).toHaveCount(0);
}

// dnd-kit 的 MouseSensor 需要漸進式滑鼠移動才會啟動與計算 over 目標，
// Playwright 內建 dragTo 只做單步跳躍，無法觸發。
async function dragWithSteps(page, sourceLocator, targetLocator) {
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


async function waitForResponseAfter(page, predicate, action) {
  const responsePromise = page.waitForResponse(predicate);
  await action();
  await responsePromise;
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


test("admin can create a project and batch students from the browser", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 專案模板 ${Date.now()}`;
  const projectSuffix = `蘋果班 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);

  await page.goto("/projects");
  await page.getByRole("button", { name: "新建專案" }).click();
  await page.getByLabel("選擇模板").selectOption(String(templateId));
  await page.getByPlaceholder("例：東區校 10階A").fill(projectSuffix);
  await page.getByRole("button", { name: "建立" }).click();

  const projectName = `${templateName} ${projectSuffix}`;
  await expect(page.getByText(projectName)).toBeVisible();

  const projectSearch = page.getByLabel("搜尋專案");
  await projectSearch.fill("沒有這個專案");
  await expect(page.getByText(`沒有符合「沒有這個專案」的專案`)).toBeVisible();
  await expect(page.getByText(projectName)).toHaveCount(0);
  await projectSearch.fill(projectSuffix);
  await expect(page.getByText(projectName)).toBeVisible();
  await expect(page.getByText(/找到 1 \/ \d+ 個專案/)).toBeVisible();
  await page.getByRole("button", { name: "清除搜尋" }).click();
  await expect(projectSearch).toHaveValue("");
  await expect(page.getByText(projectName)).toBeVisible();

  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("新建專案");
  await expect(page.locator(".driver-popover")).toContainText("每個班級每個月建立");
  await closeProductGuide(page);

  await page.locator(".group").filter({ hasText: projectName }).first().getByRole("link", { name: "專案設定" }).click();
  await expect(page.getByText(projectName)).toBeVisible();
  await expect(page.getByText("新增學生名單")).toBeVisible();

  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("新增學生名單");
  await expect(page.locator(".driver-popover")).toContainText("一行一位");
  await closeProductGuide(page);

  await page.getByRole("button", { name: "文字", exact: true }).click();
  await expect(page.getByText("樣版預覽")).toBeVisible();
  const projectTextArea = page.locator('[data-guide="batch-text-fields"] textarea').first();
  await expect(projectTextArea).toHaveValue("Default label");
  await projectTextArea.fill("班級：");
  await page.locator('[data-guide="batch-text-fields"]').getByRole("button", { name: "插入 {name}" }).click();
  await expect(projectTextArea).toHaveValue("班級：{name}");
  await projectTextArea.fill("");
  await expect(projectTextArea).toHaveValue("");
  await waitForResponseAfter(
    page,
    response => response.url().includes("/label_texts") && response.request().method() === "PUT" && response.ok(),
    () => projectTextArea.fill("共用 {name}"),
  );

  await page.getByRole("button", { name: "登記", exact: true }).click();
  await page.getByPlaceholder("每行一位，或用逗號 / 頓號分隔").fill("Alice\nBob\nAlice");
  await page.getByRole("button", { name: "新增" }).click();
  await expect(page.getByText("已登記學生（2 位）")).toBeVisible();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();

  const projectsResponse = await page.request.get("/api/projects/");
  const projects = await projectsResponse.json();
  const project = projects.find(item => item.name === projectName);
  expect(project.student_count).toBe(2);
  const projectDetail = await fetchProjectDetail(page, project.id);
  const alice = projectDetail.students.find(item => item.name === "Alice");
  const bob = projectDetail.students.find(item => item.name === "Bob");
  expect(alice).toBeTruthy();
  expect(bob).toBeTruthy();

  await page.locator('[data-guide="batch-review-link"]').click();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("輸出進度");
  await expect(page.locator(".driver-popover")).toContainText("已產生 PDF");
  await closeProductGuide(page);

  await page.locator('[data-guide="review-student-card"]').filter({ hasText: "Alice" }).getByRole("link", { name: "編輯" }).click();
  await expect(page.getByText("照片管理")).toBeVisible();
  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("預覽與頁面");
  await expect(page.locator(".driver-popover")).toContainText("左側會顯示");
  await closeProductGuide(page);

  const studentTextArea = page.locator('[data-guide="student-text-fields"] textarea').first();
  await studentTextArea.fill("學生：");
  await page.locator('[data-guide="student-text-fields"]').getByRole("button", { name: "插入 {name}" }).click();
  await expect(studentTextArea).toHaveValue("學生：{name}");
  await studentTextArea.fill("");
  await expect(studentTextArea).toHaveValue("");
  await waitForResponseAfter(
    page,
    response => response.url().includes("/batch/texts") && response.request().method() === "PUT" && response.ok(),
    () => studentTextArea.fill("個人 {name}"),
  );

  await expect(page.getByLabel("切換學生")).toHaveValue(String(alice.id));
  await page.getByRole("button", { name: "下一位" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/students/${bob.id}/edit`));
  await expect(page.getByRole("heading", { name: "Bob", level: 1 })).toBeVisible();
  await expect(page.getByLabel("切換學生")).toHaveValue(String(bob.id));
  await page.getByLabel("切換學生").selectOption(String(alice.id));
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/students/${alice.id}/edit`));
  await expect(page.getByRole("heading", { name: "Alice", level: 1 })).toBeVisible();
});


test("project shared photo upload applies one slot to every student", async ({ page }) => {
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 共用照片模板 ${Date.now()}`;
  const projectName = `E2E 共用照片專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Group Alice", "Group Bob"]);

  await page.goto(`/projects/${project.id}/batch`);
  await expect(page.getByText(projectName)).toBeVisible();
  await page.getByRole("button", { name: "照片", exact: true }).click();
  await expect(page.getByText("所有人同一張")).toBeVisible();

  await page
    .locator('[data-guide="batch-shared-photo-slots"]')
    .getByRole("button", { name: /P1·2/ })
    .click();

  await page
    .locator('[data-guide="batch-shared-photo-upload"] input[type="file"]')
    .setInputFiles({ name: "group.png", mimeType: "image/png", buffer: bluePng });

  const uploadResponse = page.waitForResponse(
    response => response.url().includes("/photos/shared/pages/0/slots/2") && response.ok(),
  );
  await page.getByRole("button", { name: "套用到全班" }).click();
  await uploadResponse;
  await expect(page.getByText("已套用到 2 位學生")).toBeVisible();

  let sharedPaths = [];
  await expect.poll(async () => {
    const detail = await fetchProjectDetail(page, project.id);
    sharedPaths = detail.students.map(student => student.pages_data?.[0]?.photos?.["2"]?.path ?? null);
    return sharedPaths.filter(Boolean).length;
  }, { timeout: 20_000 }).toBe(2);

  expect(sharedPaths[0]).toContain("student");
  expect(sharedPaths[0]).toContain("p0_slot2_group.png");
  expect(sharedPaths[1]).toContain("p0_slot2_group.png");
  expect(sharedPaths[0]).not.toBe(sharedPaths[1]);

  const detail = await fetchProjectDetail(page, project.id);
  for (const student of detail.students) {
    await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
    await expect(page.getByText("照片管理")).toBeVisible();
    const slot = page.locator('[data-guide="student-photo-cell"][data-slot-id="2"]');
    await expect(slot.locator('[data-guide="photo-slot-image"]')).toHaveAttribute(
      "src",
      /\/photos\/2\/thumbnail\?v=.*group\.png/,
    );
  }
});


test("student photo uploads, preview cache, and mapping swaps work through storage", async ({ page }) => {
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 照片模板 ${Date.now()}`;
  const projectName = `E2E 照片專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Photo Alice"]);

  let detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "Photo Alice");
  expect(student).toBeTruthy();

  const firstPhoto = await uploadStudentPhoto(page, project.id, student.id, 1, "first.png", redPng);
  const secondPhoto = await uploadStudentPhoto(page, project.id, student.id, 2, "second.png", bluePng);

  const firstPreview = await fetchStudentPreview(page, project.id, student.id);
  expect(firstPreview.headers()["x-preview-cache"]).toBe("MISS");
  const cachedPreview = await fetchStudentPreview(page, project.id, student.id);
  expect(cachedPreview.headers()["x-preview-cache"]).toBe("HIT");

  const swapResponse = await page.request.put(`/api/projects/${project.id}/students/${student.id}/photos/mapping`, {
    data: {
      pages: {
        "0": {
          "1": { path: secondPhoto.path, scale: 1.15, offset_x: 0.05, offset_y: 0 },
          "2": { path: firstPhoto.path, scale: 1.25, offset_x: -0.05, offset_y: 0 },
        },
      },
    },
  });
  expect(swapResponse.ok()).toBeTruthy();
  const swapPayload = await swapResponse.json();
  expect(swapPayload.renames).toEqual({});

  detail = await fetchProjectDetail(page, project.id);
  const photos = detail.students.find(item => item.id === student.id).pages_data[0].photos;
  expect(photos["1"].path).toBe(secondPhoto.path);
  expect(photos["2"].path).toBe(firstPhoto.path);
  expect(photos["1"].scale).toBe(1.15);
  expect(photos["2"].scale).toBe(1.25);

  const swappedPreview = await fetchStudentPreview(page, project.id, student.id);
  expect(swappedPreview.headers()["x-preview-cache"]).toBe("MISS");
  const swappedCachedPreview = await fetchStudentPreview(page, project.id, student.id);
  expect(swappedCachedPreview.headers()["x-preview-cache"]).toBe("HIT");

  const swappedFirstPhoto = await page.request.get(
    `/api/projects/${project.id}/students/${student.id}/pages/0/photos/1`,
  );
  expect(swappedFirstPhoto.ok()).toBeTruthy();
  expect(swappedFirstPhoto.headers()["content-type"]).toContain("image/png");
});


test("student multi-select upload only fills remaining empty slots", async ({ page }) => {
  const layout = layoutWithPhotoSlots(await loadFixtureLayout(), 4);
  const templateName = `E2E 多選模板 ${Date.now()}`;
  const projectName = `E2E 多選專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Multi Alice"]);

  const initialDetail = await fetchProjectDetail(page, project.id);
  const student = initialDetail.students.find(item => item.name === "Multi Alice");
  expect(student).toBeTruthy();
  const existingPhoto = await uploadStudentPhoto(page, project.id, student.id, 1, "existing.png", redPng);

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();

  const uploadInput = page.locator('[data-guide="student-photo-manager"] input[type="file"][multiple]');
  await uploadInput.setInputFiles(
    uploadPngs.map((buffer, index) => ({
      name: `multi-${index + 1}.png`,
      mimeType: "image/png",
      buffer,
    })),
  );
  await expect(page.getByText("只上傳前 3 張，已略過 2 張")).toBeVisible();

  await expect.poll(async () => {
    const detail = await fetchProjectDetail(page, project.id);
    const photos = detail.students.find(item => item.id === student.id)?.pages_data?.[0]?.photos ?? {};
    return Object.fromEntries(
      Object.entries(photos).map(([slotId, value]) => [
        slotId,
        typeof value === "string" ? value : value.path,
      ]),
    );
  }, { timeout: 20_000 }).toEqual({
    "1": existingPhoto.path,
    "2": expect.stringContaining("p0_slot2_multi-1.png"),
    "3": expect.stringContaining("p0_slot3_multi-2.png"),
    "4": expect.stringContaining("p0_slot4_multi-3.png"),
  });

  await expect(page.locator('[data-guide="student-photo-grid"] img')).toHaveCount(4);
});


test("student photo manager keeps thumbnails fresh after same-name replacement", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 縮圖更新模板 ${Date.now()}`;
  const projectName = `E2E 縮圖更新專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Thumb Alice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "Thumb Alice");
  expect(student).toBeTruthy();
  await uploadStudentPhoto(page, project.id, student.id, 1, "same-name.png", redPng);

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();
  const image = page.locator('[data-guide="photo-slot-image"]').first();
  await expect(image).toHaveAttribute("src", /\/thumbnail\?v=/);
  const initialSrc = await image.getAttribute("src");

  await page
    .locator('[data-guide="student-photo-cell"][data-slot-id="1"] input[type="file"]:not([multiple])')
    .setInputFiles({ name: "same-name.png", mimeType: "image/png", buffer: bluePng });

  await expect.poll(async () => {
    const src = await image.getAttribute("src");
    return src?.includes("/thumbnail") ? src : initialSrc;
  }, { timeout: 20_000 }).not.toBe(initialSrc);

  const updatedSrc = await image.getAttribute("src");
  expect(updatedSrc).toContain("/thumbnail?v=");
  expect(updatedSrc).toContain("same-name.png");
});


test("student photo manager resyncs slot URLs after drag swap", async ({ page }) => {
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 交換縮圖模板 ${Date.now()}`;
  const projectName = `E2E 交換縮圖專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Swap Alice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "Swap Alice");
  expect(student).toBeTruthy();
  const firstPhoto = await uploadStudentPhoto(page, project.id, student.id, 1, "first.png", redPng);
  const secondPhoto = await uploadStudentPhoto(page, project.id, student.id, 2, "second.png", bluePng);

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();
  const firstCell = page.locator('[data-guide="student-photo-cell"][data-slot-id="1"]');
  const secondCell = page.locator('[data-guide="student-photo-cell"][data-slot-id="2"]');
  await expect(firstCell.locator('[data-guide="photo-slot-image"]')).toHaveAttribute("src", /\/photos\/1\/thumbnail\?v=/);
  await expect(secondCell.locator('[data-guide="photo-slot-image"]')).toHaveAttribute("src", /\/photos\/2\/thumbnail\?v=/);

  const mappingResponse = page.waitForResponse(
    response => response.url().includes("/photos/mapping") && response.request().method() === "PUT" && response.ok(),
  );
  await dragWithSteps(page, firstCell, secondCell);
  await mappingResponse;

  await expect.poll(async () => {
    const src = await firstCell.locator('[data-guide="photo-slot-image"]').getAttribute("src");
    return src ?? "";
  }, { timeout: 20_000 }).toContain("/photos/1/thumbnail");
  await expect.poll(async () => {
    const src = await secondCell.locator('[data-guide="photo-slot-image"]').getAttribute("src");
    return src ?? "";
  }, { timeout: 20_000 }).toContain("/photos/2/thumbnail");

  const firstSrc = await firstCell.locator('[data-guide="photo-slot-image"]').getAttribute("src");
  const secondSrc = await secondCell.locator('[data-guide="photo-slot-image"]').getAttribute("src");
  expect(firstSrc).toContain("p0_slot2_second.png");
  expect(secondSrc).toContain("p0_slot1_first.png");

  const swappedDetail = await fetchProjectDetail(page, project.id);
  const photos = swappedDetail.students.find(item => item.id === student.id).pages_data[0].photos;
  expect(photos["1"].path).toBe(secondPhoto.path);
  expect(photos["2"].path).toBe(firstPhoto.path);
});


test("student photo manager bordered thumbnail geometry matches preview renderer", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 縮圖裁切模板 ${Date.now()}`;
  const projectName = `E2E 縮圖裁切專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Crop Alice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "Crop Alice");
  expect(student).toBeTruthy();
  const photo = await uploadStudentPhoto(page, project.id, student.id, 1, "crop.png", redPng);
  const mappingResponse = await page.request.put(`/api/projects/${project.id}/students/${student.id}/photos/mapping`, {
    data: {
      pages: {
        "0": {
          "1": { path: photo.path, scale: 1.6, offset_x: 0.6, offset_y: -0.5 },
        },
      },
    },
  });
  expect(mappingResponse.ok()).toBeTruthy();

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();
  const image = page.locator('[data-guide="photo-slot-image"]').first();
  await expect(image).toHaveAttribute("src", /\/thumbnail\?v=/);
  await expect.poll(async () => {
    return await image.evaluate(img => img.style.position);
  }, { timeout: 10_000 }).toBe("absolute");

  const metrics = await page.locator('[data-guide="photo-slot-crop"]').first().evaluate((cropElement) => {
    const cardElement = cropElement.closest('[data-guide="photo-slot-card"]');
    const imageElement = cropElement.querySelector('[data-guide="photo-slot-image"]');
    const crop = cropElement.getBoundingClientRect();
    const card = cardElement.getBoundingClientRect();
    const imageRect = imageElement.getBoundingClientRect();
    return {
      cardW: card.width,
      cardH: card.height,
      cropW: crop.width,
      cropH: crop.height,
      cropTop: crop.top - card.top,
      cropLeft: crop.left - card.left,
      cropBottom: card.bottom - crop.bottom,
      cropRight: card.right - crop.right,
      imageW: imageRect.width,
      imageH: imageRect.height,
      imageLeft: imageRect.left - crop.left,
      imageTop: imageRect.top - crop.top,
    };
  });

  const scale = metrics.cardH / 120;
  expect(Math.abs(metrics.cropTop - 8 * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.cropBottom - 24 * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.cropLeft - 8 * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.cropRight - 8 * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.cropW - 134 * scale)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(metrics.cropH - 88 * scale)).toBeLessThanOrEqual(1.5);
  expect(metrics.imageW).toBeGreaterThan(metrics.cropW);
  expect(metrics.imageH).toBeGreaterThan(metrics.cropH);
  expect(metrics.imageLeft).toBeLessThan(0);
  expect(metrics.imageTop).toBeLessThan(0);
});


test("student photo crop modal stays centered on mobile width", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 手機裁切模板 ${Date.now()}`;
  const projectName = `E2E 手機裁切專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Mobile Crop Alice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "Mobile Crop Alice");
  expect(student).toBeTruthy();
  await uploadStudentPhoto(page, project.id, student.id, 1, "mobile-crop.png", redPng);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();

  const firstCell = page.locator('[data-guide="student-photo-cell"][data-slot-id="1"]');
  await firstCell.hover();
  await firstCell.locator('button[title="位移/縮放"]').click({ force: true });

  const crop = page.locator('[data-guide="photo-edit-crop"]');
  await expect(crop).toBeVisible();
  await expect(crop.locator("img")).toHaveCSS("opacity", "1");

  const metrics = await crop.evaluate((cropElement) => {
    const cropRect = cropElement.getBoundingClientRect();
    const imageRect = cropElement.querySelector("img").getBoundingClientRect();
    return {
      viewportW: window.innerWidth,
      cropCenterX: cropRect.left + cropRect.width / 2,
      cropW: cropRect.width,
      imageCenterX: imageRect.left + imageRect.width / 2,
      imageCenterY: imageRect.top + imageRect.height / 2,
      cropCenterY: cropRect.top + cropRect.height / 2,
    };
  });

  expect(Math.abs(metrics.cropCenterX - metrics.viewportW / 2)).toBeLessThanOrEqual(1);
  expect(metrics.cropW).toBeLessThanOrEqual(metrics.viewportW - 32);
  expect(Math.abs(metrics.imageCenterX - metrics.cropCenterX)).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.imageCenterY - metrics.cropCenterY)).toBeLessThanOrEqual(1);
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


test.describe("mobile student edit layout", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });

  test("mobile photo, text, and preview panels stay usable without overflow", async ({ page }) => {
    const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
    const templateName = `E2E 手機模板 ${Date.now()}`;
    const projectName = `E2E 手機專案 ${Date.now()}`;

    await loginViaApi(page);
    const { templateId } = await createTemplateWithLayout(page, templateName, layout);
    const project = await createProject(page, projectName, templateId);
    await addStudents(page, project.id, ["Mobile Alice"]);

    const detail = await fetchProjectDetail(page, project.id);
    const student = detail.students.find(item => item.name === "Mobile Alice");
    expect(student).toBeTruthy();

    await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
    await expect(page.getByText("照片管理")).toBeVisible();
    await expect(page.locator('[data-guide="student-photo-grid"]')).toBeVisible();

    const uploadInput = page.locator('[data-guide="student-photo-manager"] input[type="file"][multiple]');
    await uploadInput.setInputFiles([
      { name: "mobile-1.png", mimeType: "image/png", buffer: redPng },
      { name: "mobile-2.png", mimeType: "image/png", buffer: bluePng },
    ]);

    await expect.poll(async () => {
      const projectDetail = await fetchProjectDetail(page, project.id);
      return Object.keys(
        projectDetail.students.find(item => item.id === student.id)?.pages_data?.[0]?.photos ?? {},
      ).length;
    }, { timeout: 20_000 }).toBe(2);
    await expect(page.locator('[data-guide="student-photo-grid"] img')).toHaveCount(2);

    const firstCell = page.locator('[data-guide="student-photo-cell"][data-slot-id="1"]');
    await firstCell.tap();
    await expect.poll(async () => await firstCell.locator("button").count(), { timeout: 10_000 }).toBe(5);

    await page.getByRole("button", { name: "文字" }).tap();
    await expect(page.locator('[data-guide="student-text-panel-mobile"]')).toBeVisible();
    await expect(page.locator('[data-guide="student-text-panel-mobile"] textarea').first()).toBeVisible();

    await page.getByRole("button", { name: "預覽" }).tap();
    await expect(page.locator('[data-guide="student-preview-panel"]')).toBeVisible();
    await expect(page.locator('[data-guide="student-page-preview"] img')).toBeVisible();

    const overflow = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 2);
    expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewportWidth + 2);
  });
});
