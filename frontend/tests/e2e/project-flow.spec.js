// 專案主流程 e2e：建專案/名單、共用照片、全班完成鎖定
import { expect, test } from "@playwright/test";
import {
  redPng,
  bluePng,
  loginViaApi,
  createTemplateWithLayout,
  createProject,
  addStudents,
  fetchProjectDetail,
  uploadStudentPhoto,
  loadFixtureLayout,
  layoutWithTwoPhotoSlots,
  closeProductGuide,
  waitForResponseAfter,
} from "./helpers.js";


test("admin can create a project and batch students from the browser", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 專案模板 ${Date.now()}`;
  const projectSuffix = "東區校-十階A";

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);

  await page.goto("/projects");
  await page.getByRole("button", { name: "新建專案" }).click();
  await page.getByLabel("選擇模板").selectOption(String(templateId));
  const customNameInput = page.getByLabel("自訂名稱");
  await expect(customNameInput).toHaveAttribute("placeholder", "例：東區校-十階A");
  await expect(page.getByText("接在模板名稱後，格式：分校-班級")).toBeVisible();
  await customNameInput.fill(projectSuffix);
  await expect(page.getByText(`專案全名：${templateName} ${projectSuffix}`)).toBeVisible();
  await page.getByRole("button", { name: "建立專案" }).click();

  // 建立成功後直接導向班級總覽（工作台），空狀態指向名單 CTA
  await expect(page.getByRole("button", { name: "新增學生名單" })).toBeVisible();

  const projectName = `${templateName} ${projectSuffix}`;
  await page.goto("/projects");
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

  // 尚無學生的專案卡顯示單一「下一步：加入學生名單」入口（進班級總覽）
  await page.locator(".group").filter({ hasText: projectName }).first().locator('[data-guide="project-review-link"]').click();
  await expect(page.getByText(projectName)).toBeVisible();

  // 名單改為工作台上的 Modal 管理
  await page.getByRole("button", { name: "新增學生名單" }).click();
  const rosterDialog = page.getByRole("dialog", { name: "學生名單" });
  await expect(rosterDialog).toBeVisible();
  await expect.poll(() => rosterDialog.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(rosterDialog).toHaveCount(0);
  await page.getByRole("button", { name: "新增學生名單" }).click();
  await expect(rosterDialog).toBeVisible();
  await rosterDialog.getByPlaceholder("每行一位，或用逗號 / 頓號分隔").fill("Alice\nBob\nAlice");
  await rosterDialog.getByRole("button", { name: "新增" }).click();
  await expect(rosterDialog.getByText("已登記學生（2 位）")).toBeVisible();
  await expect(rosterDialog.getByText("Alice", { exact: true })).toBeVisible();
  await expect(rosterDialog.getByText("Bob", { exact: true })).toBeVisible();
  await rosterDialog.getByRole("button", { name: "關閉" }).click();
  await expect(rosterDialog).toHaveCount(0);

  // 從工作台「繼續製作」直接進入相本編輯器（全班 scope）
  await page.getByRole("link", { name: /繼續製作/ }).click();
  await expect(page.locator('[data-guide="class-photo-panel"]')).toBeVisible();
  await expect(page.locator('[data-guide="class-preview-panel"]')).toBeVisible();

  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("套用到所有學生");
  await closeProductGuide(page);

  const projectTextArea = page.locator('[data-guide="class-text-panel"] textarea').first();
  await expect(projectTextArea).toHaveValue("Default label");
  await projectTextArea.fill("班級：");
  await page.locator('[data-guide="class-text-panel"]').getByRole("button", { name: "插入 {name}" }).click();
  await expect(projectTextArea).toHaveValue("班級：{name}");
  await projectTextArea.fill("");
  await expect(projectTextArea).toHaveValue("");
  await waitForResponseAfter(
    page,
    response => response.url().includes("/label_texts") && response.request().method() === "PUT" && response.ok(),
    () => projectTextArea.fill("共用 {name}"),
  );

  const projectsResponse = await page.request.get("/api/projects/");
  const projects = await projectsResponse.json();
  const project = projects.find(item => item.name === projectName);
  expect(project.student_count).toBe(2);
  const projectDetail = await fetchProjectDetail(page, project.id);
  const alice = projectDetail.students.find(item => item.name === "Alice");
  const bob = projectDetail.students.find(item => item.name === "Bob");
  expect(alice).toBeTruthy();
  expect(bob).toBeTruthy();

  await page.getByRole("link", { name: "班級總覽", exact: true }).click();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("班級進度");
  await expect(page.locator(".driver-popover")).toContainText("缺照片");
  await closeProductGuide(page);

  await page.locator('[data-guide="review-student-card"]').filter({ hasText: "Alice" }).getByRole("link", { name: "編輯" }).click();
  await expect(page.getByText("照片管理")).toBeVisible();
  await page.getByRole("button", { name: "製作教學" }).click();
  // 單頁模板沒有頁碼導航，導覽從「頁面預覽」開始
  await expect(page.locator(".driver-popover")).toContainText("頁面預覽");
  await expect(page.locator(".driver-popover")).toContainText("合成預覽");
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

  // 「全班」按鈕切回全班共用 scope（同一編輯器換資料層）
  await page.getByRole("button", { name: "全班", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/edit`));
  await expect(page.locator('[data-guide="class-photo-panel"]')).toBeVisible();

  // 「個別」按鈕切到第一位學生
  await page.getByRole("button", { name: "個別", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/students/${alice.id}/edit`));
});


test("project shared photo upload applies one slot to every student", async ({ page }) => {
  const layout = layoutWithTwoPhotoSlots(await loadFixtureLayout());
  const templateName = `E2E 共用照片模板 ${Date.now()}`;
  const projectName = `E2E 共用照片專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Group Alice", "Group Bob"]);

  // 舊 /batch 路由轉址到相本編輯器的全班 scope
  await page.goto(`/projects/${project.id}/batch`);
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/edit`));
  await expect(page.getByText(projectName)).toBeVisible();
  await expect(page.locator('[data-guide="class-photo-panel"]')).toBeVisible();
  // 點格開 Modal，在 Modal 內選分配方式並上傳
  await page
    .locator('[data-guide="class-shared-photo-slots"]')
    .getByRole("button", { name: /格2/ })
    .click();
  await expect(page.locator('[data-guide="class-slot-photo-modal"]')).toBeVisible();
  await page.getByRole("button", { name: /全班同一張/ }).click();
  await expect(page.getByText("選擇照片並套用到全班")).toBeVisible();

  await page
    .locator('[data-guide="class-slot-photo-modal"] input[type="file"]')
    .setInputFiles({ name: "group.png", mimeType: "image/png", buffer: bluePng });

  const uploadResponse = page.waitForResponse(
    response => response.url().includes("/photos/shared/pages/0/slots/2") && response.ok(),
  );
  await page.getByRole("button", { name: "套用到全班", exact: true }).click();
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


test("class completion locks content while scope switching stays usable", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 完成鎖定模板 ${Date.now()}`;
  const projectName = `E2E 完成鎖定專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(page, projectName, templateId);
  await addStudents(page, project.id, ["Lock Alice", "Lock Bob"]);
  const detail = await fetchProjectDetail(page, project.id);
  const slotId = layout.photo_slots[0].id;
  for (const student of detail.students) {
    await uploadStudentPhoto(page, project.id, student.id, slotId, "lock.png", redPng);
  }

  // 照片備齊（階段 2）→ 標記全班完成
  await page.goto(`/projects/${project.id}/review`);
  await page.getByRole("button", { name: "全班完成" }).click();
  await page.getByRole("dialog", { name: "全班完成" }).getByRole("button", { name: "全班完成" }).click();
  await expect(page.getByText("✓ 全班完成")).toBeVisible();

  // 鎖定後編輯器內的 scope 切換必須仍可用（flushSave 無變更時不得打 API 被 403 卡住）
  await page.goto(`/projects/${project.id}/edit`);
  await expect(page.getByText("此專案已標記全班完成，內容已鎖定")).toBeVisible();
  await page.getByRole("button", { name: "個別", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/students/${detail.students[0].id}/edit`));
  await expect(page.getByText("此專案已標記全班完成，內容已鎖定")).toBeVisible();
  await page.getByRole("button", { name: "下一位" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/students/${detail.students[1].id}/edit`));
  await page.getByRole("button", { name: "全班", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/edit`));

  // 退回（admin）→ 恢復階段 2
  await page.getByRole("link", { name: "班級總覽", exact: true }).click();
  await page.getByRole("button", { name: "退回修改" }).click();
  await page.getByRole("dialog", { name: "退回修改" }).getByRole("button", { name: "退回修改" }).click();
  await expect(page.getByRole("button", { name: "全班完成" })).toBeVisible();
});
