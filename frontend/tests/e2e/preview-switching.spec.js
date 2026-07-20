// 預覽切換 regression：快速切頁再切回原頁，預覽不可卡住不渲染
// （模擬正式環境慢渲染下，切頁 abort 進行中的 img 載入再切回的情境；
//  Chromium 對中斷載入的同 URL 圖片有 dedup 怪癖，守住 PagePreview 的
//  元素重用與 pending watchdog 防線）
import { expect, test } from "@playwright/test";
import {
  loginViaApi,
  createTemplateWithLayout,
  createProject,
  fetchProjectDetail,
  loadFixtureLayout,
} from "./helpers.js";

test("rapid page switching never leaves the preview stuck", async ({ page }) => {
  test.setTimeout(240000);
  const layout = await loadFixtureLayout();
  const templateName = `E2E 預覽卡住重現 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  for (let i = 0; i < 3; i += 1) {
    const pageResponse = await page.request.post(`/api/templates/${templateId}/pages`);
    expect(pageResponse.ok()).toBeTruthy();
    const templatePage = await pageResponse.json();
    const layoutResponse = await page.request.put(
      `/api/templates/${templateId}/pages/${templatePage.id}/layout`,
      { data: layout },
    );
    expect(layoutResponse.ok()).toBeTruthy();
  }
  const project = await createProject(page, `${templateName} 班`, templateId, ["Alice", "Bob"]);
  const detail = await fetchProjectDetail(page, project.id);
  const studentId = detail.students[0].id;

  const previewEvents = [];
  page.on("response", response => {
    if (response.url().includes("/preview/")) {
      previewEvents.push(`${response.status()} ${response.url().slice(-80)}`);
    }
  });
  page.on("requestfailed", request => {
    if (request.url().includes("/preview/")) {
      previewEvents.push(`FAILED(${request.failure()?.errorText}) ${request.url().slice(-80)}`);
    }
  });

  // 模擬正式環境的慢渲染：每張預覽回應延遲 0.8-2 秒，
  // 讓「切走時請求還在飛、被瀏覽器 abort」的情境真實出現
  await page.route("**/preview/**", async route => {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 800 + Math.random() * 1200));
    await route.continue();
  });

  await page.goto(`/projects/${project.id}/students/${studentId}/edit`);
  const previewImg = page.locator('[data-guide="student-page-preview"] img');
  await expect
    .poll(() => previewImg.evaluate(el => el.complete && el.naturalWidth > 0), { timeout: 30000 })
    .toBe(true);

  const dot = n => page.getByRole("button", { name: `第 ${n} 頁`, exact: true });

  for (let round = 0; round < 8; round += 1) {
    const target = 1 + (round % 4);
    const other = 1 + ((round + 1) % 4);
    // 切走讓 target 頁面請求被 abort，再快速切回：涵蓋
    // 「請求在飛時切走再切回」與「多次往返」兩種節奏
    await dot(other).click();
    await page.waitForTimeout(40 + ((round * 37) % 400));
    await dot(target).click();
    if (round % 3 === 0) {
      await page.waitForTimeout(120);
      await dot(other).click();
      await page.waitForTimeout(150);
      await dot(target).click();
    }
    await page.waitForTimeout(3500);
    const ok = await previewImg.evaluate(el => el.complete && el.naturalWidth > 0);
    if (!ok) {
      await page.waitForTimeout(8000);
      const stillOk = await previewImg.evaluate(el => el.complete && el.naturalWidth > 0);
      expect(
        stillOk,
        `round ${round}: 切到第 ${target} 頁後預覽卡住\n最近的 preview 回應:\n${previewEvents.slice(-12).join("\n")}`,
      ).toBe(true);
    }
  }
});
