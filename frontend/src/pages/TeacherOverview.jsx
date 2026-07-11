// 老師進度頁（supervisor 看管轄老師；admin 看全部）
// 以老師為軸心：每位老師（含尚未建專案者）做了哪些期別的專案、
// 各專案的照片格填滿率與空白文字格數；渲染進度由學期匯出頁負責。

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { ExternalLink, FileSpreadsheet, Loader2, Search, Users } from "lucide-react";

import {
  fetchTemplateDepartments,
  fetchTemplatePeriods,
} from "../api/templateApi";
import { buildTeacherOverviewExcelUrl, fetchTeacherProgress } from "../api/rosterApi";
import { apiClient } from "../api/authApi";
import { downloadApiBlob } from "../utils/browserFiles";
import { Badge, Button, PageHeader, SegmentedControl, Surface } from "../components/ui";

/** 照片完成度橫條：滿格轉綠，未滿維持 indigo */
function PhotoProgressBar({ filled, total }) {
  if (!total) return null;
  const percent = Math.round((filled / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full ${percent === 100 ? "bg-emerald-500" : "bg-indigo-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={`flex-shrink-0 text-xs tabular-nums ${percent === 100 ? "text-emerald-600" : "text-gray-500"}`}>
        照片 {filled}/{total}
      </span>
    </div>
  );
}

export default function TeacherOverview() {
  const [departments, setDepartments] = useState([]);
  const [activeDepartment, setActiveDepartment] = useState(null);
  const [allPeriods, setAllPeriods] = useState([]);
  const [overview, setOverview] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const [departmentsRes, periodsRes] = await Promise.all([
          fetchTemplateDepartments(),
          fetchTemplatePeriods(),
        ]);
        setDepartments(departmentsRes.data);
        setActiveDepartment(departmentsRes.data[0]?.code ?? null);
        setAllPeriods(periodsRes.data);
      } catch {
        toast.error("載入期別清單失敗");
      }
    };
    loadOptions();
  }, []);

  // 切換部門即自動載入該部門全部期別的總覽（主管打開就看到全貌，不需手動勾期別）
  useEffect(() => {
    if (!activeDepartment || allPeriods.length === 0) return;
    const departmentPeriodIds = allPeriods
      .filter(period => period.department === activeDepartment)
      .map(period => period.id);
    if (departmentPeriodIds.length === 0) {
      setOverview(null);
      return;
    }
    const loadOverview = async () => {
      setIsLoading(true);
      try {
        const response = await fetchTeacherProgress(departmentPeriodIds);
        setOverview(response.data);
      } catch {
        toast.error("載入老師進度失敗");
      }
      setIsLoading(false);
    };
    loadOverview();
  }, [activeDepartment, allPeriods]);

  // 依期別先後與專案名排序每位老師的專案（後端只保證老師排序）
  const teacherGroups = useMemo(() => {
    if (!overview) return [];
    const periodOrderById = new Map(overview.periods.map((period, index) => [period.id, index]));
    const periodNameById = new Map(overview.periods.map(period => [period.id, period.name]));
    return overview.teachers.map(teacher => {
      const projects = [...teacher.projects]
        .map(project => ({
          ...project,
          periodName: periodNameById.get(project.period_id) ?? "?",
        }))
        .sort(
          (a, b) =>
            (periodOrderById.get(a.period_id) ?? 99) - (periodOrderById.get(b.period_id) ?? 99) ||
            a.project_name.localeCompare(b.project_name, "zh-TW"),
        );
      const studentTotal = projects.reduce((count, project) => count + project.student_count, 0);
      const completedProjectCount = projects.filter(project => project.completed_at).length;
      return { ...teacher, projects, studentTotal, completedProjectCount };
    });
  }, [overview]);

  const handleExportExcel = async () => {
    const departmentPeriodIds = allPeriods
      .filter(period => period.department === activeDepartment)
      .map(period => period.id);
    if (departmentPeriodIds.length === 0) return;
    setIsExporting(true);
    try {
      await downloadApiBlob(apiClient, buildTeacherOverviewExcelUrl(departmentPeriodIds), "老師進度.xlsx");
    } catch {
      toast.error("下載 Excel 失敗");
    }
    setIsExporting(false);
  };

  const filteredTeachers = useMemo(() => {
    const query = searchText.replace(/[\s\u3000]+/g, "");  // u3000＝全形空白
    if (!query) return teacherGroups;
    return teacherGroups
      .map(teacher => {
        if (teacher.display_name.includes(query)) return teacher;
        const matchedProjects = teacher.projects.filter(project =>
          project.project_name.includes(query) ||
          project.periodName.includes(query) ||
          project.students.some(student => student.student_name.includes(query)),
        );
        if (matchedProjects.length === 0) return null;
        return { ...teacher, projects: matchedProjects };
      })
      .filter(Boolean);
  }, [teacherGroups, searchText]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        icon={Users}
        iconTone="info"
        title="老師進度"
        subtitle="各老師的期別專案、照片格填滿進度與空白文字提醒（PDF 產出狀態見學期匯出頁）"
      />

      <Surface padding="sm" className="mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {departments.length > 0 && (
            <SegmentedControl
              value={activeDepartment}
              onChange={setActiveDepartment}
              options={departments.map(department => ({ value: department.code, label: department.name }))}
              size="sm"
              className="sm:w-56"
            />
          )}
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={searchText}
              onChange={event => setSearchText(event.target.value)}
              placeholder="搜尋老師 / 班級 / 學生 / 期別"
              className="w-full rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
          <Button
            variant="secondary"
            size="md"
            className="sm:ml-auto sm:flex-shrink-0"
            onClick={handleExportExcel}
            disabled={isExporting || !overview || teacherGroups.length === 0}
          >
            {isExporting
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <FileSpreadsheet className="h-4 w-4" />}
            下載 Excel
          </Button>
        </div>
      </Surface>

      {overview && filteredTeachers.length === 0 && !isLoading && (
        <Surface className="text-center text-sm text-gray-400">
          {teacherGroups.length === 0 ? "此部門尚無老師" : "沒有符合搜尋條件的老師"}
        </Surface>
      )}

      <div className="flex flex-col gap-4">
        {filteredTeachers.map(teacher => (
          <Surface key={teacher.user_id ?? `name:${teacher.display_name}`} padding="md">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-gray-900">{teacher.display_name}</h2>
              {teacher.projects.length === 0 ? (
                <Badge tone="warning">尚未開始</Badge>
              ) : (
                <>
                  <Badge tone="neutral">{teacher.projects.length} 個專案</Badge>
                  <Badge tone="neutral">{teacher.studentTotal} 位學生</Badge>
                  <Badge tone={teacher.completedProjectCount === teacher.projects.length ? "success" : "neutral"}>
                    完成 {teacher.completedProjectCount}/{teacher.projects.length}
                  </Badge>
                </>
              )}
            </div>
            {teacher.projects.length === 0 ? (
              <p className="text-sm text-gray-400">此部門的期別範圍內還沒有建立任何專案</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {teacher.projects.map(project => (
                  <div key={project.project_id} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-1.5">
                      <Badge tone="primary">{project.periodName}</Badge>
                      {project.completed_at && (
                        <Badge tone="success" title={`完成於 ${new Date(project.completed_at).toLocaleString("zh-TW")}`}>
                          ✓ 已完成
                        </Badge>
                      )}
                      <a
                        href={`/projects/${project.project_id}/review`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm font-medium text-gray-800 underline-offset-2 hover:text-indigo-600 hover:underline"
                        title="開啟班級總覽"
                      >
                        {project.project_name}
                        <ExternalLink className="h-3 w-3 text-gray-400" />
                      </a>
                      {project.blank_text_count > 0 && (
                        <span
                          className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700"
                          title="依「學生覆寫 > 專案覆寫 > 模板預設」合併後會輸出空白的文字格數（含刻意設為空白）"
                        >
                          空白文字 {project.blank_text_count} 格
                        </span>
                      )}
                      <span className="ml-auto text-xs text-gray-400">
                        {project.student_count} 位學生
                      </span>
                    </div>
                    <div className="mb-2">
                      <PhotoProgressBar filled={project.photo_filled} total={project.photo_total} />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {project.students.map(student => {
                        const isComplete = student.photo_total === 0 || student.photo_filled === student.photo_total;
                        return (
                          <span
                            key={student.student_id}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                              isComplete ? "bg-gray-100 text-gray-700" : "bg-amber-50 text-amber-700"
                            }`}
                            title={isComplete ? "照片已填滿" : `照片 ${student.photo_filled}/${student.photo_total}`}
                          >
                            {student.student_name}
                            {!isComplete && (
                              <span className="tabular-nums text-[10px]">
                                {student.photo_filled}/{student.photo_total}
                              </span>
                            )}
                          </span>
                        );
                      })}
                      {project.students.length === 0 && (
                        <span className="text-xs text-gray-400">尚未加入學生</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Surface>
        ))}
      </div>
    </div>
  );
}
