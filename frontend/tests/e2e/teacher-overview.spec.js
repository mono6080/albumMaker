import { expect, test } from "@playwright/test";

const terms = [
  {
    id: 1,
    label: "114 學年度上學期",
    status: "active",
    periods: [
      { id: 101, template_period_id: 11, name: "九月", department: "infant", position: 1 },
      { id: 102, template_period_id: 12, name: "十月", department: "infant", position: 2 },
      { id: 103, template_period_id: 13, name: "學院九月", department: "academy", position: 3 },
    ],
  },
  {
    id: 2,
    label: "114 學年度下學期",
    status: "closed",
    periods: [
      { id: 201, template_period_id: 21, name: "二月", department: "infant", position: 1 },
    ],
  },
];

function project({
  projectId,
  projectName,
  ownerName,
  contentStatus = "incomplete",
  workflowStatus = "working",
  attentionCodes = [],
}) {
  return {
    project_id: projectId,
    project_name: projectName,
    owner_id: projectId,
    owner_name: ownerName,
    student_count: 2,
    photo_filled: contentStatus === "ready" ? 4 : 2,
    photo_total: 4,
    text_filled: contentStatus === "ready" ? 4 : 3,
    text_total: 4,
    blank_text_count: contentStatus === "ready" ? 0 : 1,
    content_status: contentStatus,
    workflow_status: workflowStatus,
    attention_codes: attentionCodes,
    students: [
      { student_id: projectId * 10, student_name: "小安" },
      { student_id: projectId * 10 + 1, student_name: "小庭" },
    ],
  };
}

function classroom({ classroomId, classroomName, department = "infant", slots }) {
  return {
    classroom_id: classroomId,
    campus_id: department === "infant" ? 1 : 2,
    campus_name: department === "infant" ? "和平校" : "復興校",
    classroom_name: classroomName,
    department,
    teachers: [
      {
        teacher_id: classroomId * 10,
        teacher_name_snapshot: `${classroomName}主教`,
        duty: "lead",
        ended_at: null,
      },
      {
        teacher_id: classroomId * 10 + 1,
        teacher_name_snapshot: `${classroomName}協同`,
        duty: "co_teacher",
        ended_at: null,
      },
    ],
    slots,
  };
}

function activeOverview() {
  return {
    term: { id: 1, label: "114 學年度上學期", status: "active" },
    periods: terms[0].periods.map(period => ({
      ...period,
      semester_period_id: period.id,
      id: period.template_period_id,
    })),
    summary: {},
    classrooms: [
      classroom({
        classroomId: 1,
        classroomName: "星星班",
        slots: [
          {
            work_slot_id: 501,
            semester_period_id: 101,
            period_id: 11,
            creation_status: "single",
            projects: [project({
              projectId: 101,
              projectName: "星星九月紀錄",
              ownerName: "星星班主教",
              contentStatus: "ready",
            })],
          },
          {
            work_slot_id: 502,
            semester_period_id: 102,
            period_id: 12,
            creation_status: "not_created",
            projects: [],
          },
        ],
      }),
      classroom({
        classroomId: 2,
        classroomName: "月亮班",
        slots: [
          {
            work_slot_id: 503,
            semester_period_id: 101,
            period_id: 11,
            creation_status: "archived",
            projects: [],
          },
        ],
      }),
      classroom({
        classroomId: 3,
        classroomName: "太陽班",
        slots: [
          {
            work_slot_id: 504,
            semester_period_id: 101,
            period_id: 11,
            creation_status: "multiple_projects",
            projects: [
              project({ projectId: 301, projectName: "太陽舊本 A", ownerName: "前任老師" }),
              project({
                projectId: 302,
                projectName: "太陽舊本 B",
                ownerName: "太陽班主教",
                workflowStatus: "submitted_locked",
                attentionCodes: ["submitted_with_missing_photos"],
              }),
            ],
          },
        ],
      }),
      classroom({
        classroomId: 9,
        classroomName: "學院限定班",
        department: "academy",
        slots: [
          {
            work_slot_id: 509,
            semester_period_id: 103,
            period_id: 13,
            creation_status: "single",
            projects: [project({ projectId: 901, projectName: "學院相本", ownerName: "學院老師" })],
          },
        ],
      }),
    ],
  };
}

function secondTermOverview() {
  return {
    term: { id: 2, label: "114 學年度下學期", status: "closed" },
    periods: [{
      id: 21,
      semester_period_id: 201,
      template_period_id: 21,
      name: "二月",
      department: "infant",
      position: 1,
    }],
    summary: {},
    classrooms: [classroom({
      classroomId: 20,
      classroomName: "下學期班",
      slots: [{
        work_slot_id: 520,
        semester_period_id: 201,
        period_id: 21,
        creation_status: "not_created",
        projects: [],
      }],
    })],
  };
}

async function mockBase(page) {
  await page.route("**/api/auth/me", route => route.fulfill({
    json: {
      id: 1,
      username: "admin",
      display_name: "管理員",
      role: "admin",
      ui_font_scale: 1,
    },
  }));
  await page.route("**/api/roster/semesters", route => route.fulfill({ json: { terms } }));
}

test("teacher progress uses classroom-period slots and never creates a false co-teacher card", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBase(page);
  await page.route("**/api/roster/teacher-progress?**", route => route.fulfill({ json: activeOverview() }));

  await page.goto("/admin/teacher-overview");
  await expect(page.getByRole("heading", { name: "老師進度" })).toBeVisible();
  await expect(page.getByText("星星班協同 · 協同", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("尚未開始", { exact: true })).toHaveCount(0);
  await expect(page.getByText("學院限定班", { exact: true })).toHaveCount(0);

  const statusFilter = page.getByRole("group", { name: "篩選班級期別狀態" });
  await expect(statusFilter.getByRole("button", { name: "全部 3" })).toBeVisible();
  await expect(statusFilter.getByRole("button", { name: "需要處理 3" })).toBeVisible();

  await page.getByRole("button", { name: /和平校.*星星班/ }).click();
  const starPanel = page.locator("#teacher-classroom-1");
  await expect(starPanel.getByText("未建立相本", { exact: true })).toBeVisible();
  await expect(starPanel.getByText("內容完整", { exact: true })).toBeVisible();
  await expect(starPanel.getByRole("progressbar", { name: /文字完成度/ })).toHaveAttribute("aria-valuenow", "4");
  await expect(starPanel.getByText("製作中", { exact: true })).toBeVisible();
  await expect(starPanel.getByText("負責人：星星班主教", { exact: true })).toBeVisible();
  await expect(starPanel.getByText(/PDF/)).toHaveCount(0);

  await page.getByRole("button", { name: /和平校.*月亮班/ }).click();
  const moonPanel = page.locator("#teacher-classroom-2");
  await expect(moonPanel.getByText("相本已封存／不可重做", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /和平校.*太陽班/ }).click();
  const sunPanel = page.locator("#teacher-classroom-3");
  await expect(sunPanel.getByText("同一工作格有 2 本相本", { exact: true })).toBeVisible();
  await expect(sunPanel.getByText("已交件鎖定", { exact: true })).toBeVisible();
  await expect(sunPanel.getByText("交件後仍缺照片", { exact: true })).toBeVisible();

  const controlHeights = await page.locator(
    'select, input[type="search"], [role="group"] button',
  ).evaluateAll(elements => elements.filter(element => element.offsetParent).map(
    element => element.getBoundingClientRect().height,
  ));
  expect(Math.min(...controlHeights)).toBeGreaterThanOrEqual(44);
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 2);
});

test("teacher progress keeps errors persistent and retries", async ({ page }) => {
  await mockBase(page);
  let attempts = 0;
  await page.route("**/api/roster/teacher-progress?**", route => {
    attempts += 1;
    if (attempts === 1) return route.fulfill({ status: 500, json: { detail: "temporary" } });
    return route.fulfill({ json: activeOverview() });
  });

  await page.goto("/admin/teacher-overview");
  await expect(page.getByRole("alert")).toHaveText("載入班級期別進度失敗，請檢查網路後重試。");
  await expect(page.getByText("此學期與部門沒有班級工作格。", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "重試" }).click();
  await expect(page.getByText("星星班", { exact: true }).first()).toBeVisible();
});

test("a slower previous term response cannot replace the selected term", async ({ page }) => {
  await mockBase(page);
  let releaseFirstTerm;
  let markFirstTermStarted;
  const firstTermGate = new Promise(resolve => { releaseFirstTerm = resolve; });
  const firstTermStarted = new Promise(resolve => { markFirstTermStarted = resolve; });
  await page.route("**/api/roster/teacher-progress?**", async route => {
    const termId = new URL(route.request().url()).searchParams.get("semester_id");
    if (termId === "1") {
      markFirstTermStarted();
      await firstTermGate;
      await route.fulfill({ json: activeOverview() });
      return;
    }
    await route.fulfill({ json: secondTermOverview() });
  });

  await page.goto("/admin/teacher-overview");
  await firstTermStarted;
  await page.getByLabel("選擇學期").selectOption("2");
  await expect(page.getByText("下學期班", { exact: true }).first()).toBeVisible();
  releaseFirstTerm();
  await page.waitForTimeout(150);
  await expect(page.getByText("下學期班", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("星星班", { exact: true })).toHaveCount(0);
});
