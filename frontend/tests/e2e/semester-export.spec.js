import { expect, test } from "@playwright/test";

const term = {
  id: 1,
  label: "114 學年度上學期",
  status: "active",
  periods: [
    { id: 101, template_period_id: 11, name: "九月", department: "infant", position: 1 },
    { id: 102, template_period_id: 12, name: "十月", department: "infant", position: 2 },
  ],
};

function entry({ projectId, projectName, studentId, campusId, campusName, classroomId, classroomName }) {
  return {
    project_id: projectId,
    project_name: projectName,
    student_id: studentId,
    student_name: `學生 ${studentId}`,
    owner_id: 1,
    owner_name: "帶班老師",
    campus_id: campusId,
    campus_name: campusName,
    classroom_id: classroomId,
    classroom_name: classroomName,
    department: "infant",
    has_pdf: true,
    skipped_pages: [],
  };
}

function cell(templatePeriodId, status, entries = []) {
  return {
    term_period_id: templatePeriodId === 11 ? 101 : 102,
    template_period_id: templatePeriodId,
    status,
    entries,
  };
}

function child(rosterChildId, name, cells) {
  return { roster_child_id: rosterChildId, name, cells };
}

function previewPayload({ classroomName = "向日葵班", periodIds = [11, 12] } = {}) {
  const peaceEntry = (projectId, projectName, studentId) => entry({
    projectId,
    projectName,
    studentId,
    campusId: 1,
    campusName: "和平校",
    classroomId: 10,
    classroomName,
  });
  const groups = [{
    campus_id: 1,
    campus_name: "和平校",
    classroom_id: 10,
    classroom_name: classroomName,
    department: "infant",
    children: [
      child(1, "測試歷史生", [
        cell(11, "ready", [peaceEntry(101, "名稱完全不像班級的相本", 1001)]),
        cell(12, "departed"),
      ]),
      child(2, "十月新生", [
        cell(11, "not_enrolled"),
        cell(12, "ready", [peaceEntry(102, "新生觀察紀錄", 1002)]),
      ]),
      child(3, "真正缺相本", [
        cell(11, "ready", [peaceEntry(103, "九月成長紀錄", 1003)]),
        cell(12, "no_album"),
      ]),
      child(4, "重複學生", [
        cell(11, "duplicate", [
          peaceEntry(104, "重複來源 A", 1004),
          peaceEntry(105, "重複來源 B", 1005),
        ]),
        cell(12, "not_enrolled"),
      ]),
    ],
  }, {
    campus_id: 2,
    campus_name: "復興校",
    classroom_id: 20,
    classroom_name: "向日葵班",
    department: "infant",
    children: [child(5, "尚未渲染學生", [
      cell(11, "not_rendered", [entry({
        projectId: 201,
        projectName: "復興成長冊",
        studentId: 2001,
        campusId: 2,
        campusName: "復興校",
        classroomId: 20,
        classroomName: "向日葵班",
      })]),
      cell(12, "not_enrolled"),
    ])],
  }];
  return {
    term: { id: 1, label: term.label, status: "active" },
    periods: term.periods
      .filter(period => periodIds.includes(period.template_period_id))
      .map(period => ({ ...period, term_period_id: period.id, id: period.template_period_id })),
    summary: {},
    classroom_groups: groups,
    unlinked: [],
  };
}

async function mockBase(page, role = "admin") {
  await page.route("**/api/auth/me", route => route.fulfill({
    json: {
      id: 1,
      username: role,
      display_name: role === "admin" ? "管理員" : "主管",
      role,
      ui_font_scale: 1,
      organization_permissions: role === "supervisor"
        ? { can_view_supervisor_reports: true }
        : undefined,
    },
  }));
  await page.route("**/api/roster/academic-terms", route => route.fulfill({ json: { terms: [term] } }));
  if (role === "supervisor") {
    await page.route("**/api/organization/my-classrooms", route => route.fulfill({
      json: {
        permissions: { can_view_supervisor_reports: true },
        classrooms: [],
      },
    }));
  }
}

test("semester export groups by campus/classroom snapshots and renders authoritative cells", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBase(page);
  await page.route("**/api/roster/semester-export?**", route => route.fulfill({ json: previewPayload() }));

  await page.goto("/admin/semester-export");
  await expect(page.getByRole("heading", { name: "學期彙整匯出" })).toBeVisible();
  await expect(page.getByRole("button", { name: /和平校／向日葵班/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /復興校／向日葵班/ })).toBeVisible();
  await expect(page.getByText("名稱完全不像班級的相本", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /和平校／向日葵班/ }).click();
  await expect(page.getByText("測試歷史生", { exact: true })).toBeVisible();
  await expect(page.getByText("已離園", { exact: true })).toBeVisible();
  await expect(page.getByText("尚未入園", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("無相本", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("重複 2 本，不匯出", { exact: true })).toBeVisible();
  await expect(page.getByText("名稱完全不像班級的相本", { exact: true })).toBeVisible();
  await expect(page.getByText("缺期", { exact: true })).toHaveCount(0);

  await expect(page.getByRole("button", { name: "無相本 1 格" })).toBeVisible();
  await page.getByRole("button", { name: "無相本 1 格" }).click();
  await expect(page.getByRole("button", { name: /和平校／向日葵班.*1 位孩子/ })).toBeVisible();
  await expect(page.getByText(/已選取中有 4 位不在目前搜尋／狀態結果/)).toBeVisible();

  await page.getByLabel("選取 和平校 向日葵班 的孩子").uncheck();
  await expect(page.getByRole("button", { name: /下載學期 ZIP（4 位孩子）/ })).toBeVisible();

  const controlHeights = await page.locator(
    'select, input[type="search"], label input[type="checkbox"], button',
  ).evaluateAll(elements => elements.filter(element => element.offsetParent).map(
    element => element.getBoundingClientRect().height,
  ));
  expect(Math.max(...controlHeights)).toBeGreaterThanOrEqual(44);
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 2);
});

test("semester preview ignores a slower response for an older period selection", async ({ page }) => {
  await mockBase(page);
  let releaseFullTerm;
  let markFullTermStarted;
  const fullTermGate = new Promise(resolve => { releaseFullTerm = resolve; });
  const fullTermStarted = new Promise(resolve => { markFullTermStarted = resolve; });
  await page.route("**/api/roster/semester-export?**", async route => {
    const periodIds = new URL(route.request().url()).searchParams.getAll("period_ids");
    if (periodIds.length === 2) {
      markFullTermStarted();
      await fullTermGate;
      await route.fulfill({ json: previewPayload({ classroomName: "舊的全學期班" }) });
      return;
    }
    await route.fulfill({
      json: previewPayload({ classroomName: "最新單期班", periodIds: [Number(periodIds[0])] }),
    });
  });

  await page.goto("/admin/semester-export");
  await fullTermStarted;
  await page.getByRole("checkbox", { name: "十月" }).uncheck();
  await expect(page.getByRole("button", { name: /最新單期班/ }).first()).toBeVisible();
  releaseFullTerm();
  await page.waitForTimeout(150);
  await expect(page.getByRole("button", { name: /最新單期班/ }).first()).toBeVisible();
  await expect(page.getByText("舊的全學期班", { exact: true })).toHaveCount(0);
});

test("supervisor semester view is read-only", async ({ page }) => {
  await mockBase(page, "supervisor");
  await page.route("**/api/roster/semester-export?**", route => route.fulfill({ json: previewPayload() }));

  await page.goto("/admin/semester-export");
  await expect(page.getByText("依園所主管範圍檢視正式學期相本整備狀態（唯讀）", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /下載學期 ZIP/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /補產生/ })).toHaveCount(0);
  await expect(page.getByLabel(/選取 .* 的孩子/)).toHaveCount(0);
});
