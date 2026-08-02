// 手機版學生編輯 e2e：三面板不溢出
import { expect, test } from "./fixtures.js";
import {
  redPng,
  bluePng,
  loginViaApi,
  createTemplateWithLayout,
  createProject,
  fetchProjectDetail,
  loadFixtureLayout,
  layoutWithTwoPhotoSlots,
} from "./helpers.js";


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
    const project = await createProject(page, projectName, templateId, ["MobileAlice"]);

    const detail = await fetchProjectDetail(page, project.id);
    const student = detail.students.find(item => item.name === "MobileAlice");
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
