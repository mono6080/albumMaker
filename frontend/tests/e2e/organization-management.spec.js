import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { cancelLeftoverTermPlan, loginViaApi, repoRoot } from "./helpers.js";


if (process.env.ORGANIZATION_E2E_BASE_URL) {
  test.use({ baseURL: process.env.ORGANIZATION_E2E_BASE_URL });
}


async function readJsonResponse(response, operation) {
  const responseText = await response.text();
  expect(response.ok(), `${operation} 回應 ${response.status()}: ${responseText}`).toBeTruthy();
  return JSON.parse(responseText);
}


function findClassroom(overview, classroomId) {
  return overview.campuses
    .flatMap(campus => campus.classrooms)
    .find(classroom => classroom.id === classroomId);
}


function stableProjectSnapshot(project) {
  return {
    id: project.id,
    classroom_id: project.classroom_id,
    campus_name: project.campus_name,
    classroom_name: project.classroom_name,
    owner_id: project.owner_id,
    student_names: project.students.map(student => student.name).sort(),
  };
}


async function loginWithCredentials(page, username, password) {
  await page.context().clearCookies();
  const loginResponse = await page.request.post("/api/auth/login", {
    form: { username, password },
  });
  expect(loginResponse.ok(), `老師登入回應 ${loginResponse.status()}: ${await loginResponse.text()}`).toBeTruthy();
  await page.goto("/projects");
  await page.waitForURL(/\/projects$/);
}


function seedLegacyProject(templateId, projectName, studentNames) {
  const output = execFileSync("python", [
    resolve(repoRoot, "frontend/tests/e2e/seed_legacy_project.py"),
    JSON.stringify({
      template_id: templateId,
      name: projectName,
      student_names: studentNames,
    }),
  ], {
    cwd: resolve(repoRoot, "backend"),
    env: process.env,
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1));
}


test("admin manages current roster while period snapshots and owner history stay intact", async ({ page }) => {
  // 這兩條走完整條園所流程（名冊、期別、相本、編班），webkit 本機就要 20～30 秒，
  // CI 的 runner 更慢會超過預設的 60 秒。慢是事實，不是壞掉——標 slow 讓它有三倍時間。
  test.slow();
  await loginViaApi(page);
  const suffix = `${Date.now()}-${test.info().project.name}`;
  const currentUser = await readJsonResponse(
    await page.request.get("/api/auth/me"),
    "取得目前使用者",
  );
  const supervisor = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-supervisor-${suffix}`,
        display_name: `園所主管 ${suffix}`,
        password: "organization-supervisor-password",
        role: "supervisor",
      },
    }),
    "建立園所主管",
  );
  const initialOwner = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-initial-owner-${suffix}`,
        display_name: `原負責老師 ${suffix}`,
        password: "organization-owner-password",
        role: "teacher",
      },
    }),
    "建立原負責老師",
  );
  const nextOwner = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-owner-${suffix}`,
        display_name: `接手老師 ${suffix}`,
        password: "organization-owner-password",
        role: "teacher",
      },
    }),
    "建立接手使用者",
  );
  const period = await readJsonResponse(
    await page.request.post("/api/templates/periods", {
      form: {
        name: `園所測試期別 ${suffix}`,
        department: "infant",
        status: "active",
      },
    }),
    "建立使用中期別",
  );
  const template = await readJsonResponse(
    await page.request.post("/api/templates/", {
      form: {
        name: `園所測試模板 ${suffix}`,
        period_id: String(period.id),
      },
    }),
    "建立模板",
  );
  const campusName = `北區分校 ${suffix}`;
  const sourceClassName = `星星班 ${suffix}`;
  const targetClassName = `太陽班 ${suffix}`;
  const uniqueHanOffset = (Date.now() + test.info().workerIndex * 97) % 2000;
  const firstNameMarker = String.fromCodePoint(0x4e00 + uniqueHanOffset);
  const secondNameMarker = String.fromCodePoint(0x4e00 + uniqueHanOffset + 1);
  const firstStudentName = `林小${firstNameMarker}`;
  const secondStudentName = `陳陽${secondNameMarker}`;
  const firstAutomaticAlbumName = `小${firstNameMarker}`;
  const secondAutomaticAlbumName = `陽${secondNameMarker}`;
  const firstStudentAlbumName = `星寶${suffix}`;
  const updatedFirstStudentAlbumName = `星星寶${suffix}`;
  const projectEditedStudentAlbumName = `相本頁園所稱呼${suffix}`;
  const departedFirstStudentAlbumName = `星寶離園${suffix}`;
  const projectName = `星星班相本 ${suffix}`;
  const transferReason = `新學期改由接手老師負責 ${suffix}`;
  const legacyProjectName = `待遷移舊相本 ${suffix}`;
  const legacyStudentName = `舊相本學生${suffix}`;
  const campus = await readJsonResponse(
    await page.request.post("/api/organization/campuses", {
      data: { name: campusName },
    }),
    "建立分校",
  );
  const sourceClassroom = await readJsonResponse(
    await page.request.post("/api/organization/classrooms", {
      data: {
        campus_id: campus.id,
        department: "infant",
        name: sourceClassName,
      },
    }),
    "建立來源班級",
  );
  const targetClassroom = await readJsonResponse(
    await page.request.post("/api/organization/classrooms", {
      data: {
        campus_id: campus.id,
        department: "infant",
        name: targetClassName,
      },
    }),
    "建立目標班級",
  );
  const createdRoster = await readJsonResponse(
    await page.request.post(`/api/organization/classrooms/${sourceClassroom.id}/members/batch`, {
      data: { members: [{ name: firstStudentName }, { name: secondStudentName }] },
    }),
    "建立目前名單",
  );
  const firstRosterMember = createdRoster.created.find(member => member.name === firstStudentName);
  const secondRosterMember = createdRoster.created.find(member => member.name === secondStudentName);
  expect(firstRosterMember).toBeTruthy();
  expect(secondRosterMember).toBeTruthy();
  for (const member of [firstRosterMember, secondRosterMember]) {
    await readJsonResponse(
      await page.request.patch(
        `/api/organization/classrooms/${sourceClassroom.id}/members/${member.id}`,
        { data: { album_name: null } },
      ),
      `清空 ${member.name} 的相本稱呼測試資料`,
    );
  }
  await readJsonResponse(
    await page.request.put(`/api/organization/classrooms/${sourceClassroom.id}/teachers`, {
      data: {
        teachers: [
          { teacher_id: initialOwner.id, duty: "lead" },
          { teacher_id: nextOwner.id, duty: "co_teacher" },
        ],
      },
    }),
    "建立目前老師編制",
  );
  seedLegacyProject(template.id, legacyProjectName, [legacyStudentName]);
  await page.goto("/admin/organization");
  await expect(page.getByRole("heading", { name: "園所設定" })).toBeVisible();
  await page.getByRole("button", { name: campusName, exact: true }).click();
  const supervisorSummary = page.getByRole("region", { name: `主管摘要 ${campusName}` });
  await expect(supervisorSummary).toBeVisible();
  await supervisorSummary.getByRole("button", { name: "編輯主管權限" }).click();
  const supervisorSettings = page.getByRole("region", { name: `主管設定 ${campusName}` });
  await expect(supervisorSettings).toBeVisible();
  const campusSupervisors = supervisorSettings.getByRole("group", { name: "全校主管" });
  const infantSupervisors = supervisorSettings.getByRole("group", { name: "嬰幼部主管" });
  await campusSupervisors.getByLabel(`全校主管：${supervisor.display_name}`, { exact: true }).check();
  await infantSupervisors.getByLabel(`嬰幼部主管：${supervisor.display_name}`, { exact: true }).check();
  const initialSupervisorResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/organization/campuses/${campus.id}/supervisors`
  ));
  await supervisorSettings.getByRole("button", { name: "儲存主管設定" }).click();
  const initialSupervisorScopes = await readJsonResponse(
    await initialSupervisorResponsePromise,
    "設定全校與嬰幼部主管",
  );
  expect(initialSupervisorScopes.supervisor_scopes.current).toEqual(expect.arrayContaining([
    expect.objectContaining({ department: null, supervisor_id: supervisor.id }),
    expect.objectContaining({ department: "infant", supervisor_id: supervisor.id }),
  ]));

  await expect(supervisorSummary.getByText(supervisor.display_name, { exact: true })).toHaveCount(2);
  await supervisorSummary.getByRole("button", { name: "編輯主管權限" }).click();
  await campusSupervisors.getByLabel(`全校主管：${supervisor.display_name}`, { exact: true }).uncheck();
  const replaceSupervisorResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/organization/campuses/${campus.id}/supervisors`
  ));
  await supervisorSettings.getByRole("button", { name: "儲存主管設定" }).click();
  const replacedSupervisorScopes = await readJsonResponse(
    await replaceSupervisorResponsePromise,
    "移除全校主管並保留部門主管",
  );
  expect(replacedSupervisorScopes.supervisor_scopes.current).toEqual([
    expect.objectContaining({ department: "infant", supervisor_id: supervisor.id }),
  ]);
  expect(replacedSupervisorScopes.supervisor_scopes.history).toEqual([
    expect.objectContaining({
      department: null,
      supervisor_id: supervisor.id,
      end_reason: "assignment_replaced",
    }),
  ]);
  await supervisorSummary.getByText("主管異動歷程（1）", { exact: true }).click();
  await expect(supervisorSummary.getByText(
    `全校主管：${supervisor.display_name}`,
    { exact: true },
  )).toBeVisible();

  // 舊相本歸班流程已隨學期範圍班級退場，未歸班相本只剩唯讀清單
  await expect(page.getByRole("heading", { name: /本未歸班舊相本/ })).toBeVisible();
  const legacyProjectGroup = page.getByRole("group", { name: `未歸班相本 ${legacyProjectName}` });
  await expect(legacyProjectGroup.getByRole("button", { name: "歸入班級" })).toHaveCount(0);
  await expect(legacyProjectGroup.getByRole("link", { name: "查看相本" })).toBeVisible();

  await page.getByRole("button", { name: campusName, exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${sourceClassName}`) }).click();
  await expect(page.getByText(firstStudentName, { exact: true })).toBeVisible();
  await expect(page.getByText(secondStudentName, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", {
    name: `${sourceClassName} 嬰幼部`,
    exact: true,
  })).toBeVisible();

  await page.getByRole("button", {
    name: `修改 ${firstStudentName} 的完整姓名與相本稱呼`,
    exact: true,
  }).click();
  const memberDetailsDialog = page.getByRole("dialog", { name: "修改學生資料" });
  await expect(memberDetailsDialog).toBeVisible();
  const firstStudentAlbumNameInput = memberDetailsDialog.getByLabel("相本稱呼（選填）");
  await expect(firstStudentAlbumNameInput).toHaveValue("");
  const autoFillFirstStudentResponse = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname
      === `/api/organization/students/${firstRosterMember.roster_child_id}/album-name/auto-fill`
  ));
  await memberDetailsDialog.getByRole("button", { name: "自動偵測", exact: true }).click();
  const autoFillFirstStudentResult = await readJsonResponse(
    await autoFillFirstStudentResponse,
    "單筆自動偵測園所相本稱呼",
  );
  expect(autoFillFirstStudentResult).toEqual({ updated: 1, unresolved: 0 });
  await expect(memberDetailsDialog).toHaveCount(0);
  await expect(page.getByText(
    `相本稱呼：${firstAutomaticAlbumName}`,
    { exact: true },
  )).toBeVisible();

  const autoFillClassroomAlbumNamesButton = page.getByRole("button", {
    name: "自動填入相本稱呼",
    exact: true,
  });
  await expect(autoFillClassroomAlbumNamesButton).toBeEnabled();
  const autoFillClassroomResponse = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname
      === `/api/organization/classrooms/${sourceClassroom.id}/members/album-names/auto-fill`
  ));
  await autoFillClassroomAlbumNamesButton.click();
  const autoFillClassroomResult = await readJsonResponse(
    await autoFillClassroomResponse,
    "整批自動填入園所相本稱呼",
  );
  expect(autoFillClassroomResult).toEqual({ updated: 1, unresolved: 0 });
  await expect(page.getByText(
    `相本稱呼：${secondAutomaticAlbumName}`,
    { exact: true },
  )).toBeVisible();
  await expect(autoFillClassroomAlbumNamesButton).toBeDisabled();

  await page.getByRole("button", {
    name: `修改 ${firstStudentName} 的完整姓名與相本稱呼`,
    exact: true,
  }).click();
  await expect(memberDetailsDialog).toBeVisible();
  await expect(firstStudentAlbumNameInput).toHaveValue(firstAutomaticAlbumName);
  await expect(memberDetailsDialog.getByRole("button", { name: "自動偵測", exact: true })).toHaveCount(0);
  await firstStudentAlbumNameInput.fill(firstStudentAlbumName);
  await expect(firstStudentAlbumNameInput).toHaveValue(firstStudentAlbumName);
  const updateMemberResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname.startsWith(
      `/api/organization/classrooms/${sourceClassroom.id}/members/`,
    )
  ));
  await memberDetailsDialog.getByRole("button", { name: "儲存", exact: true }).click();
  const updateMemberResponse = await updateMemberResponsePromise;
  expect(updateMemberResponse.ok()).toBeTruthy();
  expect(updateMemberResponse.request().postDataJSON()).toEqual({
    album_name: firstStudentAlbumName,
  });
  await expect(page.getByText(
    `相本稱呼：${firstStudentAlbumName}`,
    { exact: true },
  )).toBeVisible();

  await page.getByRole("button", { name: "建立新一期相本" }).click();
  const projectNameInput = page.getByLabel("相本名稱");
  const firstProjectSlotSelect = page.getByLabel("正式學期期別");
  const firstProjectSlotValue = await firstProjectSlotSelect.locator("option")
    .filter({ hasText: template.period_name })
    .first()
    .getAttribute("value");
  expect(firstProjectSlotValue).toBeTruthy();
  await firstProjectSlotSelect.selectOption(firstProjectSlotValue);
  await page.getByLabel("此期模板").selectOption(String(template.id));
  await page.getByLabel("目前負責老師").selectOption(String(initialOwner.id));
  await projectNameInput.fill(projectName);
  await expect(projectNameInput).toHaveValue(projectName);
  const createProjectButton = page.getByRole("button", { name: "建立相本", exact: true });
  await expect(createProjectButton).toBeEnabled();
  const createProjectResponse = page.waitForResponse(response => (
    response.request().method() === "POST"
    && response.url().endsWith(`/api/organization/classrooms/${sourceClassroom.id}/projects`)
  ));
  await createProjectButton.click();
  const createdProject = await readJsonResponse(
    await createProjectResponse,
    "建立班級相本",
  );
  await expect(page.getByRole("link", { name: projectName })).toBeVisible();
  const projectSection = page.getByRole("region", { name: `相本 ${projectName}` });
  await expect(projectSection.getByText(firstStudentName, { exact: true })).toBeVisible();
  await expect(projectSection.getByText(`相本：${firstStudentAlbumName}`, { exact: true })).toBeVisible();
  await expect(projectSection.getByText(secondStudentName, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "目前名單" }).click();
  await page.getByRole("button", {
    name: `修改 ${firstStudentName} 的完整姓名與相本稱呼`,
    exact: true,
  }).click();
  const reopenedMemberDetailsDialog = page.getByRole("dialog", { name: "修改學生資料" });
  await expect(reopenedMemberDetailsDialog).toBeVisible();
  const updatedAlbumNameInput = reopenedMemberDetailsDialog.getByLabel("相本稱呼（選填）");
  await expect(updatedAlbumNameInput).toHaveValue(firstStudentAlbumName);
  await updatedAlbumNameInput.fill(updatedFirstStudentAlbumName);
  await expect(updatedAlbumNameInput).toHaveValue(updatedFirstStudentAlbumName);
  const updateExistingProjectAlbumNameResponse = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname.startsWith(
      `/api/organization/classrooms/${sourceClassroom.id}/members/`,
    )
  ));
  await reopenedMemberDetailsDialog.getByRole("button", { name: "儲存", exact: true }).click();
  expect((await updateExistingProjectAlbumNameResponse).ok()).toBeTruthy();
  await page.getByRole("button", { name: "各期相本" }).click();
  await expect(projectSection.getByText(`相本：${updatedFirstStudentAlbumName}`, { exact: true })).toBeVisible();
  await expect(projectSection.getByText(`相本：${firstStudentAlbumName}`, { exact: true })).toHaveCount(0);

  await projectSection.getByRole("button", {
    name: `修改 ${firstStudentName} 的園所相本稱呼`,
    exact: true,
  }).click();
  const projectAlbumNameDialog = page.getByRole("dialog", { name: "修改園所相本稱呼" });
  await expect(projectAlbumNameDialog).toBeVisible();
  const projectAlbumNameInput = projectAlbumNameDialog.getByLabel("相本稱呼（選填）");
  await expect(projectAlbumNameInput).toHaveValue(updatedFirstStudentAlbumName);
  await projectAlbumNameInput.fill(projectEditedStudentAlbumName);
  await expect(projectAlbumNameInput).toHaveValue(projectEditedStudentAlbumName);
  const updateRosterChildAlbumNameResponse = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname.startsWith("/api/organization/students/")
    && new URL(response.url()).pathname.endsWith("/album-name")
  ));
  await projectAlbumNameDialog.getByRole("button", { name: "儲存", exact: true }).click();
  expect((await updateRosterChildAlbumNameResponse).ok()).toBeTruthy();
  await expect(projectSection.getByText(
    `相本：${projectEditedStudentAlbumName}`,
    { exact: true },
  )).toBeVisible();
  const existingProjectDetail = await readJsonResponse(
    await page.request.get(`/api/projects/${createdProject.id}`),
    "確認既有相本套用園所稱呼",
  );
  expect(existingProjectDetail.students.find(
    student => student.name === firstStudentName,
  )?.effective_album_name).toBe(projectEditedStudentAlbumName);

  await page.getByRole("button", { name: "目前名單" }).click();
  const departResponse = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && response.url().includes(`/api/organization/classrooms/${sourceClassroom.id}/members/`)
  ));
  await page.getByRole("button", { name: `標記離園：${firstStudentName}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "標記離園" }).click();
  expect((await departResponse).ok()).toBeTruthy();
  await page.getByRole("button", { name: "歷史紀錄" }).click();
  await expect(page.getByText(firstStudentName, { exact: true })).toBeVisible();
  await expect(page.getByText("離園", { exact: true })).toBeVisible();
  await page.getByRole("button", {
    name: `修改 ${firstStudentName} 的完整姓名與相本稱呼`,
    exact: true,
  }).click();
  const historicalMemberDetailsDialog = page.getByRole("dialog", { name: "修改學生資料" });
  await expect(historicalMemberDetailsDialog).toBeVisible();
  const historicalAlbumNameInput = historicalMemberDetailsDialog.getByLabel("相本稱呼（選填）");
  await expect(historicalAlbumNameInput).toHaveValue(projectEditedStudentAlbumName);
  await historicalAlbumNameInput.fill(departedFirstStudentAlbumName);
  await expect(historicalAlbumNameInput).toHaveValue(departedFirstStudentAlbumName);
  const updateHistoricalMemberAlbumNameResponse = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && new URL(response.url()).pathname.startsWith(
      `/api/organization/classrooms/${sourceClassroom.id}/members/`,
    )
  ));
  await historicalMemberDetailsDialog.getByRole("button", { name: "儲存", exact: true }).click();
  expect((await updateHistoricalMemberAlbumNameResponse).ok()).toBeTruthy();
  await expect(page.getByText(
    `相本稱呼：${departedFirstStudentAlbumName}`,
    { exact: true },
  )).toBeVisible();
  await page.getByRole("button", { name: "各期相本" }).click();
  await expect(projectSection.getByText(`相本：${departedFirstStudentAlbumName}`, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "目前名單" }).click();
  await page.getByRole("button", { name: `轉班：${secondStudentName}`, exact: true }).click();
  await page.getByLabel("轉入班級").selectOption(String(targetClassroom.id));
  const transferMemberResponse = page.waitForResponse(response => (
    response.request().method() === "PATCH"
    && response.url().includes(`/api/organization/classrooms/${sourceClassroom.id}/members/`)
  ));
  await page.getByRole("button", { name: "確認轉班" }).click();
  expect((await transferMemberResponse).ok()).toBeTruthy();
  await expect(page.getByText("目前沒有在班學生。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "歷史紀錄" }).click();
  await expect(page.getByText(secondStudentName, { exact: true })).toBeVisible();
  await expect(page.getByText("轉班", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "各期相本" }).click();
  await expect(projectSection.getByText(firstStudentName, { exact: true })).toBeVisible();
  await expect(projectSection.getByText(secondStudentName, { exact: true })).toBeVisible();
  await expect(
    projectSection.getByText("建立者", { exact: true }).locator("..").getByText(currentUser.display_name, { exact: true }),
  ).toBeVisible();
  await expect(
    projectSection.getByText("目前負責人", { exact: true }).locator("..").getByText(initialOwner.display_name, { exact: true }),
  ).toBeVisible();
  await projectSection.getByRole("button", { name: "轉交負責人" }).click();
  await page.getByLabel("新的目前負責人").selectOption(String(nextOwner.id));
  await page.getByLabel("轉交備註（選填）").fill(transferReason);
  const assignmentResponse = page.waitForResponse(response => (
    response.request().method() === "POST"
    && /\/api\/projects\/\d+\/assignment$/.test(new URL(response.url()).pathname)
  ));
  await page.getByRole("button", { name: "確認轉交" }).click();
  expect((await assignmentResponse).ok()).toBeTruthy();
  await expect(projectSection.getByText(nextOwner.display_name, { exact: true })).toBeVisible();
  await projectSection.getByRole("button", { name: "查看完整歷程" }).click();
  // 展開歷程要先打 API 再 render，按鈕翻成「收合歷程」才代表真的展開了。
  // 少了這一步，webkit 偶爾會在還沒 render 完就去找內容而失敗。
  await expect(projectSection.getByRole("button", { name: "收合歷程" })).toBeVisible();
  await expect(projectSection.getByText(transferReason, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: new RegExp(`^${targetClassName}`) }).click();
  await page.getByRole("button", { name: "目前名單" }).click();
  await expect(page.getByText(secondStudentName, { exact: true })).toBeVisible();
});


test("class staffing and new-term reclassification preserve old project content while access follows class", async ({ page }) => {
  // 這兩條走完整條園所流程（名冊、期別、相本、編班），webkit 本機就要 20～30 秒，
  // CI 的 runner 更慢會超過預設的 60 秒。慢是事實，不是壞掉——標 slow 讓它有三倍時間。
  test.slow();
  await loginViaApi(page);
  const suffix = `${Date.now().toString(36)}-${test.info().project.name}`;
  const teacherPassword = "organization-teacher-password";
  const initialLead = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-lead-${suffix}`,
        display_name: `原主教 ${suffix}`,
        password: teacherPassword,
        role: "teacher",
      },
    }),
    "建立原主教",
  );
  const initialCoTeacher = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-co-${suffix}`,
        display_name: `新主教 ${suffix}`,
        password: teacherPassword,
        role: "supervisor",
      },
    }),
    "建立可兼任帶班的主管帳號",
  );
  const targetLead = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-target-${suffix}`,
        display_name: `目標班主教 ${suffix}`,
        password: teacherPassword,
        role: "teacher",
      },
    }),
    "建立目標班老師",
  );
  const invalidDraftTeacher = await readJsonResponse(
    await page.request.post("/api/users/", {
      data: {
        username: `org-invalid-draft-${suffix}`,
        display_name: `草稿失效老師 ${suffix}`,
        password: teacherPassword,
        role: "teacher",
      },
    }),
    "建立草稿失效老師",
  );
  const period = await readJsonResponse(
    await page.request.post("/api/templates/periods", {
      form: {
        name: `編班驗收期別 ${suffix}`,
        department: "infant",
        status: "active",
      },
    }),
    "建立編班驗收期別",
  );
  const template = await readJsonResponse(
    await page.request.post("/api/templates/", {
      form: {
        name: `編班驗收模板 ${suffix}`,
        period_id: String(period.id),
      },
    }),
    "建立編班驗收模板",
  );
  const campusName = `編班分校 ${suffix}`;
  const sourceClassName = `海豚班 ${suffix}`;
  const targetClassName = `鯨魚班 ${suffix}`;
  const stayStudentName = `留班生${suffix}`;
  const moveStudentName = `轉班生${suffix}`;
  const departedStudentName = `離園生${suffix}`;
  const projectName = `重新編班前相本 ${suffix}`;
  const planLabel = `新學期編班 ${suffix}`;
  const campus = await readJsonResponse(
    await page.request.post("/api/organization/campuses", {
      data: { name: campusName },
    }),
    "建立編班分校",
  );
  const sourceClassroom = await readJsonResponse(
    await page.request.post("/api/organization/classrooms", {
      data: {
        campus_id: campus.id,
        department: "infant",
        name: sourceClassName,
      },
    }),
    "建立來源班級",
  );
  const targetClassroom = await readJsonResponse(
    await page.request.post("/api/organization/classrooms", {
      data: {
        campus_id: campus.id,
        department: "infant",
        name: targetClassName,
      },
    }),
    "建立目標班級",
  );
  await readJsonResponse(
    await page.request.post(`/api/organization/classrooms/${sourceClassroom.id}/members/batch`, {
      data: {
        members: [
          { name: stayStudentName },
          { name: moveStudentName },
          { name: departedStudentName },
        ],
      },
    }),
    "建立編班前目前名單",
  );

  await page.goto("/admin/organization");
  await expect(page.getByRole("heading", { name: "園所設定" })).toBeVisible();
  await page.getByRole("button", { name: campusName, exact: true }).click();
  await page.getByRole("button", { name: `${sourceClassName} 嬰幼部`, exact: true }).click();
  await page.getByRole("button", { name: "設定老師" }).click();
  const teacherDialog = page.getByRole("dialog", { name: `設定老師：${sourceClassName}` });
  await teacherDialog.getByRole("combobox").selectOption(String(initialLead.id));
  await teacherDialog.getByLabel(initialCoTeacher.display_name, { exact: true }).check();
  const staffingResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/organization/classrooms/${sourceClassroom.id}/teachers`
  ));
  await teacherDialog.getByRole("button", { name: "儲存老師編制" }).click();
  expect((await staffingResponsePromise).ok()).toBeTruthy();
  await expect(page.getByText(`${initialLead.display_name} · 主教`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${initialCoTeacher.display_name} · 協同`, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "建立新一期相本" }).click();
  const projectDialog = page.getByRole("dialog", { name: `建立新一期相本：${sourceClassName}` });
  await projectDialog.getByLabel("相本名稱").fill(projectName);
  const secondProjectSlotSelect = projectDialog.getByLabel("正式學期期別");
  const secondProjectSlotValue = await secondProjectSlotSelect.locator("option")
    .filter({ hasText: template.period_name })
    .first()
    .getAttribute("value");
  expect(secondProjectSlotValue).toBeTruthy();
  await secondProjectSlotSelect.selectOption(secondProjectSlotValue);
  await projectDialog.getByLabel("此期模板").selectOption(String(template.id));
  await expect(projectDialog.getByLabel("目前負責老師")).toHaveValue(String(initialLead.id));
  await expect(projectDialog.getByLabel("目前負責老師").locator("option")).toHaveCount(3);
  const createProjectResponsePromise = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/organization/classrooms/${sourceClassroom.id}/projects`
  ));
  await projectDialog.getByRole("button", { name: "建立相本", exact: true }).click();
  const project = await readJsonResponse(
    await createProjectResponsePromise,
    "以班級目前狀態建立相本",
  );
  expect(project.owner_id).toBe(initialLead.id);
  expect(project).not.toHaveProperty("editors");
  expect(project.campus_name).toBe(campusName);
  expect(project.classroom_name).toBe(sourceClassName);
  expect(project.students.map(student => student.name).sort()).toEqual([
    departedStudentName,
    moveStudentName,
    stayStudentName,
  ].sort());
  const projectSection = page.getByRole("region", { name: `相本 ${projectName}` });
  await expect(projectSection.getByText(initialLead.display_name, { exact: true })).toBeVisible();
  await expect(projectSection.getByText(
    "存取權限直接來自目前班級老師編制；負責人只用於主要進度歸戶。",
    { exact: true },
  )).toBeVisible();
  const projectBeforeReclassification = await readJsonResponse(
    await page.request.get(`/api/projects/${project.id}`),
    "取得重新編班前相本",
  );
  const expectedStableProject = stableProjectSnapshot(projectBeforeReclassification);

  await cancelLeftoverTermPlan(page);
  await page.getByRole("link", { name: "新學期編班" }).click();
  await expect(page.getByRole("heading", { name: "新學期編班" })).toBeVisible();
  await page.getByLabel("正式學期名稱").fill(planLabel);
  const createPlanResponsePromise = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/organization/term-reclassification-plans"
  ));
  await page.getByRole("button", { name: "從目前狀態建立草稿" }).click();
  const draftPlan = await readJsonResponse(await createPlanResponsePromise, "建立新學期編班草稿");
  await expect(page.getByRole("heading", { name: planLabel, exact: true })).toBeVisible();

  // 計畫裡的班一律是目標學期新建的班；舊班 id 只出現在來源欄位
  const nextSemesterClassroomId = name => {
    const match = draftPlan.target_classrooms.find(row => row.name === name);
    expect(match, `目標學期缺少班級 ${name}`).toBeTruthy();
    return match.classroom_id;
  };
  const nextSourceClassroomId = nextSemesterClassroomId(sourceClassName);
  const nextTargetClassroomId = nextSemesterClassroomId(targetClassName);
  expect(nextSourceClassroomId).not.toBe(sourceClassroom.id);

  const targetPeriod = await readJsonResponse(
    await page.request.post("/api/templates/periods", {
      form: {
        name: `新學期驗收期別 ${suffix}`,
        department: "infant",
        status: "active",
        semester_id: String(draftPlan.target_semester_id),
      },
    }),
    "建立新學期正式期別",
  );
  await readJsonResponse(
    await page.request.post("/api/templates/", {
      form: {
        name: `新學期驗收模板 ${suffix}`,
        period_id: String(targetPeriod.id),
      },
    }),
    "建立新學期模板",
  );

  // 看板：卡片點一下選取，再點目標班級的標題整批搬過去
  const studentCard = name => page.locator("#term-board").getByRole("button", {
    name, exact: true,
  });
  const columnHeader = className => page.getByRole("button", {
    name: new RegExp(`^(重新命名|放進) ${campusName}／${className}$`),
  });
  const departedColumn = page.getByRole("button", { name: /^(重新命名|放進) 離園$/ });

  // 看板依分校分頁，預設停在第一個分校；重載後也會重置，所以每次都要切回來
  const openCampusTab = () => page.getByRole("button", { name: `切換到 ${campusName}` }).click();
  await openCampusTab();
  await expect(studentCard(stayStudentName)).toBeVisible();
  await studentCard(moveStudentName).click();
  await expect(studentCard(moveStudentName)).toHaveAttribute("aria-pressed", "true");
  await columnHeader(targetClassName).click();
  await expect(studentCard(moveStudentName)).toHaveAttribute("aria-pressed", "false");

  // 離園走卡片上的 ×，不必拖到最後一欄
  await page.getByRole("button", { name: `把 ${departedStudentName} 標記為離園` }).click();
  await expect(departedColumn).toBeVisible();

  const changedStudentsOnly = page.getByLabel("僅顯示有變更", { exact: true });
  await changedStudentsOnly.check();
  await expect(studentCard(stayStudentName)).toHaveCount(0);
  await expect(studentCard(moveStudentName)).toBeVisible();
  await changedStudentsOnly.uncheck();
  const studentSearch = page.getByLabel("搜尋學生或班級", { exact: true });
  await studentSearch.fill(departedStudentName);
  await expect(studentCard(moveStudentName)).toHaveCount(0);
  await expect(studentCard(departedStudentName)).toBeVisible();
  await studentSearch.fill("");

  await page.getByRole("button", { name: "返回班級與名單", exact: true }).click();
  const dirtyLeaveDialog = page.getByRole("dialog", { name: "放棄變更並離開" });
  await expect(dirtyLeaveDialog).toBeVisible();
  await dirtyLeaveDialog.getByRole("button", { name: "取消", exact: true }).click();

  const openTeacherEditor = className => page.getByRole("button", {
    name: `調整 ${campusName}／${className} 的老師`,
  });
  await openTeacherEditor(sourceClassName).click();
  const sourceTeacherDialog = page.getByRole("dialog", {
    name: `調整老師：${campusName}／${sourceClassName}`,
  });
  await sourceTeacherDialog.getByLabel("主教", { exact: true }).selectOption(String(initialCoTeacher.id));
  await sourceTeacherDialog.getByRole("button", { name: "套用老師設定", exact: true }).click();
  await openTeacherEditor(targetClassName).click();
  let targetTeacherDialog = page.getByRole("dialog", {
    name: `調整老師：${campusName}／${targetClassName}`,
  });
  await targetTeacherDialog.getByLabel("主教", { exact: true }).selectOption(String(invalidDraftTeacher.id));
  await targetTeacherDialog.getByRole("button", { name: "套用老師設定", exact: true }).click();

  const saveInvalidTargetResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/organization/term-reclassification-plans/${draftPlan.id}`
  ));
  await page.getByRole("button", { name: "儲存草稿" }).click();
  expect((await saveInvalidTargetResponsePromise).ok()).toBeTruthy();
  const disabledDraftTeacher = await readJsonResponse(
    await page.request.patch(`/api/users/${invalidDraftTeacher.id}`, {
      data: { role: "none" },
    }),
    "停用只存在草稿中的老師",
  );
  expect(disabledDraftTeacher.role).toBe("none");

  await page.reload();
  await expect(page.getByRole("heading", { name: planLabel, exact: true })).toBeVisible();
  await openCampusTab();
  await openTeacherEditor(targetClassName).click();
  targetTeacherDialog = page.getByRole("dialog", {
    name: `調整老師：${campusName}／${targetClassName}`,
  });
  const invalidTeacherTargets = targetTeacherDialog
    .getByText("已失效的老師目標", { exact: true })
    .locator("..");
  await expect(invalidTeacherTargets).toBeVisible();
  await expect(invalidTeacherTargets.getByText(
    `${invalidDraftTeacher.display_name} · 主教`,
    { exact: true },
  )).toBeVisible();
  await invalidTeacherTargets.getByRole("button", { name: "移除" }).click();
  await targetTeacherDialog.getByRole("button", { name: "套用老師設定", exact: true }).click();
  const saveRemovedTargetResponsePromise = page.waitForResponse(response => (
    response.request().method() === "PUT"
    && new URL(response.url()).pathname === `/api/organization/term-reclassification-plans/${draftPlan.id}`
  ));
  await page.getByRole("button", { name: "儲存草稿" }).click();
  expect((await saveRemovedTargetResponsePromise).ok()).toBeTruthy();
  // 看板上該欄的老師區會顯示「尚無老師」
  await expect(
    page.getByRole("button", { name: `調整 ${campusName}／${targetClassName} 的老師` })
      .locator("xpath=preceding-sibling::p[1]"),
  ).toHaveText("尚無老師");
  await openTeacherEditor(targetClassName).click();
  targetTeacherDialog = page.getByRole("dialog", {
    name: `調整老師：${campusName}／${targetClassName}`,
  });
  await targetTeacherDialog.getByLabel("主教", { exact: true }).selectOption(String(targetLead.id));
  await targetTeacherDialog.getByRole("button", { name: "套用老師設定", exact: true }).click();

  const validateResponsePromise = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/organization/term-reclassification-plans/${draftPlan.id}/validate`
  ));
  await page.getByRole("button", { name: "預覽並驗證" }).click();
  const validatedPlan = await readJsonResponse(await validateResponsePromise, "驗證新學期編班草稿");
  expect(validatedPlan.validation.is_valid).toBe(true);
  expect(validatedPlan.diff.students.stay.map(row => row.student_name)).toContain(stayStudentName);
  expect(validatedPlan.diff.students.move.map(row => row.student_name)).toContain(moveStudentName);
  expect(validatedPlan.diff.students.departed.map(row => row.student_name)).toContain(departedStudentName);
  expect(validatedPlan.diff.students.classroom_counts).toEqual(expect.arrayContaining([
    {
      classroom_id: nextSourceClassroomId,
      before: 3,
      after: 1,
      change: -2,
    },
    {
      classroom_id: nextTargetClassroomId,
      before: 0,
      after: 1,
      change: 1,
    },
  ]));
  expect(validatedPlan.diff.teachers.remove).toEqual(expect.arrayContaining([
    expect.objectContaining({ classroom_id: nextSourceClassroomId, teacher_id: initialLead.id }),
  ]));
  expect(validatedPlan.diff.teachers.duty_change).toEqual(expect.arrayContaining([
    expect.objectContaining({
      classroom_id: nextSourceClassroomId,
      teacher_id: initialCoTeacher.id,
      from_duty: "co_teacher",
      to_duty: "lead",
    }),
  ]));
  expect(validatedPlan.diff.teachers.add).toEqual(expect.arrayContaining([
    expect.objectContaining({ classroom_id: nextTargetClassroomId, teacher_id: targetLead.id }),
  ]));
  await expect(page.getByText("驗證通過", { exact: true })).toBeVisible();

  const classroomCountsSection = page.getByRole("heading", { name: "各班學生人數" }).locator("..");
  const sourceClassroomCount = classroomCountsSection
    .getByText(`${campusName}／${sourceClassName}`, { exact: true })
    .locator("..");
  const targetClassroomCount = classroomCountsSection
    .getByText(`${campusName}／${targetClassName}`, { exact: true })
    .locator("..");
  await expect(sourceClassroomCount).toContainText("3 → 1");
  await expect(sourceClassroomCount).toContainText("(-2)");
  await expect(targetClassroomCount).toContainText("0 → 1");
  await expect(targetClassroomCount).toContainText("(+1)");

  const moveDetails = page.getByRole("heading", { name: "轉班明細" }).locator("..");
  await expect(moveDetails.getByText(
    `${moveStudentName}：${campusName}／${sourceClassName} → ${campusName}／${targetClassName}`,
    { exact: true },
  )).toBeVisible();
  const departedDetails = page.getByRole("heading", { name: "離園／畢業明細" }).locator("..");
  await expect(departedDetails.getByText(
    `${departedStudentName}：${campusName}／${sourceClassName} → 離園／畢業`,
    { exact: true },
  )).toBeVisible();

  const teacherDetails = page.getByRole("heading", { name: "老師編制異動明細" }).locator("..");
  await expect(teacherDetails.getByText(
    `${campusName}／${targetClassName}：新增 ${targetLead.display_name}（主教）`,
    { exact: true },
  )).toBeVisible();
  await expect(teacherDetails.getByText(
    `${campusName}／${sourceClassName}：移除 ${initialLead.display_name}（主教）`,
    { exact: true },
  )).toBeVisible();
  await expect(teacherDetails.getByText(
    `${campusName}／${sourceClassName}：${initialCoTeacher.display_name} 協同老師 → 主教`,
    { exact: true },
  )).toBeVisible();

  const overviewBeforeApply = await readJsonResponse(
    await page.request.get("/api/organization/overview"),
    "確認草稿未改目前狀態",
  );
  const sourceBeforeApply = findClassroom(overviewBeforeApply, sourceClassroom.id);
  const targetBeforeApply = findClassroom(overviewBeforeApply, targetClassroom.id);
  expect(sourceBeforeApply.members.filter(member => member.status === "active").map(member => member.name).sort()).toEqual([
    departedStudentName,
    moveStudentName,
    stayStudentName,
  ].sort());
  expect(sourceBeforeApply.current_teachers).toEqual(expect.arrayContaining([
    expect.objectContaining({ teacher_id: initialLead.id, duty: "lead" }),
    expect.objectContaining({ teacher_id: initialCoTeacher.id, duty: "co_teacher" }),
  ]));
  expect(targetBeforeApply.current_teachers).toEqual([]);
  expect(stableProjectSnapshot(await readJsonResponse(
    await page.request.get(`/api/projects/${project.id}`),
    "確認草稿期間舊相本不變",
  ))).toEqual(expectedStableProject);

  await page.getByRole("button", { name: "確認套用新學期編班" }).click();
  const applyDialog = page.getByRole("dialog", { name: "確認套用" });
  const applyResponsePromise = page.waitForResponse(response => (
    response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/organization/term-reclassification-plans/${draftPlan.id}/apply`
  ));
  await applyDialog.getByRole("button", { name: "確認套用" }).click();
  const appliedPlan = await readJsonResponse(await applyResponsePromise, "套用新學期編班");
  expect(appliedPlan.status).toBe("applied");
  await expect(page.getByRole("heading", { name: `${planLabel} 已套用` })).toBeVisible();

  const overviewAfterApply = await readJsonResponse(
    await page.request.get("/api/organization/overview"),
    "取得套用後園所狀態",
  );
  // 套用後目前學期換成新學期，園所設定只列新學期的班；舊學期那些以
  // term_reassignment／term_departed 結束的區間由 pytest 的
  // test_term_plan_applies_students_and_teachers_without_rewriting_old_project 守。
  expect(findClassroom(overviewAfterApply, sourceClassroom.id)).toBeUndefined();
  const sourceAfterApply = findClassroom(overviewAfterApply, nextSourceClassroomId);
  const targetAfterApply = findClassroom(overviewAfterApply, nextTargetClassroomId);
  expect(sourceAfterApply.members.filter(member => member.status === "active").map(member => member.name)).toEqual([
    stayStudentName,
  ]);
  expect(targetAfterApply.members.filter(member => member.status === "active").map(member => member.name)).toEqual([
    moveStudentName,
  ]);
  expect(sourceAfterApply.current_teachers).toEqual([
    expect.objectContaining({ teacher_id: initialCoTeacher.id, duty: "lead" }),
  ]);
  expect(targetAfterApply.current_teachers).toEqual([
    expect.objectContaining({ teacher_id: targetLead.id, duty: "lead" }),
  ]);
  const movedMembership = targetAfterApply.members.find(member => member.name === moveStudentName && member.status === "active");
  const stayMembership = sourceAfterApply.members.find(member => member.name === stayStudentName && member.status === "active");
  expect(new Set([
    movedMembership.started_at,
    stayMembership.started_at,
    sourceAfterApply.current_teachers[0].started_at,
    targetAfterApply.current_teachers[0].started_at,
  ]).size).toBe(1);
  expect(stableProjectSnapshot(await readJsonResponse(
    await page.request.get(`/api/projects/${project.id}`),
    "確認套用後舊相本不變",
  ))).toEqual(expectedStableProject);

  await loginWithCredentials(
    page,
    initialCoTeacher.username,
    teacherPassword,
  );
  await expect(page.getByRole("heading", { name: "相本工作" })).toBeVisible();
  const sourceClassHeading = page.getByRole("heading", { name: sourceClassName, exact: true });
  await expect(sourceClassHeading).toBeVisible();
  await expect(page.getByText("主教", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "建立新一期相本" })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建專案" })).toHaveCount(0);
  // 舊相本屬於已結束學期的班：那個班的指派已 ended，所以可讀不可製作。
  // 它會落在「我帶過的班級」唯讀區，而不是可編輯的班級卡片裡。
  const pastClassroomSection = page.getByRole("heading", { name: "我帶過的班級" }).locator("..");
  await expect(pastClassroomSection).toBeVisible();
  await expect(page.getByText(projectName, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "編輯相本" })).toHaveCount(0);
  const forbiddenGenericCreate = await page.request.post("/api/projects/", {
    form: {
      name: `不可繞過班級建立 ${suffix}`,
      template_id: String(template.id),
    },
  });
  expect(forbiddenGenericCreate.status()).toBe(405);
});
