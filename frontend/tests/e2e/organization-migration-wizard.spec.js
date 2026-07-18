import { expect, test } from "@playwright/test";


function buildOverview({ isMigrated = false } = {}) {
  const students = Array.from({ length: 100 }, (_, studentIndex) => ({
    id: studentIndex + 1,
    name: `測試學生${String(studentIndex + 1).padStart(3, "0")}`,
    album_name: null,
    effective_album_name: `測試學生${String(studentIndex + 1).padStart(3, "0")}`,
    order_index: studentIndex,
    roster_child_id: studentIndex + 5000,
  }));
  const legacyProject = {
    id: 700,
    name: "100 人舊相本",
    classroom_id: null,
    department: "infant",
    template_period_name: "舊學期",
    owner_name: "測試管理員",
    created_by_name: "測試管理員",
    assignment_history: [],
    students,
  };
  return {
    campuses: [{
      id: 10,
      name: "測試分校",
      is_active: true,
      supervisor_scopes: { current: [], history: [] },
      classrooms: [{
        id: 20,
        campus_id: 10,
        department: "infant",
        name: "彩虹班",
        is_active: true,
        current_teachers: [],
        teacher_history: [],
        members: [],
        projects: [],
      }],
    }],
    unassigned_projects: isMigrated ? [] : [legacyProject],
    teacher_options: [],
    supervisor_options: [],
    templates: [],
    draft_term_plan_id: null,
    migration_status: {
      unassigned_project_count: isMigrated ? 0 : 1,
      pending_identity_student_count: isMigrated ? 0 : 100,
      archived_teacher_supervisor_link_count: 0,
      archived_identity_resolution_count: isMigrated ? 105 : 5,
      assigned_identity_anomaly_count: isMigrated ? 0 : 2,
      is_complete: isMigrated,
    },
  };
}


function buildPreview(fingerprintCharacter = "a") {
  const students = Array.from({ length: 100 }, (_, studentIndex) => ({
    student_id: studentIndex + 1,
    name: `測試學生${String(studentIndex + 1).padStart(3, "0")}`,
    order_index: studentIndex,
    original_roster_child: {
      id: studentIndex + 5000,
      name: `測試學生${String(studentIndex + 1).padStart(3, "0")}`,
    },
    allowed_existing_roster_child_ids: studentIndex === 0 ? [9001, 9002] : [],
  }));
  return {
    source_fingerprint: fingerprintCharacter.repeat(64),
    target_classroom: {
      id: 20,
      campus_id: 10,
      campus_name: "測試分校",
      name: "彩虹班",
      department: "infant",
      active_roster_count: 0,
      seed_allowed: true,
    },
    students,
    established_candidates: [{
      roster_child_id: 9001,
      name: "測試學生001",
      evidence: [{
        kind: "target_membership",
        campus_id: 10,
        campus_name: "測試分校",
        classroom_id: 20,
        classroom_name: "彩虹班",
        department: "infant",
        status: "active",
      }],
    }, {
      roster_child_id: 9002,
      name: "測試學生001",
      evidence: [{
        kind: "same_name_membership",
        campus_id: 11,
        campus_name: "另一分校",
        classroom_id: 21,
        classroom_name: "星星班",
        department: "infant",
        status: "ended",
      }, {
        kind: "same_name_project",
        campus_id: 11,
        campus_name: "另一分校",
        classroom_id: 21,
        classroom_name: "星星班",
        department: "infant",
        project_id: 610,
        project_name: "去年成長相本",
        period_id: 31,
        period_name: "2025 下學期",
        status: "active",
      }],
    }],
  };
}


test("organization migration wizard reviews 100 identities before one full commit", async ({ page }) => {
  let isMigrated = false;
  let previewFingerprintCharacter = "a";
  const submittedPayloads = [];

  await page.route("**/api/auth/me", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: 1,
      username: "admin",
      display_name: "測試管理員",
      role: "admin",
    }),
  }));
  await page.route("**/api/organization/overview", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(buildOverview({ isMigrated })),
  }));
  await page.route(
    "**/api/organization/projects/700/classroom-migration-preview?**",
    route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildPreview(previewFingerprintCharacter)),
    }),
  );
  await page.route("**/api/organization/projects/700/classroom", async route => {
    submittedPayloads.push(route.request().postDataJSON());
    if (submittedPayloads.length === 1) {
      previewFingerprintCharacter = "b";
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          detail: {
            code: "stale_project_classroom_migration_preview",
            message: "相本學生、目標班級或可用身分已變更，請重新預覽",
          },
        }),
      });
      return;
    }
    isMigrated = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ project: { id: 700, classroom_id: 20 } }),
    });
  });

  await page.goto("/admin/organization");
  await expect(page.getByRole("heading", { name: "園所設定" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "已有 2 位已歸班學生身分異常" })).toBeVisible();
  await expect(page.getByText("共 100 位學生待逐筆核對身分。")).toBeVisible();
  await expect(page.getByText("已封存 5 筆學生身分遷移決策供稽核。")).toBeVisible();

  const legacyProject = page.getByRole("group", { name: "未歸班相本 100 人舊相本" });
  await legacyProject.getByRole("button", { name: "歸入班級" }).click();
  const dialog = page.getByRole("dialog", { name: "舊相本歸班：100 人舊相本" });
  await dialog.getByRole("button", { name: "關閉" }).click();
  await expect(dialog).toHaveCount(0);
  await legacyProject.getByRole("button", { name: "歸入班級" }).click();
  await expect(dialog.getByLabel("歸入班級")).toHaveValue("");
  await dialog.getByLabel("歸入班級").selectOption("20");
  await expect(dialog.getByText("舊相本學生").locator("..").getByText("100 位")).toBeVisible();
  await dialog.getByLabel("以相本全部學生建立目前名單").check();
  await dialog.getByRole("button", { name: "下一步：核對學生身分" }).click();

  await expect(dialog.getByText("第 1／4 頁，共 100 位")).toBeVisible();
  await expect(dialog.getByText("未決定 100")).toBeVisible();
  await dialog.getByText("查看 2 個既有身分的班級／相本證據").click();
  await expect(dialog.getByText(
    "歷史名單｜另一分校／嬰幼部／星星班｜已結束；"
    + "歷史相本｜另一分校／嬰幼部／星星班｜「去年成長相本」 #610｜期別：2025 下學期",
    { exact: true },
  )).toBeVisible();
  await dialog.getByRole("button", { name: "套用目標班唯一同名候選" }).click();
  await expect(dialog.getByText("既有身分 1")).toBeVisible();
  await dialog.getByRole("button", { name: "全部未決定設為建立新身分" }).click();
  await expect(dialog.getByText("新身分 99")).toBeVisible();
  await dialog.getByRole("button", { name: "下一步：確認遷移" }).click();

  await expect(dialog.getByText("建立全新身分").locator("..").getByText("99 位")).toBeVisible();
  await expect(dialog.getByText("連結既有身分").locator("..").getByText("1 位")).toBeVisible();
  await dialog.getByRole("checkbox", {
    name: /我已逐筆核對全部學生；同名不代表同一人/,
  }).check();
  await dialog.getByRole("button", { name: "確認遷移 100 位學生" }).click();

  await expect(dialog.getByText(/已重新載入候選，系統沒有自動重送/)).toBeVisible();
  expect(submittedPayloads).toHaveLength(1);
  await expect(dialog.getByText("新身分 99")).toBeVisible();
  await expect(dialog.getByText("既有身分 1")).toBeVisible();
  await dialog.getByRole("button", { name: "下一步：確認遷移" }).click();
  const confirmationCheckbox = dialog.getByRole("checkbox", {
    name: /我已逐筆核對全部學生；同名不代表同一人/,
  });
  await expect(confirmationCheckbox).not.toBeChecked();
  await confirmationCheckbox.check();
  await dialog.getByRole("button", { name: "確認遷移 100 位學生" }).click();

  await expect(dialog).toHaveCount(0);
  expect(submittedPayloads).toHaveLength(2);
  expect(submittedPayloads[0]).toMatchObject({
    classroom_id: 20,
    source_fingerprint: "a".repeat(64),
    confirmed_all: true,
    seed_current_roster: true,
  });
  expect(submittedPayloads[1]).toMatchObject({
    classroom_id: 20,
    source_fingerprint: "b".repeat(64),
    confirmed_all: true,
    seed_current_roster: true,
  });
  expect(submittedPayloads[1].student_identity_decisions).toHaveLength(100);
  expect(submittedPayloads[1].student_identity_decisions[0]).toEqual({
    student_id: 1,
    action: "existing",
    roster_child_id: 9001,
  });
  expect(submittedPayloads[1].student_identity_decisions.slice(1)).toEqual(
    Array.from({ length: 99 }, (_, studentIndex) => ({
      student_id: studentIndex + 2,
      action: "create_new",
    })),
  );
  await expect(page.getByRole("heading", { name: "舊相本歸班完成" })).toBeVisible();
});
