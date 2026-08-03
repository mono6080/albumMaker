// 批次照片精靈 e2e：依檔名整批匯入走完三步、多 chunk 上傳全數成功
import { expect, test } from "./fixtures.js";
import {
  createProject,
  createTemplateWithLayout,
  loadFixtureLayout,
  loginViaApi,
  redPng,
} from "./helpers.js";

test("批次精靈依檔名整批匯入：5 檔多 chunk 全數成功", async ({ page }) => {
  const layout = await loadFixtureLayout();
  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, `批次精靈模板 ${Date.now()}`, layout);
  const names = ["小明", "小華", "小美", "小強", "小芳"];
  const project = await createProject(page, `批次精靈專案 ${Date.now()}`, templateId, names);

  // 進全班編輯 → 開「依檔名整批匯入」
  await page.goto(`/projects/${project.id}/edit`);
  const wizardButton = page.getByRole("button", { name: "依檔名整批匯入" });
  await expect(wizardButton).toBeVisible();
  await wizardButton.click();

  const dialog = page.getByRole("dialog", { name: "依檔名指定格位" });
  await expect(dialog).toBeVisible();

  // 檔名「姓名1-1」＝第 1 頁第 1 格；5 張同目標 → chunk(2) 切成 3 個，
  // 驗證雙路 chunk 重疊上傳不互相蓋寫
  await dialog.locator('input[type="file"]').setInputFiles(
    names.map(name => ({
      name: `${name}1-1.png`,
      mimeType: "image/png",
      buffer: redPng,
    })),
  );

  await dialog.getByRole("button", { name: "下一步" }).click(); // → 檔名規則
  await dialog.getByRole("button", { name: "下一步" }).click(); // → 確認匯入
  const uploadButton = dialog.getByRole("button", { name: "上傳 5 張" });
  await expect(uploadButton).toBeEnabled();
  await uploadButton.click();

  // 全數成功：toast ＋ 完成按鈕，且沒有「補傳失敗」
  await expect(page.getByText("已上傳 5 張")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("button", { name: "完成" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /補傳失敗/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "完成" }).click();

  // 伺服器端驗證：每位學生第 1 頁預覽都渲染得出來（照片已入格）
  const detail = await (await page.request.get(`/api/projects/${project.id}`)).json();
  for (const student of detail.students) {
    const previewResponse = await page.request.get(
      `/api/projects/${project.id}/students/${student.id}/preview/0?scale=0.4`,
    );
    expect(previewResponse.ok()).toBeTruthy();
    expect(previewResponse.headers()["content-type"]).toContain("image/");
  }
});
