// 專案主流程 e2e：班級名單快照、相本稱呼、共用照片、全班完成鎖定
import { expect, test } from "./fixtures.js";
import {
  redPng,
  bluePng,
  loginViaApi,
  createTemplateWithLayout,
  createClassroomFixture,
  getCreatableWorkSlot,
  createProject,
  fetchProjectDetail,
  uploadStudentPhoto,
  loadFixtureLayout,
  layoutWithTwoPhotoSlots,
  closeProductGuide,
  waitForResponseAfter,
} from "./helpers.js";


async function updateProjectLabelTexts(page, projectId, labelTexts) {
  const project = await fetchProjectDetail(page, projectId);
  const response = await page.request.put(
    `/api/projects/${projectId}/label_texts?expected_template_revision=${project.template_revision}`,
    { data: labelTexts },
  );
  expect(response.ok()).toBeTruthy();
}


async function updateStudentLabelTexts(page, projectId, studentId, pageIndex, labelTexts) {
  const project = await fetchProjectDetail(page, projectId);
  const response = await page.request.put(
    `/api/projects/${projectId}/students/${studentId}/pages/${pageIndex}/texts`
      + `?expected_template_revision=${project.template_revision}`,
    { data: labelTexts },
  );
  expect(response.ok()).toBeTruthy();
}


test("lead teacher creates a class project from the current roster snapshot", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 專案模板 ${Date.now()}`;
  const projectSuffix = "東區校-十階A";
  const projectName = `${templateName} ${projectSuffix}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const templateResponse = await page.request.get(`/api/templates/${templateId}`);
  expect(templateResponse.ok()).toBeTruthy();
  const template = await templateResponse.json();
  const { teacher, teacherPassword, classroom } = await createClassroomFixture(
    page,
    template.department,
    [{ name: "Alice" }, { name: "王小明", album_name: "小明" }],
  );

  await page.context().clearCookies();
  const loginResponse = await page.request.post("/api/auth/login", {
    form: { username: teacher.username, password: teacherPassword },
  });
  expect(loginResponse.ok()).toBeTruthy();

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: classroom.name, exact: true })).toBeVisible();
  const workSlot = await getCreatableWorkSlot(page, classroom.id, templateId);
  await page.getByRole("button", { name: "建立新一期相本" }).click();
  const createProjectDialog = page.getByRole("dialog", { name: `建立新一期相本：${classroom.name}` });
  await createProjectDialog.getByLabel("相本名稱").fill(projectName);
  await createProjectDialog.getByLabel("正式學期期別").selectOption(String(workSlot.id));
  await createProjectDialog.getByLabel("此期模板").selectOption(String(templateId));
  const createProjectResponse = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/organization/classrooms/${classroom.id}/projects`
  ));
  await createProjectDialog.getByRole("button", { name: "建立班級相本" }).click();
  expect((await createProjectResponse).ok()).toBeTruthy();
  await expect(createProjectDialog).toHaveCount(0);
  await expect(page.getByText(projectName, { exact: true })).toBeVisible();

  // 建立成功後由班級卡片進入總覽，名單已帶入建立當下的班級目前名單。
  const createdProjectCard = page.locator('[data-guide="project-card"]').filter({ hasText: projectName });
  await createdProjectCard.getByRole("link", { name: "班級總覽" }).click();
  await expect(page.getByRole("button", { name: "本期學生" })).toBeVisible();

  await page.goto("/projects");
  await expect(page.getByText(projectName)).toBeVisible();

  const projectSearch = page.getByLabel("搜尋專案");
  await projectSearch.fill("沒有這個專案");
  await expect(page.getByText("這個班級沒有符合目前搜尋的相本", { exact: true })).toBeVisible();
  await expect(page.getByText(projectName)).toHaveCount(0);
  await projectSearch.fill(projectName);
  await expect(page.getByText(projectName)).toBeVisible();
  await expect(page.getByText(/找到 1 \/ \d+ 個專案/)).toBeVisible();
  await page.getByRole("button", { name: "清除搜尋" }).click();
  await expect(projectSearch).toHaveValue("");
  await expect(page.getByText(projectName)).toBeVisible();

  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("建立新一期相本");
  await expect(page.locator(".driver-popover")).toContainText("主教直接在目前任教班級建立新一期");
  await closeProductGuide(page);

  // 從班級下的相本卡片進入總覽管理這一期學生快照。
  await page.locator(".group").filter({ hasText: projectName }).first().locator('[data-guide="project-review-link"]').click();
  await expect(page.getByText(projectName)).toBeVisible();

  // 工作台核對本期成員與完整姓名快照；相本稱呼只讀且跟隨園所設定。
  await page.getByRole("button", { name: "本期學生" }).click();
  const rosterDialog = page.getByRole("dialog", { name: "本期學生" });
  await expect(rosterDialog).toBeVisible();
  await expect.poll(() => rosterDialog.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(rosterDialog).toHaveCount(0);
  await page.getByRole("button", { name: "本期學生" }).click();
  await expect(rosterDialog).toBeVisible();
  await expect(rosterDialog).toContainText("相本稱呼統一跟隨園所設定");
  await expect(rosterDialog.getByText("本期學生（2 位）")).toBeVisible();
  await expect(rosterDialog.getByText("Alice", { exact: true })).toBeVisible();
  await expect(rosterDialog.getByText("王小明", { exact: true })).toBeVisible();
  await expect(rosterDialog.getByText("相本稱呼（園所設定）：小明", { exact: true })).toBeVisible();
  await expect(rosterDialog.getByText("完整姓名 · 本期快照")).toHaveCount(2);
  await expect(rosterDialog.getByRole("button", { name: "編輯 Alice 的完整姓名" })).toHaveCount(0);
  await expect(rosterDialog.getByRole("button", { name: "新增" })).toHaveCount(0);
  await expect(rosterDialog.getByRole("button", { name: /(編輯|清除|自動偵測|自動填入).*相本稱呼/ })).toHaveCount(0);

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
  await page.locator('[data-guide="class-text-panel"]').getByRole("button", { name: "相本稱呼 {name}" }).click();
  await page.locator('[data-guide="class-text-panel"]').getByRole("button", { name: "完整姓名 {full_name}" }).click();
  await expect(projectTextArea).toHaveValue("班級：{name}{full_name}");
  await projectTextArea.fill("");
  await expect(projectTextArea).toHaveValue("");
  await waitForResponseAfter(
    page,
    response => response.url().includes("/label_texts") && response.request().method() === "PUT" && response.ok(),
    () => projectTextArea.fill("{name}/{full_name}/{name}"),
  );

  const projectsResponse = await page.request.get("/api/projects/");
  const projects = await projectsResponse.json();
  const project = projects.find(item => item.name === projectName);
  expect(project.student_count).toBe(2);
  const projectDetail = await fetchProjectDetail(page, project.id);
  const alice = projectDetail.students.find(item => item.name === "Alice");
  const wangXiaoming = projectDetail.students.find(item => item.name === "王小明");
  expect(alice).toBeTruthy();
  expect(wangXiaoming).toBeTruthy();
  expect(alice.effective_album_name).toBe("Alice");
  expect(wangXiaoming.effective_album_name).toBe("小明");

  await page.getByRole("link", { name: "班級總覽", exact: true }).click();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "製作教學" }).click();
  await expect(page.locator(".driver-popover")).toContainText("班級進度");
  await expect(page.locator(".driver-popover")).toContainText("照片與文字進度");
  await closeProductGuide(page);

  await page.locator('[data-guide="review-student-card"]').filter({ hasText: "Alice" }).getByRole("link", { name: "編輯" }).click();
  await expect(page.getByText("照片管理")).toBeVisible();
  await page.getByRole("button", { name: "製作教學" }).click();
  // 單頁模板沒有頁碼導航，導覽從「頁面預覽」開始
  await expect(page.locator(".driver-popover")).toContainText("頁面預覽");
  await expect(page.locator(".driver-popover")).toContainText("合成預覽");
  await closeProductGuide(page);

  const studentTextArea = page.locator('[data-guide="student-text-fields"] textarea').first();
  await expect(page.locator('[data-guide="student-text-fields"]')).toContainText("預設：Alice/Alice/Alice");
  await studentTextArea.fill("學生：");
  await page.locator('[data-guide="student-text-fields"]').getByRole("button", { name: "相本稱呼 {name}" }).click();
  await page.locator('[data-guide="student-text-fields"]').getByRole("button", { name: "完整姓名 {full_name}" }).click();
  await expect(studentTextArea).toHaveValue("學生：{name}{full_name}");
  await studentTextArea.fill("");
  await expect(studentTextArea).toHaveValue("");
  await waitForResponseAfter(
    page,
    response => response.url().includes("/batch/texts") && response.request().method() === "PUT" && response.ok(),
    () => studentTextArea.fill("個人 {name}"),
  );

  await expect(page.getByLabel("切換學生")).toHaveValue(String(alice.id));
  await page.getByRole("button", { name: "下一位" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/students/${wangXiaoming.id}/edit`));
  await expect(page.getByRole("heading", { name: "王小明", level: 1 })).toBeVisible();
  await expect(page.getByLabel("切換學生")).toHaveValue(String(wangXiaoming.id));
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
  const project = await createProject(
    page,
    projectName,
    templateId,
    ["Group Alice", "Group Bob"],
  );

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
  await page.getByRole("button", { name: /多人同一張/ }).click();
  await expect(page.getByRole("heading", { name: "選擇套用對象" })).toBeVisible();

  await page
    .locator('[data-guide="class-slot-photo-modal"] input[type="file"]')
    .setInputFiles({ name: "group.png", mimeType: "image/png", buffer: bluePng });

  const uploadResponse = page.waitForResponse(
    response => response.url().includes("/photos/shared/pages/0/slots/2") && response.ok(),
  );
  await page.getByRole("button", { name: /^套用到全班/ }).click();
  await uploadResponse;
  await expect(page.getByText("已套用到 2 位學生")).toBeVisible();

  let sharedPaths = [];
  await expect.poll(async () => {
    const detail = await fetchProjectDetail(page, project.id);
    sharedPaths = detail.students.map(student => student.pages_data?.[0]?.photos?.["2"]?.path ?? null);
    return sharedPaths.filter(Boolean).length;
  }, { timeout: 20_000 }).toBe(2);

  expect(sharedPaths[0]).toContain("student");
  expect(sharedPaths[0]).toMatch(/p0_slot2_group_[0-9a-f]{16}\.png$/);
  expect(sharedPaths[1]).toMatch(/p0_slot2_group_[0-9a-f]{16}\.png$/);
  expect(sharedPaths[0]).not.toBe(sharedPaths[1]);

  const detail = await fetchProjectDetail(page, project.id);
  for (const student of detail.students) {
    await page.goto(`/projects/${project.id}/students/${student.id}/edit`);
    await expect(page.getByText("照片管理")).toBeVisible();
    const slot = page.locator('[data-guide="student-photo-cell"][data-slot-id="2"]');
    await expect(slot.locator('[data-guide="photo-slot-image"]')).toHaveAttribute(
      "src",
      /\/photos\/2\/thumbnail\?v=.*group_[0-9a-f]{16}\.png/,
    );
  }

  // 「多人同一張」勾選部分學生：只套用到第一位學生，另一位維持原檔
  await page.goto(`/projects/${project.id}/edit`);
  await expect(page.locator('[data-guide="class-photo-panel"]')).toBeVisible();
  await page
    .locator('[data-guide="class-shared-photo-slots"]')
    .getByRole("button", { name: /格2/ })
    .click();
  await page.getByRole("button", { name: /多人同一張/ }).click();
  await page.getByRole("button", { name: "部分學生", exact: true }).click();
  // 姓名經名冊正規化會移除空白（Group Bob → GroupBob），用寬鬆比對；chip 點一下取消選取
  await page.getByRole("button", { name: /Bob/ }).click();
  await page
    .locator('[data-guide="class-slot-photo-modal"] input[type="file"]')
    .setInputFiles({ name: "partial.png", mimeType: "image/png", buffer: redPng });
  const partialUploadResponse = page.waitForResponse(
    response => response.url().includes("/photos/shared/pages/0/slots/2") && response.ok(),
  );
  await page.getByRole("button", { name: "套用到 1 位學生", exact: true }).click();
  await partialUploadResponse;
  await expect(page.getByText("已套用到 1 位學生")).toBeVisible();

  let partialPaths = [];
  await expect.poll(async () => {
    const refreshed = await fetchProjectDetail(page, project.id);
    partialPaths = refreshed.students.map(student => student.pages_data?.[0]?.photos?.["2"]?.path ?? null);
    return partialPaths[0];
  }, { timeout: 20_000 }).toMatch(/p0_slot2_partial_[0-9a-f]{16}\.png$/);
  expect(partialPaths[1]).toBe(sharedPaths[1]);
});


test("class completion locks content while scope switching stays usable", async ({ page }) => {
  const layout = await loadFixtureLayout();
  const templateName = `E2E 完成鎖定模板 ${Date.now()}`;
  const projectName = `E2E 完成鎖定專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(
    page,
    projectName,
    templateId,
    ["Lock Alice", "Lock Bob"],
  );
  const detail = await fetchProjectDetail(page, project.id);
  const slotId = layout.photo_slots[0].id;
  for (const student of detail.students) {
    await uploadStudentPhoto(page, project.id, student.id, slotId, "lock.png", redPng);
  }
  await updateProjectLabelTexts(page, project.id, {
    0: { [String(layout.text_labels[0].id)]: "全班文字已完成" },
  });

  // 照片與文字備齊（階段 2）→ 標記全班完成
  await page.goto(`/projects/${project.id}/review`);
  await expect(page.getByRole("button", { name: "請先標記此學生完成，才能下載 PDF" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "請先標記此學生完成，才能下載圖片" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "PDF ZIP", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "全部圖片", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "全班完成", exact: true }).click();
  await page.getByRole("dialog", { name: "全班完成" }).getByRole("button", { name: "全班完成", exact: true }).click();
  await expect(page.getByText("✓ 全班完成")).toBeVisible();
  await expect(page.getByRole("button", { name: "下載 PDF", exact: true }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "下載圖片", exact: true }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "PDF ZIP", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "全部圖片", exact: true })).toBeEnabled();

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
  await expect(page.getByRole("button", { name: "全班完成", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "請先標記此學生完成，才能下載 PDF" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "請先標記此學生完成，才能下載圖片" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "PDF ZIP", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "全部圖片", exact: true })).toBeDisabled();
});


test("class text progress combines eleven class fields with each student's last field", async ({ page }) => {
  const layout = await loadFixtureLayout();
  layout.photo_slots = [];
  layout.text_labels = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    x: 48,
    y: 48 + index * 84,
    width: 360,
    height: 60,
    text: `模板範例 ${index + 1}`,
    font_size: 24,
    font_color: "#333333",
  }));
  const templateName = `E2E 文字進度模板 ${Date.now()}`;
  const projectName = `E2E 文字進度專案 ${Date.now()}`;

  await loginViaApi(page);
  const { templateId } = await createTemplateWithLayout(page, templateName, layout);
  const project = await createProject(
    page,
    projectName,
    templateId,
    ["Text Alice", "Text Bob"],
  );
  const projectTexts = Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [String(index + 1), `全班 ${index + 1}`]),
  );
  await updateProjectLabelTexts(page, project.id, { 0: projectTexts });

  const detail = await fetchProjectDetail(page, project.id);
  await updateStudentLabelTexts(
    page,
    project.id,
    detail.students[0].id,
    0,
    { 12: "第一位個人文字" },
  );

  await page.goto(`/projects/${project.id}/review`);
  const textProgress = page.getByRole("progressbar", { name: "全班文字完成度" });
  await expect(textProgress).toHaveAttribute("aria-valuemax", "24");
  await expect(textProgress).toHaveAttribute("aria-valuenow", "23");
  await expect(page.getByText("未填齊 1 位", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "全班完成", exact: true })).toHaveCount(0);

  await updateStudentLabelTexts(
    page,
    project.id,
    detail.students[1].id,
    0,
    { 12: "第二位個人文字" },
  );
  await page.reload();

  await expect(textProgress).toHaveAttribute("aria-valuenow", "24");
  await expect(page.getByText("全班文字齊", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "全班完成", exact: true })).toBeVisible();
});
