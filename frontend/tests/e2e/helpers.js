// e2e 共用 helpers：登入、建模板/專案/學生、上傳與預覽抓取
// 各 spec 檔依需要具名 import
import { expect } from "@playwright/test";
import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";


export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin-password-123";
export const E2E_SECRET_KEY = "e2e-secret-do-not-use";
// worker 是獨立 process，這個模組層變數天然是 worker-local；由 fixtures.js 設定
let workerBaseUrl = null;
export function setE2eBaseUrl(url) { workerBaseUrl = url; }
export function e2eBaseUrl() {
  return workerBaseUrl ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
}
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
    url: e2eBaseUrl(),
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


export async function createClassroomFixture(page, department, memberNames = []) {
  const fixtureId = randomUUID().replaceAll("-", "");
  const teacherPassword = "e2e-classroom-teacher-password";
  const teacherResponse = await page.request.post("/api/users/", {
    data: {
      username: `e2e_teacher_${fixtureId}`,
      display_name: `E2E 帶班老師 ${fixtureId.slice(0, 8)}`,
      password: teacherPassword,
      role: "teacher",
    },
  });
  expect(teacherResponse.ok()).toBeTruthy();
  const teacher = await teacherResponse.json();

  const campusResponse = await page.request.post("/api/organization/campuses", {
    data: { name: `E2E 分校 ${fixtureId.slice(0, 8)}` },
  });
  expect(campusResponse.ok()).toBeTruthy();
  const campus = await campusResponse.json();

  const classroomResponse = await page.request.post("/api/organization/classrooms", {
    data: {
      campus_id: campus.id,
      department,
      name: `E2E 班級 ${fixtureId.slice(0, 8)}`,
    },
  });
  expect(classroomResponse.ok()).toBeTruthy();
  const classroom = await classroomResponse.json();

  const teachersResponse = await page.request.put(
    `/api/organization/classrooms/${classroom.id}/teachers`,
    { data: { teachers: [{ teacher_id: teacher.id, duty: "lead" }] } },
  );
  expect(teachersResponse.ok()).toBeTruthy();

  if (memberNames.length > 0) {
    const membersResponse = await page.request.post(
      `/api/organization/classrooms/${classroom.id}/members/batch`,
      {
        data: {
          members: memberNames.map(member => (
            typeof member === "string" ? { name: member } : member
          )),
        },
      },
    );
    expect(membersResponse.ok()).toBeTruthy();
  }

  return { teacher, teacherPassword, campus, classroom };
}


export async function getCreatableWorkSlot(page, classroomId, templateId) {
  const classroomsResponse = await page.request.get("/api/organization/my-classrooms");
  expect(classroomsResponse.ok()).toBeTruthy();
  const payload = await classroomsResponse.json();
  const classroom = payload.classrooms.find(item => item.id === classroomId);
  expect(classroom, `找不到測試班級 ${classroomId}`).toBeTruthy();
  const workSlot = classroom.work_slots.find(slot => (
    slot.can_create_project && slot.template_ids.includes(templateId)
  ));
  expect(workSlot, `班級 ${classroomId} 沒有模板 ${templateId} 的可開工工作格`).toBeTruthy();
  return workSlot;
}


export async function createProject(page, projectName, templateId, memberNames = []) {
  const templateResponse = await page.request.get(`/api/templates/${templateId}`);
  expect(templateResponse.ok()).toBeTruthy();
  const template = await templateResponse.json();
  expect(template.department).toBeTruthy();

  const { teacher, classroom } = await createClassroomFixture(
    page,
    template.department,
    memberNames,
  );
  const workSlot = await getCreatableWorkSlot(page, classroom.id, templateId);

  const projectResponse = await page.request.post(
    `/api/organization/classrooms/${classroom.id}/projects`,
    {
      data: {
        name: projectName,
        template_id: templateId,
        owner_id: teacher.id,
        work_slot_id: workSlot.id,
      },
    },
  );
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json();
  expect(project.classroom_id).toBe(classroom.id);
  return project;
}


export async function fetchProjectDetail(page, projectId) {
  const detailResponse = await page.request.get(`/api/projects/${projectId}`);
  expect(detailResponse.ok()).toBeTruthy();
  return await detailResponse.json();
}


export async function uploadStudentPhoto(page, projectId, studentId, slotId, name, buffer) {
  const project = await fetchProjectDetail(page, projectId);
  const uploadResponse = await page.request.post(
    `/api/projects/${projectId}/students/${studentId}/pages/0/photos/${slotId}`
      + `?expected_template_revision=${project.template_revision}`,
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
  expect(previewResponse.headers()["cache-control"]).toBe(
    "private, no-cache, must-revalidate",
  );
  const body = await previewResponse.body();
  // JPEG SOI + APP marker：預覽早已改輸出 JPEG，這裡原本還在驗 PNG magic bytes
  expect(body.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
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
  await expect(saveButton).toBeEnabled();
  await expect(saveButton).toHaveAttribute("data-dirty", "true");
  const saveResponse = page.waitForResponse(
    response => (
      response.request().method() === "PUT"
      && /^\/api\/templates\/\d+\/pages\/?$/.test(new URL(response.url()).pathname)
    ),
  );
  await saveButton.click();
  const response = await saveResponse;
  expect(
    response.ok(),
    `儲存模板回應 ${response.status()}: ${await response.text()}`,
  ).toBeTruthy();
  await expect.poll(async () => (
    await saveButton.count() === 0
      ? "gone"
      : await saveButton.getAttribute("data-dirty")
  )).toMatch(/^(false|gone)$/);
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


// 全園同時只允許一份編班草稿。任何 spec 在建草稿前都要先清掉殘留的那一份，
// 否則只要有一條測試中途逾時、草稿沒收乾淨，後面每一條要建草稿的都會拿到
// 409 draft_exists——失敗會出現在無辜的那條 spec 上，很難追。
export async function cancelLeftoverTermPlan(page) {
  const overview = await page.request.get("/api/organization/overview");
  if (!overview.ok()) return;
  const planId = (await overview.json()).draft_term_plan_id;
  if (!planId) return;
  await page.request.post(
    `/api/organization/term-reclassification-plans/${planId}/cancel`,
  );
}
