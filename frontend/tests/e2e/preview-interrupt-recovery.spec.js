// 預覽中斷恢復 regression：慢速下載中切頁（body 傳輸中被中斷）再切回，
// 量測恢復時間——守住 keeper 背景收尾與 watchdog 防線（CDP throttle，僅 chromium）
import { expect, test } from "@playwright/test";
import {
  loginViaApi,
  createTemplateWithLayout,
  createProject,
  fetchProjectDetail,
  loadFixtureLayout,
} from "./helpers.js";

test.skip(({ browserName }) => browserName !== "chromium", "CDP throttle 只在 chromium");

test("recovery time after interrupting preview downloads mid-body", async ({ page }) => {
  test.setTimeout(300000);
  const layout = await loadFixtureLayout();
  const templateName = `E2E throttle ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  for (let i = 0; i < 3; i += 1) {
    const pageResponse = await page.request.post(`/api/templates/${templateId}/pages`);
    const templatePage = await pageResponse.json();
    await page.request.put(
      `/api/templates/${templateId}/pages/${templatePage.id}/layout`,
      { data: layout },
    );
  }
  const project = await createProject(page, `${templateName} 班`, templateId, ["Alice"]);
  const detail = await fetchProjectDetail(page, project.id);
  const studentId = detail.students[0].id;

  const events = [];
  page.on("response", r => {
    if (r.url().includes("/preview/")) events.push(`${Date.now() % 100000} ${r.status()} ${r.url().slice(-60)}`);
  });

  await page.goto(`/projects/${project.id}/students/${studentId}/edit`);
  // 若跑在 production build（8765）上，等 service worker 接管，重現正式站的請求路徑
  const hasSw = await page.evaluate(() => "serviceWorker" in navigator);
  if (hasSw && !process.env.SKIP_SW_WAIT) {
    await page.waitForTimeout(3000);
    const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
    if (!controlled) {
      await page.reload();
      await page.waitForTimeout(2000);
    }
    console.log("SW_CONTROLLED:", await page.evaluate(() => Boolean(navigator.serviceWorker?.controller)));
  }
  // img 只在 blob 載好後才出現，用 null-safe querySelector 判斷
  const previewShown = () => page.evaluate(() => {
    const el = document.querySelector('[data-guide="student-page-preview"] img');
    return !!(el && el.complete && el.naturalWidth > 0);
  });
  await expect.poll(previewShown, { timeout: 30000 }).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  const throttleOn = () => cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 150, downloadThroughput: 25 * 1024, uploadThroughput: 100 * 1024,
  });
  const throttleOff = () => cdp.send("Network.emulateNetworkConditions", {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  const dot = n => page.getByRole("button", { name: `第 ${n} 頁`, exact: true });
  const recoveries = [];

  for (let round = 0; round < 6; round += 1) {
    const target = 2 + (round % 3); // 2..4 頁輪流
    // 慢網下進入 target：請求發出、body 傳輸中
    await throttleOn();
    await dot(target).click();
    await page.waitForTimeout(700); // 讓請求發出且在下載中
    await dot(1).click();           // 切走：中斷 target 的下載
    await page.waitForTimeout(500);
    // 恢復正常網速，切回 target，量測多久出現
    await throttleOff();
    const started = Date.now();
    await dot(target).click();
    await expect.poll(previewShown, { timeout: 40000 }).toBe(true);
    recoveries.push(Date.now() - started);
    await page.waitForTimeout(400);
  }

  console.log("RECOVERY_MS:", JSON.stringify(recoveries));
  console.log("EVENTS:", JSON.stringify(events.slice(-30), null, 0));
  // 健康標準：切回後應在幾秒內出現；15 秒等級代表在等 watchdog
  const worst = Math.max(...recoveries);
  expect(worst, `最差恢復時間 ${worst}ms（全部：${recoveries.join(",")}）`).toBeLessThan(8000);
});
