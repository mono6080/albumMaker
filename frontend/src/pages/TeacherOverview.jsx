// 老師進度頁（supervisor 看管轄老師；admin 看全部）
// 以老師為軸心：每位老師做了哪些期別的專案（模板）、班上有哪些學生、渲染進度。
// 資料沿用學期匯出的 preview API（權限範圍由後端處理），前端翻轉成老師視角。

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { ExternalLink, Loader2, Search, Users } from "lucide-react";

import {
  fetchTemplateDepartments,
  fetchTemplatePeriods,
} from "../api/templateApi";
import { fetchSemesterExportPreview } from "../api/rosterApi";
import { Badge, PageHeader, SegmentedControl, Surface } from "../components/ui";

export default function TeacherOverview() {
  const [departments, setDepartments] = useState([]);
  const [activeDepartment, setActiveDepartment] = useState(null);
  const [allPeriods, setAllPeriods] = useState([]);
  const [preview, setPreview] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
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
      setPreview(null);
      return;
    }
    const loadPreview = async () => {
      setIsLoading(true);
      try {
        const response = await fetchSemesterExportPreview(departmentPeriodIds);
        setPreview(response.data);
      } catch {
        toast.error("載入老師進度失敗");
      }
      setIsLoading(false);
    };
    loadPreview();
  }, [activeDepartment, allPeriods]);

  // ── 翻轉成老師視角：老師 → 專案（含期別）→ 學生 ─────────────────────────────

  const teacherGroups = useMemo(() => {
    if (!preview) return [];
    const periodOrderById = new Map(preview.periods.map((period, index) => [period.id, index]));
    const periodNameById = new Map(preview.periods.map(period => [period.id, period.name]));

    const allEntries = [
      ...preview.children.flatMap(group => group.entries),
      ...preview.unlinked,
    ];
    const teachersById = new Map();
    for (const entry of allEntries) {
      const teacherKey = entry.owner_id ?? `name:${entry.owner_name ?? "未知"}`;
      const teacher = teachersById.get(teacherKey) ?? {
        teacherName: entry.owner_name ?? "（未指定老師）",
        projectsById: new Map(),
      };
      const project = teacher.projectsById.get(entry.project_id) ?? {
        projectId: entry.project_id,
        projectName: entry.project_name,
        periodId: entry.period_id,
        periodName: periodNameById.get(entry.period_id) ?? "?",
        students: [],
      };
      project.students.push({
        studentId: entry.student_id,
        studentName: entry.student_name,
        hasPdf: entry.has_pdf,
      });
      teacher.projectsById.set(entry.project_id, project);
      teachersById.set(teacherKey, teacher);
    }

    return [...teachersById.values()]
      .map(teacher => {
        const projects = [...teacher.projectsById.values()].sort(
          (a, b) =>
            (periodOrderById.get(a.periodId) ?? 99) - (periodOrderById.get(b.periodId) ?? 99) ||
            a.projectName.localeCompare(b.projectName, "zh-TW"),
        );
        const studentTotal = projects.reduce((count, project) => count + project.students.length, 0);
        const renderedTotal = projects.reduce(
          (count, project) => count + project.students.filter(student => student.hasPdf).length,
          0,
        );
        return { ...teacher, projects, studentTotal, renderedTotal };
      })
      .sort((a, b) => a.teacherName.localeCompare(b.teacherName, "zh-TW"));
  }, [preview]);

  const filteredTeachers = useMemo(() => {
    const query = searchText.replace(/[\s\u3000]+/g, "");  // u3000＝全形空白
    if (!query) return teacherGroups;
    return teacherGroups
      .map(teacher => {
        if (teacher.teacherName.includes(query)) return teacher;
        const matchedProjects = teacher.projects.filter(project =>
          project.projectName.includes(query) ||
          project.periodName.includes(query) ||
          project.students.some(student => student.studentName.includes(query)),
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
        subtitle="各老師做了哪些期別的相本專案、班上學生與渲染進度"
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
        </div>
      </Surface>

      {preview && filteredTeachers.length === 0 && !isLoading && (
        <Surface className="text-center text-sm text-gray-400">
          {teacherGroups.length === 0 ? "此部門尚無老師的專案" : "沒有符合搜尋條件的老師"}
        </Surface>
      )}

      <div className="flex flex-col gap-4">
        {filteredTeachers.map(teacher => (
          <Surface key={teacher.teacherName} padding="md">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-gray-900">{teacher.teacherName}</h2>
              <Badge tone="neutral">{teacher.projects.length} 個專案</Badge>
              <Badge tone="neutral">{teacher.studentTotal} 位學生</Badge>
              <Badge tone={teacher.renderedTotal === teacher.studentTotal ? "success" : "warning"}>
                已渲染 {teacher.renderedTotal}/{teacher.studentTotal}
              </Badge>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {teacher.projects.map(project => (
                <div key={project.projectId} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <Badge tone="primary">{project.periodName}</Badge>
                    <a
                      href={`/projects/${project.projectId}/review`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm font-medium text-gray-800 underline-offset-2 hover:text-indigo-600 hover:underline"
                      title="開啟專案審閱頁"
                    >
                      {project.projectName}
                      <ExternalLink className="h-3 w-3 text-gray-400" />
                    </a>
                    <span className="ml-auto text-xs text-gray-400">
                      {project.students.filter(student => student.hasPdf).length}/{project.students.length} 已渲染
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {project.students.map(student => (
                      <span
                        key={student.studentId}
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                          student.hasPdf
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-700"
                        }`}
                        title={student.hasPdf ? "已渲染" : "未渲染"}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${student.hasPdf ? "bg-emerald-500" : "bg-amber-400"}`} />
                        {student.studentName}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Surface>
        ))}
      </div>
    </div>
  );
}
