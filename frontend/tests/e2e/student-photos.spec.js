// 學生照片 e2e：上傳、預覽快取、mapping、縮圖、裁切
import { expect, test } from "@playwright/test";
import {
  redPng,
  bluePng,
  uploadPngs,
  loginViaApi,
  createTemplateWithLayout,
  createProject,
  fetchProjectDetail,
  uploadStudentPhoto,
  fetchStudentPreview,
  loadFixtureLayout,
  layoutWithTwoPhotoSlots,
  layoutWithPhotoSlots,
  dragWithSteps,
} from "./helpers.js";


test("student photo uploads, preview cache, and mapping swaps work through storage", async ({ page }) => {
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 照片模板 ${Date.now()}`;
  const projectName = `E2E 照片專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId, ["PhotoAlice"]);

  let detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "PhotoAlice");
  expect(student).toBeTruthy();

  const firstPhoto = await uploadStudentPhoto(page, project.id, student.id, 1, "first.png", redPng);
  const secondPhoto = await uploadStudentPhoto(page, project.id, student.id, 2, "second.png", bluePng);

  const firstPreview = await fetchStudentPreview(page, project.id, student.id);
  expect(firstPreview.headers()["x-preview-cache"]).toBe("MISS");
  const cachedPreview = await fetchStudentPreview(page, project.id, student.id);
  expect(cachedPreview.headers()["x-preview-cache"]).toBe("HIT");

  const swapResponse = await page.request.put(
    `/api/projects/${project.id}/students/${student.id}/photos/mapping`
      + `?expected_template_revision=${detail.template_revision}`,
    {
    data: {
      pages: {
        "0": {
          "1": { path: secondPhoto.path, scale: 1.15, offset_x: 0.05, offset_y: 0 },
          "2": { path: firstPhoto.path, scale: 1.25, offset_x: -0.05, offset_y: 0 },
        },
      },
    },
    },
  );
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

  // 權限保護後的硬驗收：Cookie 登入狀態下，真實 <img> 必須完成解碼；
  // 清除 Cookie 後，同一媒體 URL 必須被後端拒絕。
  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  const displayedPhoto = page.locator('[data-guide="photo-slot-image"]').first();
  await expect(displayedPhoto).toBeVisible();
  await expect.poll(
    () => displayedPhoto.evaluate(image => image.complete && image.naturalWidth > 0),
    { timeout: 15_000 },
  ).toBe(true);
  const protectedMediaUrl = await displayedPhoto.getAttribute("src");
  await page.context().clearCookies();
  const anonymousMedia = await page.request.get(protectedMediaUrl);
  expect(anonymousMedia.status()).toBe(401);
});


test("student photo manager keeps a pending file while refreshing a newer template revision", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 照片 revision 模板 ${Date.now()}`;
  const projectName = `E2E 照片 revision 專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId, pageId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId, ["RevisionAlice"]);

  const initialDetail = await fetchProjectDetail(page, project.id);
  const student = initialDetail.students.find(item => item.name === "RevisionAlice");
  expect(student).toBeTruthy();

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();

  const backgroundResponse = await page.request.post(
    `/api/templates/${templateId}/pages/${pageId}/background`
      + `?expected_revision=${initialDetail.template_revision}`,
    {
      multipart: {
        file: {
          name: "revision-background.png",
          mimeType: "image/png",
          buffer: bluePng,
        },
      },
    },
  );
  expect(backgroundResponse.ok()).toBeTruthy();

  const staleUpload = page.waitForResponse(response => (
    response.url().includes(`/students/${student.id}/pages/0/photos/1`)
    && response.request().method() === "POST"
    && response.status() === 409
  ));
  await page
    .locator('[data-guide="student-photo-cell"][data-slot-id="1"] input[type="file"]:not([multiple])')
    .setInputFiles({ name: "retained-after-revision.png", mimeType: "image/png", buffer: redPng });
  const staleResponse = await staleUpload;
  expect((await staleResponse.json()).detail.code).toBe("project_template_revision_changed");

  await expect.poll(async () => {
    const detail = await fetchProjectDetail(page, project.id);
    return detail.students.find(item => item.id === student.id)?.pages_data?.[0]?.photos?.["1"]?.path ?? "";
  }, { timeout: 20_000 }).toMatch(/retained-after-revision_[0-9a-f]{16}\.png$/);
  await expect(
    page.locator('[data-guide="student-photo-cell"][data-slot-id="1"] [data-guide="photo-slot-image"]'),
  ).toHaveAttribute("src", /retained-after-revision_[0-9a-f]{16}\.png/);
});


test("student photo manager reconciles a moved pending photo after delayed POST response", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit route.fetch 無法重送原 multipart boundary，會在後端先得到 415",
  );
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 延遲照片模板 ${Date.now()}`;
  const projectName = `E2E 延遲照片專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId, ["DelayedAlice"]);

  const initialDetail = await fetchProjectDetail(page, project.id);
  const student = initialDetail.students.find(item => item.name === "DelayedAlice");
  expect(student).toBeTruthy();

  let releaseDelayedResponse;
  const delayedResponseGate = new Promise(resolve => { releaseDelayedResponse = resolve; });
  let markBackendWriteComplete;
  const backendWriteComplete = new Promise(resolve => { markBackendWriteComplete = resolve; });
  let uploadRequestCount = 0;
  await page.route(
    `**/api/projects/${project.id}/students/${student.id}/pages/0/photos/1?*`,
    async route => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      uploadRequestCount += 1;
      const response = await route.fetch();
      const body = await response.body();
      markBackendWriteComplete(JSON.parse(body.toString()).path);
      await delayedResponseGate;
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body,
      });
    },
  );

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await expect(page.getByText("照片管理")).toBeVisible();
  const firstCell = page.locator('[data-guide="student-photo-cell"][data-slot-id="1"]');
  const secondCell = page.locator('[data-guide="student-photo-cell"][data-slot-id="2"]');

  await firstCell
    .locator('input[type="file"]:not([multiple])')
    .setInputFiles({ name: "delayed-move.png", mimeType: "image/png", buffer: redPng });
  const uploadedPath = await backendWriteComplete;
  expect(uploadedPath).toMatch(/delayed-move_[0-9a-f]{16}\.png$/);

  // 後端已寫入 slot 1、瀏覽器仍等 POST response；此時把同一 token 移到 slot 2。
  await dragWithSteps(page, firstCell, secondCell);
  await expect(firstCell.locator('[data-guide="photo-slot-image"]')).toHaveCount(0);
  await expect(secondCell.locator('[data-guide="photo-slot-image"]')).toHaveAttribute("src", /^blob:/);

  const mappingResponse = page.waitForResponse(response => (
    response.url().includes(`/students/${student.id}/photos/mapping`)
    && response.request().method() === "PUT"
    && response.ok()
  ));
  releaseDelayedResponse();
  await mappingResponse;

  await expect.poll(async () => {
    const detail = await fetchProjectDetail(page, project.id);
    return detail.students.find(item => item.id === student.id)?.pages_data?.[0]?.photos ?? {};
  }, { timeout: 20_000 }).toEqual({
    "2": expect.objectContaining({ path: uploadedPath }),
  });
  await expect(secondCell.locator('[data-guide="photo-slot-image"]')).toHaveAttribute(
    "src",
    /\/photos\/2\/thumbnail\?v=.*delayed-move_[0-9a-f]{16}\.png/,
  );
  const oldSlotResponse = await page.request.get(
    `/api/projects/${project.id}/students/${student.id}/pages/0/photos/1`,
  );
  const movedSlotResponse = await page.request.get(
    `/api/projects/${project.id}/students/${student.id}/pages/0/photos/2`,
  );
  expect(oldSlotResponse.status()).toBe(404);
  expect(movedSlotResponse.ok()).toBeTruthy();
  await expect(page.getByText("✓ 已儲存")).toBeVisible();
  expect(uploadRequestCount).toBe(1);
});


test("student multi-select upload only fills remaining empty slots", async ({ page }) => {
  const layout = layoutWithPhotoSlots(await loadFixtureLayout(), 4);
  const templateName = `E2E 多選模板 ${Date.now()}`;
  const projectName = `E2E 多選專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId, ["MultiAlice"]);

  const initialDetail = await fetchProjectDetail(page, project.id);
  const student = initialDetail.students.find(item => item.name === "MultiAlice");
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
    "2": expect.stringMatching(/p0_slot2_multi-1_[0-9a-f]{16}\.png$/),
    "3": expect.stringMatching(/p0_slot3_multi-2_[0-9a-f]{16}\.png$/),
    "4": expect.stringMatching(/p0_slot4_multi-3_[0-9a-f]{16}\.png$/),
  });

  await expect(page.locator('[data-guide="student-photo-grid"] img')).toHaveCount(4);
});


test("student photo manager keeps thumbnails fresh after same-name replacement", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 縮圖更新模板 ${Date.now()}`;
  const projectName = `E2E 縮圖更新專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId, ["ThumbAlice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "ThumbAlice");
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
  expect(updatedSrc).toMatch(/same-name_[0-9a-f]{16}\.png/);
});


test("student photo manager resyncs slot URLs after drag swap", async ({ page }) => {
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 交換縮圖模板 ${Date.now()}`;
  const projectName = `E2E 交換縮圖專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId, ["SwapAlice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "SwapAlice");
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
  expect(firstSrc).toMatch(/p0_slot2_second_[0-9a-f]{16}\.png/);
  expect(secondSrc).toMatch(/p0_slot1_first_[0-9a-f]{16}\.png/);

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
  const project = await createProject(page, projectName, templateId, ["CropAlice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "CropAlice");
  expect(student).toBeTruthy();
  const photo = await uploadStudentPhoto(page, project.id, student.id, 1, "crop.png", redPng);
  const mappingResponse = await page.request.put(
    `/api/projects/${project.id}/students/${student.id}/photos/mapping`
      + `?expected_template_revision=${detail.template_revision}`,
    {
    data: {
      pages: {
        "0": {
          "1": { path: photo.path, scale: 1.6, offset_x: 0.6, offset_y: -0.5 },
        },
      },
    },
    },
  );
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
  const project = await createProject(page, projectName, templateId, ["MobileCropAlice"]);

  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "MobileCropAlice");
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
