// 老師進度：以正式學期的「班級 × 期別工作格」為唯一統計單位。
// 老師快照顯示編制，owner 只顯示負責人；兩者都不在前端推導權限。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  Search,
  Users,
} from "lucide-react";

import {
  buildTeacherOverviewExcelUrl,
  fetchAcademicTerms,
  fetchTeacherProgress,
} from "../api/rosterApi";
import { apiClient } from "../api/authApi";
import { downloadApiBlob } from "../utils/browserFiles";
import AcademicTermReportFilters from "../components/AcademicTermReportFilters";
import {
  Badge,
  Button,
  PageHeader,
  SegmentedControl,
  Surface,
  fieldControlClass,
} from "../components/ui";

const CLASSROOMS_PER_PAGE = 12;

const FILTER_LABELS = {
  all: "全部",
  attention: "需要處理",
  not_created: "未建立",
  working: "製作中",
  submitted: "已交件",
};

const ATTENTION_LABELS = {
  empty_project: "空相本",
  submitted_with_missing_photos: "交件後仍缺照片",
  missing_print_pdf: "缺列印 PDF",
  partial_print_pdf: "列印 PDF 未齊",
};

function normalizeSearchText(value) {
  return String(value ?? "").replace(/[\s\u3000]+/g, "").toLocaleLowerCase("zh-TW");
}

function termPeriodId(period) {
  return period.term_period_id ?? period.id;
}

function periodName(period) {
  return period.period_name ?? period.name ?? "未命名期別";
}

function teacherName(teacher) {
  return teacher.teacher_name_snapshot ?? teacher.teacher_name ?? teacher.display_name ?? "（已刪除帳號）";
}

function classroomKey(classroom) {
  return classroom.term_classroom_id ?? classroom.classroom_id;
}

function slotHasAttention(slot) {
  if (["not_created", "archived", "multiple_projects"].includes(slot.creation_status)) return true;
  return (slot.projects ?? []).some(project => (project.attention_codes ?? []).length > 0);
}

function classroomMatchesStatus(classroom, statusFilter) {
  if (statusFilter === "all") return true;
  const slots = classroom.slots ?? [];
  if (statusFilter === "attention") return slots.some(slotHasAttention);
  if (statusFilter === "not_created") {
    return slots.some(slot => slot.creation_status === "not_created");
  }
  if (statusFilter === "working") {
    return slots.some(slot => (
      (slot.projects ?? []).some(project => project.workflow_status === "working")
    ));
  }
  return slots.some(slot => (
    (slot.projects ?? []).some(project => project.workflow_status === "submitted_locked")
  ));
}

function PhotoProgressBar({ project, classroomName, periodLabel }) {
  const filled = project.photo_filled ?? 0;
  const total = project.photo_total ?? 0;
  if (total === 0) return null;
  const percent = Math.round((filled / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={`${classroomName} ${periodLabel} ${project.project_name} 照片完成度`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={filled}
        aria-valuetext={`已填 ${filled}／${total} 格照片`}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100"
      >
        <div
          className={`h-full rounded-full ${percent === 100 ? "bg-emerald-500" : "bg-indigo-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="flex-shrink-0 text-[11px] tabular-nums text-gray-500">
        {filled}/{total}
      </span>
    </div>
  );
}

function ProjectStatusCard({ project, classroomName, periodLabel }) {
  const pdfReadyCount = project.pdf_ready_count ?? 0;
  const pdfTotalCount = project.pdf_total_count ?? project.student_count ?? 0;
  const contentTone = project.content_status === "ready"
    ? "success"
    : project.content_status === "empty" ? "danger" : "warning";
  const contentLabel = project.content_status === "ready"
    ? "照片完整"
    : project.content_status === "empty" ? "空相本" : "照片未齊";
  const exportLabel = project.export_status === "ready"
    ? "PDF 已就緒"
    : project.export_status === "partial"
      ? `PDF ${pdfReadyCount}/${pdfTotalCount}`
      : "PDF 未產生";

  return (
    <div className="rounded-lg border border-gray-100 bg-white p-2.5 shadow-sm">
      <div className="flex items-start gap-2">
        <a
          href={`/projects/${project.project_id}/review`}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 break-words text-xs font-semibold text-gray-800 underline-offset-2 hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          {project.project_name}
          <ExternalLink aria-hidden="true" className="ml-1 inline h-3 w-3" />
          <span className="sr-only">（在新分頁開啟）</span>
        </a>
        <span className="flex-shrink-0 text-[11px] text-gray-500">
          {project.student_count ?? 0} 位
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        <Badge tone={contentTone}>{contentLabel}</Badge>
        <Badge tone={project.workflow_status === "submitted_locked" ? "success" : "neutral"}>
          {project.workflow_status === "submitted_locked" ? "已交件鎖定" : "製作中"}
        </Badge>
        <Badge tone={project.export_status === "ready" ? "success" : "warning"}>
          {exportLabel}
        </Badge>
        {(project.blank_text_count ?? 0) > 0 && (
          <Badge tone="warning">空白文字 {project.blank_text_count}</Badge>
        )}
      </div>

      <div className="mt-2">
        <PhotoProgressBar project={project} classroomName={classroomName} periodLabel={periodLabel} />
      </div>

      <p className="mt-2 text-[11px] text-gray-500">
        負責人：{project.owner_name ?? "未指定"}
      </p>

      {(project.attention_codes ?? []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" aria-label="需注意事項">
          {project.attention_codes.map(attentionCode => (
            <span
              key={attentionCode}
              className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] text-red-700"
            >
              {ATTENTION_LABELS[attentionCode] ?? attentionCode}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkSlotCell({ slot, classroomName, periodLabel }) {
  if (!slot) {
    return <span className="text-xs text-gray-400">不適用</span>;
  }
  if (slot.creation_status === "not_created") {
    return (
      <div className="rounded-lg border border-dashed border-amber-200 bg-amber-50 px-3 py-4 text-center">
        <Badge tone="warning">未建立相本</Badge>
      </div>
    );
  }
  if (slot.creation_status === "archived") {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-4 text-center">
        <Badge tone="warning">相本已封存／不可重做</Badge>
      </div>
    );
  }
  const projects = slot.projects ?? [];
  return (
    <div className="space-y-2">
      {slot.creation_status === "multiple_projects" && (
        <Badge tone="danger">同一工作格有 {projects.length} 本相本</Badge>
      )}
      {projects.map(project => (
        <ProjectStatusCard
          key={project.project_id}
          project={project}
          classroomName={classroomName}
          periodLabel={periodLabel}
        />
      ))}
    </div>
  );
}

function ClassroomIdentity({ classroom }) {
  const teachers = [...(classroom.teachers ?? [])].sort((firstTeacher, secondTeacher) => (
    (firstTeacher.duty === "lead" ? 0 : 1) - (secondTeacher.duty === "lead" ? 0 : 1)
    || teacherName(firstTeacher).localeCompare(teacherName(secondTeacher), "zh-TW")
  ));
  return (
    <div>
      <div className="font-bold text-gray-900">{classroom.classroom_name}</div>
      <div className="mt-0.5 text-xs text-gray-500">{classroom.campus_name}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {teachers.map(teacher => (
          <Badge
            key={`${teacher.teacher_id ?? teacher.user_id}:${teacher.duty}`}
            tone={teacher.duty === "lead" ? "primary" : "info"}
          >
            {teacherName(teacher)} · {teacher.duty === "lead" ? "主教" : "協同"}
          </Badge>
        ))}
        {teachers.length === 0 && <Badge tone="warning">未設定老師快照</Badge>}
      </div>
    </div>
  );
}

function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="班級分頁" className="mt-4 flex items-center justify-center gap-3">
      <Button size="sm" variant="neutral" disabled={page === 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft aria-hidden="true" className="h-4 w-4" />
        上一頁
      </Button>
      <span className="text-sm tabular-nums text-gray-500">第 {page}／{pageCount} 頁</span>
      <Button size="sm" variant="neutral" disabled={page === pageCount} onClick={() => onChange(page + 1)}>
        下一頁
        <ChevronRight aria-hidden="true" className="h-4 w-4" />
      </Button>
    </nav>
  );
}

export default function TeacherOverview() {
  const [terms, setTerms] = useState([]);
  const [academicTermId, setAcademicTermId] = useState("");
  const [department, setDepartment] = useState("");
  const [campusId, setCampusId] = useState("");
  const [selectedClassroomId, setSelectedClassroomId] = useState("");
  const [overview, setOverview] = useState(null);
  const [overviewTermId, setOverviewTermId] = useState("");
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedClassroomIds, setExpandedClassroomIds] = useState(new Set());
  const [isLoadingTerms, setIsLoadingTerms] = useState(true);
  const [isLoadingOverview, setIsLoadingOverview] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [termsError, setTermsError] = useState("");
  const [overviewError, setOverviewError] = useState("");
  const termsRequestSequence = useRef(0);
  const overviewRequestSequence = useRef(0);
  const termsAbortController = useRef(null);
  const overviewAbortController = useRef(null);

  const loadTerms = useCallback(async () => {
    termsAbortController.current?.abort();
    const abortController = new AbortController();
    termsAbortController.current = abortController;
    const requestSequence = termsRequestSequence.current + 1;
    termsRequestSequence.current = requestSequence;
    setIsLoadingTerms(true);
    setTermsError("");
    try {
      const response = await fetchAcademicTerms({ signal: abortController.signal });
      if (termsRequestSequence.current !== requestSequence) return;
      const loadedTerms = response.data.terms ?? [];
      setTerms(loadedTerms);
      const activeTerm = loadedTerms.find(term => (
        term.is_current || ["active", "imported"].includes(term.status)
      )) ?? loadedTerms[0];
      setAcademicTermId(activeTerm ? String(activeTerm.id) : "");
      const activeDepartments = [...new Set((activeTerm?.periods ?? []).map(period => period.department))];
      setDepartment(activeDepartments[0] ?? "");
    } catch {
      if (abortController.signal.aborted || termsRequestSequence.current !== requestSequence) return;
      setTerms([]);
      setAcademicTermId("");
      setDepartment("");
      setTermsError("載入正式學期失敗，請檢查網路後重試。");
    } finally {
      if (termsRequestSequence.current === requestSequence) setIsLoadingTerms(false);
    }
  }, []);

  useEffect(() => {
    void loadTerms();
    return () => termsAbortController.current?.abort();
  }, [loadTerms]);

  const loadOverview = useCallback(async (requestedTermId) => {
    overviewAbortController.current?.abort();
    const abortController = new AbortController();
    overviewAbortController.current = abortController;
    const requestSequence = overviewRequestSequence.current + 1;
    overviewRequestSequence.current = requestSequence;
    setIsLoadingOverview(true);
    setOverviewError("");
    setOverview(null);
    setOverviewTermId("");
    try {
      const response = await fetchTeacherProgress(requestedTermId, { signal: abortController.signal });
      if (overviewRequestSequence.current !== requestSequence) return;
      setOverview(response.data);
      setOverviewTermId(String(requestedTermId));
    } catch {
      if (abortController.signal.aborted || overviewRequestSequence.current !== requestSequence) return;
      setOverviewError("載入班級期別進度失敗，請檢查網路後重試。");
    } finally {
      if (overviewRequestSequence.current === requestSequence) setIsLoadingOverview(false);
    }
  }, []);

  useEffect(() => {
    if (!academicTermId || isLoadingTerms || termsError) return undefined;
    void loadOverview(academicTermId);
    return () => overviewAbortController.current?.abort();
  }, [academicTermId, isLoadingTerms, loadOverview, termsError]);

  const selectedTerm = terms.find(term => String(term.id) === String(academicTermId));
  const departments = useMemo(() => (
    [...new Set((selectedTerm?.periods ?? []).map(period => period.department))]
  ), [selectedTerm]);
  const currentOverview = overviewTermId === String(academicTermId) ? overview : null;
  const periods = useMemo(() => (
    (currentOverview?.periods ?? [])
      .filter(period => !department || period.department === department)
      .sort((firstPeriod, secondPeriod) => (
        (firstPeriod.position ?? 0) - (secondPeriod.position ?? 0)
      ))
  ), [currentOverview, department]);
  const departmentClassrooms = useMemo(() => (
    (currentOverview?.classrooms ?? []).filter(classroom => (
      !department || classroom.department === department
    ))
  ), [currentOverview, department]);

  const filteredClassrooms = useMemo(() => {
    const query = normalizeSearchText(searchText);
    return departmentClassrooms.filter(classroom => {
      if (campusId && String(classroom.campus_id) !== String(campusId)) return false;
      if (selectedClassroomId && String(classroom.classroom_id) !== String(selectedClassroomId)) return false;
      if (!classroomMatchesStatus(classroom, statusFilter)) return false;
      if (!query) return true;
      const searchableValues = [
        classroom.campus_name,
        classroom.classroom_name,
        ...(classroom.teachers ?? []).map(teacherName),
        ...(classroom.slots ?? []).flatMap(slot => (slot.projects ?? []).flatMap(project => [
          project.project_name,
          project.owner_name,
          ...(project.students ?? []).map(student => student.student_name),
        ])),
      ];
      return searchableValues.some(value => normalizeSearchText(value).includes(query));
    });
  }, [campusId, departmentClassrooms, searchText, selectedClassroomId, statusFilter]);

  const statusCounts = useMemo(() => Object.fromEntries(
    Object.keys(FILTER_LABELS).map(filterValue => [
      filterValue,
      departmentClassrooms.filter(classroom => {
        if (campusId && String(classroom.campus_id) !== String(campusId)) return false;
        if (selectedClassroomId && String(classroom.classroom_id) !== String(selectedClassroomId)) return false;
        return classroomMatchesStatus(classroom, filterValue);
      }).length,
    ]),
  ), [campusId, departmentClassrooms, selectedClassroomId]);
  const statusOptions = Object.entries(FILTER_LABELS).map(([value, label]) => ({
    value,
    label: `${label} ${statusCounts[value] ?? 0}`,
  }));

  const visibleSummary = useMemo(() => {
    let slotCount = 0;
    let notCreatedCount = 0;
    let archivedCount = 0;
    let attentionCount = 0;
    let submittedCount = 0;
    for (const classroom of filteredClassrooms) {
      for (const slot of classroom.slots ?? []) {
        if (!periods.some(period => termPeriodId(period) === (slot.term_period_id ?? slot.period_id))) continue;
        slotCount += 1;
        if (slot.creation_status === "not_created") notCreatedCount += 1;
        if (slot.creation_status === "archived") archivedCount += 1;
        if (slotHasAttention(slot)) attentionCount += 1;
        submittedCount += (slot.projects ?? []).filter(
          project => project.workflow_status === "submitted_locked",
        ).length;
      }
    }
    return { slotCount, notCreatedCount, archivedCount, attentionCount, submittedCount };
  }, [filteredClassrooms, periods]);

  const pageCount = Math.max(1, Math.ceil(filteredClassrooms.length / CLASSROOMS_PER_PAGE));
  const effectivePage = Math.min(currentPage, pageCount);
  const pagedClassrooms = filteredClassrooms.slice(
    (effectivePage - 1) * CLASSROOMS_PER_PAGE,
    effectivePage * CLASSROOMS_PER_PAGE,
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [academicTermId, department, campusId, selectedClassroomId, searchText, statusFilter]);

  const handleTermChange = (nextTermId) => {
    overviewRequestSequence.current += 1;
    overviewAbortController.current?.abort();
    const nextTerm = terms.find(term => String(term.id) === String(nextTermId));
    const nextDepartments = [...new Set((nextTerm?.periods ?? []).map(period => period.department))];
    setAcademicTermId(nextTermId);
    setDepartment(nextDepartments[0] ?? "");
    setCampusId("");
    setSelectedClassroomId("");
    setStatusFilter("all");
    setExpandedClassroomIds(new Set());
  };

  const handleDepartmentChange = (nextDepartment) => {
    setDepartment(nextDepartment);
    setCampusId("");
    setSelectedClassroomId("");
    setExpandedClassroomIds(new Set());
  };

  const handleCampusChange = (nextCampusId) => {
    setCampusId(nextCampusId);
    setSelectedClassroomId("");
  };

  const handleExportExcel = async () => {
    if (!academicTermId) return;
    setIsExporting(true);
    try {
      await downloadApiBlob(apiClient, buildTeacherOverviewExcelUrl({
        academicTermId,
        department,
        campusId,
        classroomId: selectedClassroomId,
      }), `${selectedTerm?.label ?? "學期"}-老師進度.xlsx`);
    } catch {
      toast.error("下載 Excel 失敗");
    } finally {
      setIsExporting(false);
    }
  };

  const toggleExpandedClassroom = (selectedKey) => {
    setExpandedClassroomIds(current => {
      const next = new Set(current);
      if (next.has(selectedKey)) next.delete(selectedKey);
      else next.add(selectedKey);
      return next;
    });
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        icon={Users}
        iconTone="info"
        title="老師進度"
        subtitle="依正式學期的班級期別工作格，分開查看相本建立、內容、交件與 PDF 狀態。"
      />

      {isLoadingTerms && (
        <Surface className="mb-4">
          <div role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-gray-500">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            正在載入正式學期...
          </div>
        </Surface>
      )}

      {termsError && !isLoadingTerms && (
        <Surface className="mb-4 border-red-200 bg-red-50">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p role="alert" className="flex items-center gap-2 text-sm text-red-700">
              <AlertCircle aria-hidden="true" className="h-4 w-4" />
              {termsError}
            </p>
            <Button size="sm" variant="dangerSoft" onClick={() => void loadTerms()}>重新載入</Button>
          </div>
        </Surface>
      )}

      {!isLoadingTerms && !termsError && terms.length === 0 && (
        <Surface className="text-center text-sm text-gray-500">尚未建立正式學期。</Surface>
      )}

      {!isLoadingTerms && !termsError && terms.length > 0 && (
        <>
          <AcademicTermReportFilters
            terms={terms}
            academicTermId={academicTermId}
            onAcademicTermChange={handleTermChange}
            departments={departments}
            department={department}
            onDepartmentChange={handleDepartmentChange}
            classrooms={departmentClassrooms}
            campusId={campusId}
            onCampusChange={handleCampusChange}
            classroomId={selectedClassroomId}
            onClassroomChange={setSelectedClassroomId}
            actions={(
              <Button
                variant="secondary"
                size="md"
                className="w-full"
                onClick={handleExportExcel}
                disabled={isExporting || isLoadingOverview || !currentOverview}
              >
                {isExporting
                  ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  : <FileSpreadsheet aria-hidden="true" className="h-4 w-4" />}
                {isExporting ? "下載中..." : "下載 Excel"}
              </Button>
            )}
          />

          {currentOverview && (
            <Surface padding="sm" className="mb-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                <div className="relative min-w-0 flex-1 lg:max-w-xs">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                  <input
                    type="search"
                    aria-label="搜尋校別、班級、老師、負責人或學生"
                    value={searchText}
                    onChange={event => setSearchText(event.target.value)}
                    placeholder="搜尋班級 / 老師 / 負責人 / 學生"
                    className={`${fieldControlClass} pl-9`}
                  />
                </div>
                <SegmentedControl
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={statusOptions}
                  size="sm"
                  className="w-full lg:flex-1"
                  ariaLabel="篩選班級期別狀態"
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3 text-xs">
                <Badge tone="neutral">{filteredClassrooms.length} 班</Badge>
                <Badge tone="neutral">{visibleSummary.slotCount} 個工作格</Badge>
                <Badge tone={visibleSummary.notCreatedCount ? "warning" : "success"}>
                  未建立 {visibleSummary.notCreatedCount}
                </Badge>
                {visibleSummary.archivedCount > 0 && (
                  <Badge tone="warning">已封存 {visibleSummary.archivedCount}</Badge>
                )}
                <Badge tone={visibleSummary.attentionCount ? "danger" : "success"}>
                  需注意 {visibleSummary.attentionCount}
                </Badge>
                <Badge tone="success">已交件 {visibleSummary.submittedCount} 本</Badge>
              </div>
            </Surface>
          )}
        </>
      )}

      {isLoadingOverview && (
        <Surface>
          <div role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-gray-500">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            正在載入班級期別進度...
          </div>
        </Surface>
      )}

      {overviewError && !isLoadingOverview && (
        <Surface className="border-red-200 bg-red-50">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p role="alert" className="flex items-center gap-2 text-sm text-red-700">
              <AlertCircle aria-hidden="true" className="h-4 w-4" />
              {overviewError}
            </p>
            <Button size="sm" variant="dangerSoft" onClick={() => void loadOverview(academicTermId)}>重試</Button>
          </div>
        </Surface>
      )}

      {currentOverview && filteredClassrooms.length === 0 && (
        <Surface className="text-center text-sm text-gray-500">
          {departmentClassrooms.length === 0 ? "此學期與部門沒有班級工作格。" : "沒有符合目前篩選的班級。"}
        </Surface>
      )}

      {currentOverview && pagedClassrooms.length > 0 && (
        <>
          <Surface padding="none" className="hidden overflow-auto md:block">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                  <th scope="col" className="sticky left-0 top-0 z-30 min-w-56 border-r border-gray-200 bg-gray-50 px-4 py-3 font-medium">
                    班級與老師編制
                  </th>
                  {periods.map(period => (
                    <th key={termPeriodId(period)} scope="col" className="sticky top-0 z-20 min-w-72 bg-gray-50 px-3 py-3 font-medium">
                      {periodName(period)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedClassrooms.map(classroom => {
                  const slotsByPeriodId = new Map((classroom.slots ?? []).map(slot => [
                    slot.term_period_id ?? slot.period_id,
                    slot,
                  ]));
                  return (
                    <tr key={classroomKey(classroom)} className="border-b border-gray-100 align-top last:border-0">
                      <th scope="row" className="sticky left-0 z-10 border-r border-gray-100 bg-white px-4 py-3 text-left font-normal">
                        <ClassroomIdentity classroom={classroom} />
                      </th>
                      {periods.map(period => (
                        <td key={termPeriodId(period)} className="max-w-80 bg-gray-50/30 px-3 py-3">
                          <WorkSlotCell
                            slot={slotsByPeriodId.get(termPeriodId(period))}
                            classroomName={classroom.classroom_name}
                            periodLabel={periodName(period)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Surface>

          <div className="space-y-3 md:hidden">
            {pagedClassrooms.map(classroom => {
              const selectedKey = classroomKey(classroom);
              const isExpanded = expandedClassroomIds.has(selectedKey);
              const slotsByPeriodId = new Map((classroom.slots ?? []).map(slot => [
                slot.term_period_id ?? slot.period_id,
                slot,
              ]));
              const attentionCount = (classroom.slots ?? []).filter(slotHasAttention).length;
              return (
                <Surface key={selectedKey} padding="none" as="section" className="overflow-hidden">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-controls={`teacher-classroom-${selectedKey}`}
                    onClick={() => toggleExpandedClassroom(selectedKey)}
                    className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                  >
                    <div className="min-w-0 flex-1">
                      <ClassroomIdentity classroom={classroom} />
                      <p className="mt-2 text-xs text-gray-500">
                        {classroom.slots?.length ?? 0} 個工作格
                        {attentionCount > 0 ? ` · ${attentionCount} 個需處理` : " · 目前無異常"}
                      </p>
                    </div>
                    {isExpanded
                      ? <ChevronUp aria-hidden="true" className="mt-1 h-4 w-4 flex-shrink-0 text-gray-400" />
                      : <ChevronDown aria-hidden="true" className="mt-1 h-4 w-4 flex-shrink-0 text-gray-400" />}
                  </button>
                  {isExpanded && (
                    <div id={`teacher-classroom-${selectedKey}`} className="space-y-3 border-t border-gray-100 bg-gray-50/40 p-3">
                      {periods.map(period => (
                        <section key={termPeriodId(period)} aria-label={`${classroom.classroom_name} ${periodName(period)}`}>
                          <h3 className="mb-2 text-xs font-bold text-gray-600">{periodName(period)}</h3>
                          <WorkSlotCell
                            slot={slotsByPeriodId.get(termPeriodId(period))}
                            classroomName={classroom.classroom_name}
                            periodLabel={periodName(period)}
                          />
                        </section>
                      ))}
                    </div>
                  )}
                </Surface>
              );
            })}
          </div>

          <Pagination page={effectivePage} pageCount={pageCount} onChange={setCurrentPage} />
        </>
      )}
    </div>
  );
}
