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
  test("deleting a page requires a reason and restoring clears it", async ({ page }) => {
    const layout = await loadFixtureLayout();
    await loginViaApi(page);
    const { templateId } = await createTemplateWithLayout(page, `E2E 刪頁模板 ${Date.now()}`, layout);
    const project = await createProject(page, `E2E 刪頁專案 ${Date.now()}`, templateId, ["SkipAlice"]);
    const detail = await fetchProjectDetail(page, project.id);
    const student = detail.students.find(item => item.name === "SkipAlice");
    const pageZero = async () => (await fetchProjectDetail(page, project.id))
      .students.find(item => item.id === student.id)?.pages_data?.[0] ?? {};

    await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
    await page.getByRole("button", { name: "預覽" }).tap();
    await page.getByRole("button", { name: "刪除此頁" }).tap();

    const dialog = page.getByRole("dialog", { name: "刪除第 1 頁" });
    await expect(dialog).toBeVisible();
    const confirmButton = dialog.getByRole("button", { name: "確認刪除" });
    await expect(confirmButton).toBeDisabled();
    // 只有空白不算填寫
    await dialog.getByLabel("刪除原因（必填）").fill("   ");
    await expect(confirmButton).toBeDisabled();
    await dialog.getByLabel("刪除原因（必填）").fill("該期請假未到校");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    await confirmButton.tap();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("原因：該期請假未到校")).toBeVisible();
    await expect.poll(pageZero).toMatchObject({ skip: true, skip_reason: "該期請假未到校" });

    // 重新載入後原因仍顯示
    await page.reload();
    await page.getByRole("button", { name: "預覽" }).tap();
    await expect(page.getByText("原因：該期請假未到校")).toBeVisible();

    await page.getByRole("button", { name: "還原此頁" }).tap();
    await expect(page.getByRole("button", { name: "刪除此頁" })).toBeVisible();
    await expect.poll(async () => {
      const entry = await pageZero();
      return { skip: entry.skip, hasReason: "skip_reason" in entry };
    }).toEqual({ skip: false, hasReason: false });
  });
});


test("desktop page-skip reason dialog sits above the sticky editor columns", async ({ page }) => {
  // 桌機三欄：預覽欄是 sticky（自成堆疊層），對話框不能被照片欄／文字欄蓋住
  await page.setViewportSize({ width: 1600, height: 900 });
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, `E2E 桌機刪頁模板 ${Date.now()}`, layout);
  const project = await createProject(page, `E2E 桌機刪頁專案 ${Date.now()}`, templateId, ["DeskAlice"]);
  const detail = await fetchProjectDetail(page, project.id);
  const student = detail.students.find(item => item.name === "DeskAlice");

  await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
  await page.getByRole("button", { name: "刪除此頁" }).click();
  const dialog = page.getByRole("dialog", { name: "刪除第 1 頁" });
  await expect(dialog).toBeVisible();

  // 對話框四角與中心、標題、確認鈕都必須是最上層（點得到的是對話框本身）
  const coveredPoints = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const inset = 6;
    const points = [
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
    ];
    element.querySelectorAll("h2, button").forEach(child => {
      const childRect = child.getBoundingClientRect();
      points.push([childRect.left + childRect.width / 2, childRect.top + childRect.height / 2]);
    });
    return points.filter(([x, y]) => !element.contains(document.elementFromPoint(x, y)));
  });
  expect(coveredPoints).toEqual([]);

  await dialog.getByLabel("刪除原因（必填）").fill("照片不足");
  await dialog.getByRole("button", { name: "確認刪除" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("原因：照片不足")).toBeVisible();
});
