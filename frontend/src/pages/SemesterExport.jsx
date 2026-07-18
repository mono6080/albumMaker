// 學期彙整匯出：正式學期＋校班 snapshot 分組。
// 孩子的未入園、離園、無相本、PDF 與重複狀態全部由後端 cells 回傳。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  AlertCircle,
  Archive,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";

import {
  buildSemesterExportDownloadUrl,
  fetchAcademicTerms,
  fetchRenderMissingProgress,
  fetchSemesterExportPreview,
  renderMissingSemesterAlbums,
} from "../api/rosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { triggerNativeDownload } from "../utils/browserFiles";
import AcademicTermReportFilters from "../components/AcademicTermReportFilters";
import ConfirmModal from "../components/ConfirmModal";
import SemesterSummaryBar from "../components/SemesterSummaryBar";
import SemesterRenderErrorsBanner from "../components/SemesterRenderErrorsBanner";
import SemesterUnlinkedSection from "../components/SemesterUnlinkedSection";
import SemesterChildrenTable from "../components/SemesterChildrenTable";
import { Badge, Button, PageHeader, Surface } from "../components/ui";

const CLASSROOM_GROUPS_PER_PAGE = 8;

function normalizeSearchText(value) {
  return String(value ?? "").replace(/[\s\u3000]+/g, "").toLocaleLowerCase("zh-TW");
}

function periodTemplateId(period) {
  return period.template_period_id ?? period.id;
}

function periodLabel(period) {
  return period.period_name ?? period.name ?? "未命名期別";
}

function groupCampusId(group) {
  return group.campus_id ?? group.classroom?.campus_id;
}

function groupCampusName(group) {
  return group.campus_name ?? group.classroom?.campus_name ?? "未命名校別";
}

function groupClassroomId(group) {
  return group.classroom_id ?? group.classroom?.classroom_id;
}

function groupClassroomName(group) {
  return group.classroom_name ?? group.classroom?.classroom_name ?? "未命名班級";
}

function buildServerQuerySignature(academicTermId, periodIds) {
  return JSON.stringify({
    academicTermId: String(academicTermId),
    periodIds: [...periodIds].map(String).sort(),
  });
}

function childMatchesQuickFilter(child, quickFilter) {
  if (quickFilter === "all") return true;
  return (child.cells ?? []).some(cell => cell.status === quickFilter);
}

function computeExportStats(classroomGroups, identityAnomalyCount) {
  const childIds = new Set();
  let readyCount = 0;
  let notRenderedCount = 0;
  let noAlbumCount = 0;
  let duplicateCount = 0;
  let departedCount = 0;
  for (const group of classroomGroups) {
    for (const child of group.children ?? []) {
      childIds.add(child.roster_child_id);
      for (const cell of child.cells ?? []) {
        if (cell.status === "ready") readyCount += 1;
        else if (cell.status === "not_rendered") notRenderedCount += 1;
        else if (cell.status === "no_album") noAlbumCount += 1;
        else if (cell.status === "duplicate") duplicateCount += 1;
        else if (cell.status === "departed") departedCount += 1;
      }
    }
  }
  return {
    childCount: childIds.size,
    readyCount,
    notRenderedCount,
    noAlbumCount,
    duplicateCount,
    departedCount,
    identityAnomalyCount,
  };
}

function Pagination({ page, pageCount, onChange }) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label="班級分頁" className="flex shrink-0 items-center justify-center gap-3 py-2">
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

function waitForPollInterval(signal) {
  return new Promise(resolve => {
    const timer = window.setTimeout(resolve, 1500);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export default function SemesterExport() {
  const { isAdmin } = usePermissions();
  const [terms, setTerms] = useState([]);
  const [academicTermId, setAcademicTermId] = useState("");
  const [department, setDepartment] = useState("");
  const [selectedPeriodIds, setSelectedPeriodIds] = useState([]);
  const [campusId, setCampusId] = useState("");
  const [selectedClassroomId, setSelectedClassroomId] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewSignature, setPreviewSignature] = useState("");
  const [selectedChildIds, setSelectedChildIds] = useState(new Set());
  const [searchText, setSearchText] = useState("");
  const [quickFilter, setQuickFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [renderJob, setRenderJob] = useState(null);
  const [renderJobErrors, setRenderJobErrors] = useState([]);
  const [confirmModal, setConfirmModal] = useState(null);
  const [isLoadingTerms, setIsLoadingTerms] = useState(true);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [termsError, setTermsError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const anomalySectionRef = useRef(null);
  const termsRequestSequence = useRef(0);
  const previewRequestSequence = useRef(0);
  const renderRequestSequence = useRef(0);
  const termsAbortController = useRef(null);
  const previewAbortController = useRef(null);
  const renderAbortController = useRef(null);
  const activeScopeSignature = useRef("");
  const lastSelectionScopeSignature = useRef("");

  const setTermDefaults = useCallback((term) => {
    const departments = [...new Set((term?.periods ?? []).map(period => period.department))];
    const defaultDepartment = departments[0] ?? "";
    const periodIds = (term?.periods ?? [])
      .filter(period => period.department === defaultDepartment)
      .map(periodTemplateId);
    setDepartment(defaultDepartment);
    setSelectedPeriodIds(periodIds);
  }, []);

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
      setTermDefaults(activeTerm);
    } catch {
      if (abortController.signal.aborted || termsRequestSequence.current !== requestSequence) return;
      setTerms([]);
      setAcademicTermId("");
      setDepartment("");
      setSelectedPeriodIds([]);
      setTermsError("載入正式學期失敗，請檢查網路後重試。");
    } finally {
      if (termsRequestSequence.current === requestSequence) setIsLoadingTerms(false);
    }
  }, [setTermDefaults]);

  useEffect(() => {
    void loadTerms();
    return () => termsAbortController.current?.abort();
  }, [loadTerms]);

  const serverQuerySignature = buildServerQuerySignature(academicTermId, selectedPeriodIds);

  const loadPreview = useCallback(async (filters, requestedSignature) => {
    previewAbortController.current?.abort();
    const abortController = new AbortController();
    previewAbortController.current = abortController;
    const requestSequence = previewRequestSequence.current + 1;
    previewRequestSequence.current = requestSequence;
    setIsLoadingPreview(true);
    setPreviewError("");
    setPreview(null);
    setPreviewSignature("");
    try {
      const response = await fetchSemesterExportPreview(filters, { signal: abortController.signal });
      if (previewRequestSequence.current !== requestSequence) return;
      setPreview(response.data);
      setPreviewSignature(requestedSignature);
    } catch {
      if (abortController.signal.aborted || previewRequestSequence.current !== requestSequence) return;
      setPreviewError("載入學期彙整預覽失敗，請檢查網路後重試。");
    } finally {
      if (previewRequestSequence.current === requestSequence) setIsLoadingPreview(false);
    }
  }, []);

  useEffect(() => {
    if (!academicTermId || selectedPeriodIds.length === 0 || isLoadingTerms || termsError) return undefined;
    const filters = { academicTermId, periodIds: selectedPeriodIds };
    void loadPreview(filters, serverQuerySignature);
    return () => previewAbortController.current?.abort();
  }, [academicTermId, isLoadingTerms, loadPreview, selectedPeriodIds, serverQuerySignature, termsError]);

  useEffect(() => () => {
    previewAbortController.current?.abort();
    renderAbortController.current?.abort();
  }, []);

  const selectedTerm = terms.find(term => String(term.id) === String(academicTermId));
  const departments = useMemo(() => (
    [...new Set((selectedTerm?.periods ?? []).map(period => period.department))]
  ), [selectedTerm]);
  const departmentPeriods = useMemo(() => (
    (selectedTerm?.periods ?? [])
      .filter(period => period.department === department)
      .sort((firstPeriod, secondPeriod) => (
        (firstPeriod.position ?? 0) - (secondPeriod.position ?? 0)
      ))
  ), [department, selectedTerm]);
  const currentPreview = previewSignature === serverQuerySignature ? preview : null;
  const periods = useMemo(() => (
    (currentPreview?.periods ?? departmentPeriods)
      .filter(period => selectedPeriodIds.includes(periodTemplateId(period)))
      .sort((firstPeriod, secondPeriod) => (
        (firstPeriod.position ?? 0) - (secondPeriod.position ?? 0)
      ))
  ), [currentPreview, departmentPeriods, selectedPeriodIds]);
  const identityAnomalies = currentPreview?.unlinked ?? [];

  const departmentGroups = useMemo(() => (
    (currentPreview?.classroom_groups ?? []).filter(group => (
      !department || group.department === department
    ))
  ), [currentPreview, department]);
  const filterClassrooms = useMemo(() => departmentGroups.map(group => ({
    campus_id: groupCampusId(group),
    campus_name: groupCampusName(group),
    classroom_id: groupClassroomId(group),
    classroom_name: groupClassroomName(group),
    department: group.department,
  })), [departmentGroups]);
  const scopeGroups = useMemo(() => departmentGroups.filter(group => (
    (!campusId || String(groupCampusId(group)) === String(campusId))
    && (!selectedClassroomId || String(groupClassroomId(group)) === String(selectedClassroomId))
  )), [campusId, departmentGroups, selectedClassroomId]);

  const searchedGroups = useMemo(() => {
    const query = normalizeSearchText(searchText);
    if (!query) return scopeGroups;
    return scopeGroups.map(group => {
      const isGroupMatch = normalizeSearchText(groupCampusName(group)).includes(query)
        || normalizeSearchText(groupClassroomName(group)).includes(query);
      const children = (group.children ?? []).filter(child => {
        if (isGroupMatch || normalizeSearchText(child.name).includes(query)) return true;
        return (child.cells ?? []).some(cell => (cell.entries ?? []).some(entry => (
          normalizeSearchText(entry.project_name).includes(query)
          || normalizeSearchText(entry.owner_name).includes(query)
          || normalizeSearchText(entry.campus_name).includes(query)
          || normalizeSearchText(entry.classroom_name).includes(query)
        )));
      });
      return { ...group, children };
    }).filter(group => group.children.length > 0);
  }, [scopeGroups, searchText]);
  const filteredGroups = useMemo(() => searchedGroups.map(group => ({
    ...group,
    children: (group.children ?? []).filter(child => childMatchesQuickFilter(child, quickFilter)),
  })).filter(group => group.children.length > 0), [quickFilter, searchedGroups]);
  const exportStats = useMemo(() => (
    computeExportStats(searchedGroups, identityAnomalies.length)
  ), [identityAnomalies.length, searchedGroups]);

  const selectionScopeSignature = `${serverQuerySignature}:${department}:${campusId}:${selectedClassroomId}`;
  activeScopeSignature.current = selectionScopeSignature;
  useEffect(() => {
    if (!currentPreview || lastSelectionScopeSignature.current === selectionScopeSignature) return;
    lastSelectionScopeSignature.current = selectionScopeSignature;
    setSelectedChildIds(new Set(scopeGroups.flatMap(group => (
      (group.children ?? []).map(child => child.roster_child_id)
    ))));
  }, [currentPreview, scopeGroups, selectionScopeSignature]);

  useEffect(() => {
    setCurrentPage(1);
  }, [academicTermId, department, campusId, selectedClassroomId, searchText, quickFilter, selectedPeriodIds]);

  const pageCount = Math.max(1, Math.ceil(filteredGroups.length / CLASSROOM_GROUPS_PER_PAGE));
  const effectivePage = Math.min(currentPage, pageCount);
  const pagedGroups = filteredGroups.slice(
    (effectivePage - 1) * CLASSROOM_GROUPS_PER_PAGE,
    effectivePage * CLASSROOM_GROUPS_PER_PAGE,
  );
  const displayedChildIds = filteredGroups.flatMap(group => (
    (group.children ?? []).map(child => child.roster_child_id)
  ));
  const displayedChildIdSet = new Set(displayedChildIds);
  const hiddenSelectedCount = [...selectedChildIds].filter(
    childId => !displayedChildIdSet.has(childId),
  ).length;
  const allPreviewChildIds = scopeGroups.flatMap(group => (
    (group.children ?? []).map(child => child.roster_child_id)
  ));
  const renderableChildIds = searchedGroups.flatMap(group => (
    (group.children ?? [])
      .filter(child => (child.cells ?? []).some(cell => cell.status === "not_rendered"))
      .map(child => child.roster_child_id)
  ));
  const isRenderingMissing = renderJob?.status === "running";

  const resetScopeSelection = () => {
    lastSelectionScopeSignature.current = "";
    setSelectedChildIds(new Set());
  };

  const handleTermChange = (nextTermId) => {
    previewRequestSequence.current += 1;
    previewAbortController.current?.abort();
    const nextTerm = terms.find(term => String(term.id) === String(nextTermId));
    setAcademicTermId(nextTermId);
    setTermDefaults(nextTerm);
    setCampusId("");
    setSelectedClassroomId("");
    setSearchText("");
    setQuickFilter("all");
    resetScopeSelection();
  };

  const handleDepartmentChange = (nextDepartment) => {
    setDepartment(nextDepartment);
    setSelectedPeriodIds((selectedTerm?.periods ?? [])
      .filter(period => period.department === nextDepartment)
      .map(periodTemplateId));
    setCampusId("");
    setSelectedClassroomId("");
    setSearchText("");
    setQuickFilter("all");
    resetScopeSelection();
  };

  const handleCampusChange = (nextCampusId) => {
    setCampusId(nextCampusId);
    setSelectedClassroomId("");
    resetScopeSelection();
  };

  const handleClassroomChange = (nextClassroomId) => {
    setSelectedClassroomId(nextClassroomId);
    resetScopeSelection();
  };

  const togglePeriod = (periodId) => {
    setSelectedPeriodIds(current => {
      if (current.includes(periodId) && current.length === 1) {
        toast("至少保留一個期別");
        return current;
      }
      resetScopeSelection();
      return current.includes(periodId)
        ? current.filter(selectedId => selectedId !== periodId)
        : [...current, periodId];
    });
  };

  const toggleAllPeriods = () => {
    const departmentPeriodIds = departmentPeriods.map(periodTemplateId);
    const isAllSelected = departmentPeriodIds.every(periodId => selectedPeriodIds.includes(periodId));
    if (isAllSelected && departmentPeriodIds.length > 1) {
      setSelectedPeriodIds([departmentPeriodIds[0]]);
    } else {
      setSelectedPeriodIds(departmentPeriodIds);
    }
    resetScopeSelection();
  };

  const toggleChildSelected = (rosterChildId) => {
    setSelectedChildIds(current => {
      const next = new Set(current);
      if (next.has(rosterChildId)) next.delete(rosterChildId);
      else next.add(rosterChildId);
      return next;
    });
  };

  const setManySelected = (rosterChildIds, isSelected) => {
    setSelectedChildIds(current => {
      const next = new Set(current);
      for (const rosterChildId of rosterChildIds) {
        if (isSelected) next.add(rosterChildId);
        else next.delete(rosterChildId);
      }
      return next;
    });
  };

  const pollRenderJob = async (jobId, renderSequence, filterSignature, abortController) => {
    for (;;) {
      await waitForPollInterval(abortController.signal);
      if (abortController.signal.aborted) return;
      const response = await fetchRenderMissingProgress(jobId, { signal: abortController.signal });
      if (renderRequestSequence.current !== renderSequence) return;
      setRenderJob(response.data);
      if (response.data.status === "running") continue;

      if (response.data.status === "failed") toast.error("補產生失敗");
      else if ((response.data.errors ?? []).length > 0) {
        toast.error(`完成 ${response.data.rendered} 本，失敗 ${response.data.errors.length} 本`);
      } else {
        toast.success(`已產生 ${response.data.rendered} 本`);
      }
      setRenderJobErrors(response.data.errors ?? []);
      setRenderJob(null);
      if (activeScopeSignature.current === filterSignature) {
        await loadPreview(
          { academicTermId, periodIds: selectedPeriodIds },
          buildServerQuerySignature(academicTermId, selectedPeriodIds),
        );
      }
      return;
    }
  };

  const handleRenderMissing = (rosterChildIds, missingCount, scopeLabel) => {
    const requestedChildIds = rosterChildIds ?? renderableChildIds;
    const filterSignature = selectionScopeSignature;
    setConfirmModal({
      message: `將在背景補產生${scopeLabel}缺漏的 ${missingCount} 本相本 PDF。重複相本與無相本工作格會略過，完成前會鎖定學期與校班篩選。`,
      confirmLabel: "開始產生",
      confirmVariant: "primary",
      onConfirm: async () => {
        if (activeScopeSignature.current !== filterSignature) {
          toast.error("篩選範圍已變更，請重新確認");
          return;
        }
        try {
          const response = await renderMissingSemesterAlbums({
            academicTermId,
            periodIds: selectedPeriodIds,
            rosterChildIds: requestedChildIds,
          });
          renderAbortController.current?.abort();
          const abortController = new AbortController();
          renderAbortController.current = abortController;
          const renderSequence = renderRequestSequence.current + 1;
          renderRequestSequence.current = renderSequence;
          setRenderJob(response.data);
          void pollRenderJob(
            response.data.job_id,
            renderSequence,
            filterSignature,
            abortController,
          ).catch(() => {
            if (!abortController.signal.aborted) {
              setRenderJob(null);
              toast.error("查詢補產生進度失敗");
            }
          });
        } catch (error) {
          if (error.response?.status === 503) toast.error("已有補產生工作進行中，請稍後再試");
          else toast.error("啟動補產生失敗");
        }
      },
    });
  };

  const handleDownload = () => {
    const isAllScopeSelected = allPreviewChildIds.length === selectedChildIds.size
      && allPreviewChildIds.every(childId => selectedChildIds.has(childId));
    const canOmitChildIds = !campusId && !selectedClassroomId && isAllScopeSelected;
    triggerNativeDownload(buildSemesterExportDownloadUrl(
      { academicTermId, periodIds: selectedPeriodIds },
      "print",
      canOmitChildIds ? null : [...selectedChildIds],
    ));
    toast.success("已開始產生並下載，請留意瀏覽器的下載列");
  };

  const keepOnlyDisplayedSelected = () => {
    setSelectedChildIds(new Set(
      displayedChildIds.filter(childId => selectedChildIds.has(childId)),
    ));
  };

  return (
    <div className="mx-auto flex min-h-[calc(100svh-6rem)] max-w-7xl flex-col sm:min-h-[calc(100svh-8rem)]">
      <PageHeader
        icon={Archive}
        iconTone="review"
        title="學期彙整匯出"
        subtitle={isAdmin
          ? "依正式學期與校班快照，核對孩子各期狀態並下載列印 PDF"
          : "依園所主管範圍檢視正式學期相本整備狀態（唯讀）"}
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
            classrooms={filterClassrooms}
            campusId={campusId}
            onCampusChange={handleCampusChange}
            classroomId={selectedClassroomId}
            onClassroomChange={handleClassroomChange}
            disabled={isRenderingMissing}
            actions={(
              <Button
                variant="neutral"
                size="md"
                className="w-full"
                onClick={() => void loadPreview(
                  { academicTermId, periodIds: selectedPeriodIds },
                  serverQuerySignature,
                )}
                disabled={isLoadingPreview || isRenderingMissing || selectedPeriodIds.length === 0}
              >
                {isLoadingPreview
                  ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
                重新整理
              </Button>
            )}
          />

          <Surface padding="sm" className="mb-4 shrink-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 text-xs font-medium text-gray-500">匯出期別</span>
              {departmentPeriods.length > 1 && (
                <Button size="xs" variant="ghost" disabled={isRenderingMissing} onClick={toggleAllPeriods}>
                  {departmentPeriods.every(period => selectedPeriodIds.includes(periodTemplateId(period)))
                    ? "只留第一期"
                    : "全選期別"}
                </Button>
              )}
              {departmentPeriods.map(period => {
                const periodId = periodTemplateId(period);
                const isSelected = selectedPeriodIds.includes(periodId);
                return (
                  <label
                    key={periodId}
                    className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm max-sm:min-h-11 [@media(pointer:coarse)]:min-h-11 ${
                      isSelected
                        ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                        : "border-gray-200 bg-white text-gray-600"
                    } ${isRenderingMissing ? "pointer-events-none opacity-50" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={isRenderingMissing}
                      onChange={() => togglePeriod(periodId)}
                      className="accent-indigo-600"
                    />
                    {periodLabel(period)}
                  </label>
                );
              })}
            </div>
          </Surface>
        </>
      )}

      {(isLoadingPreview || (!currentPreview && !previewError && academicTermId && selectedPeriodIds.length > 0)) && (
        <Surface>
          <div role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-gray-500">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            正在載入學期彙整預覽...
          </div>
        </Surface>
      )}

      {previewError && !isLoadingPreview && (
        <Surface className="border-red-200 bg-red-50">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p role="alert" className="flex items-center gap-2 text-sm text-red-700">
              <AlertCircle aria-hidden="true" className="h-4 w-4" />
              {previewError}
            </p>
            <Button
              size="sm"
              variant="dangerSoft"
              onClick={() => void loadPreview(
                { academicTermId, periodIds: selectedPeriodIds },
                serverQuerySignature,
              )}
            >
              重試
            </Button>
          </div>
        </Surface>
      )}

      {currentPreview && (
        <>
          <SemesterSummaryBar
            exportStats={exportStats}
            searchText={searchText}
            onSearchTextChange={setSearchText}
            quickFilter={quickFilter}
            onQuickFilterChange={setQuickFilter}
            onJumpToAnomalies={() => anomalySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            isAdmin={isAdmin}
            isRenderingMissing={isRenderingMissing}
            renderJob={renderJob}
            onRenderMissing={handleRenderMissing}
          />

          {renderJobErrors.length > 0 && (
            <SemesterRenderErrorsBanner errors={renderJobErrors} onDismiss={() => setRenderJobErrors([])} />
          )}

          {identityAnomalies.length > 0 && (
            <SemesterUnlinkedSection sectionRef={anomalySectionRef} unlinked={identityAnomalies} />
          )}

          <SemesterChildrenTable
            classroomGroups={pagedGroups}
            periods={periods}
            isAdmin={isAdmin}
            selectedChildIds={selectedChildIds}
            isRenderingMissing={isRenderingMissing}
            onToggleChildSelected={toggleChildSelected}
            onSetManySelected={setManySelected}
            onRenderMissing={handleRenderMissing}
          />

          <Pagination page={effectivePage} pageCount={pageCount} onChange={setCurrentPage} />

          {isAdmin && allPreviewChildIds.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-100 bg-white py-2">
              {hiddenSelectedCount > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-amber-700">
                  已選取中有 {hiddenSelectedCount} 位不在目前搜尋／狀態結果
                  <Button size="xs" variant="neutral" onClick={keepOnlyDisplayedSelected}>只保留目前結果</Button>
                </span>
              )}
              {identityAnomalies.length > 0 && (
                <Badge tone="warning">{identityAnomalies.length} 筆身分異常不匯出</Badge>
              )}
              <Button
                variant="primary"
                size="lg"
                disabled={selectedChildIds.size === 0 || isRenderingMissing}
                onClick={handleDownload}
              >
                <Download aria-hidden="true" className="h-4 w-4" />
                下載學期 ZIP（{selectedChildIds.size} 位孩子）
              </Button>
            </div>
          )}
        </>
      )}

      <ConfirmModal
        isOpen={Boolean(confirmModal)}
        message={confirmModal?.message}
        confirmLabel={confirmModal?.confirmLabel}
        confirmVariant={confirmModal?.confirmVariant}
        onConfirm={async () => {
          await confirmModal?.onConfirm();
          setConfirmModal(null);
        }}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
