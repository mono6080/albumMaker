// 學期彙整匯出頁（admin 匯出；supervisor 唯讀檢視管轄老師）
// 選擇部門與期別範圍 → 整備度摘要 + 搜尋過濾 → 依名冊孩子分組預覽各期相本狀態 →
// 處理待確認配對、補產生缺漏 PDF → 勾選並下載「班級/孩子/期別.pdf」結構的 ZIP

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Archive, Download, Loader2, RefreshCw } from "lucide-react";

import {
  fetchTemplateDepartments,
  fetchTemplatePeriods,
} from "../api/templateApi";
import {
  buildSemesterExportDownloadUrl,
  fetchRenderMissingProgress,
  fetchSemesterExportPreview,
  linkStudentToNewRosterChild,
  linkStudentToRosterChild,
  mergeRosterChildren,
  renderMissingSemesterAlbums,
} from "../api/rosterApi";
import { usePermissions } from "../hooks/usePermissions";
import { showRetryToast } from "../utils/retryToast";
import { triggerNativeDownload } from "../utils/browserFiles";
import ConfirmModal from "../components/ConfirmModal";
import SemesterSummaryBar from "../components/SemesterSummaryBar";
import SemesterRenderErrorsBanner from "../components/SemesterRenderErrorsBanner";
import SemesterUnlinkedSection from "../components/SemesterUnlinkedSection";
import SemesterChildrenTable from "../components/SemesterChildrenTable";
import { Button, PageHeader, SegmentedControl, Surface } from "../components/ui";

const PERIOD_STATUS_LABELS = { draft: "草稿", active: "使用中", archived: "已封存" };

export default function SemesterExport() {
  const { isAdmin } = usePermissions();
  const [departments, setDepartments] = useState([]);
  const [activeDepartment, setActiveDepartment] = useState(null);
  const [allPeriods, setAllPeriods] = useState([]);
  const [selectedPeriodIds, setSelectedPeriodIds] = useState([]);
  const [preview, setPreview] = useState(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  // 進行中的補渲染背景 job 狀態（null＝沒有 job 在跑）
  const [renderJob, setRenderJob] = useState(null);
  // 最近一次補產生的失敗清單（讓使用者知道是哪幾本，而不只有數字）
  const [renderJobErrors, setRenderJobErrors] = useState([]);
  const [confirmModal, setConfirmModal] = useState(null);
  // 各孩子列的合併目標選擇（roster_child_id → 目標 id 字串）
  const [mergeTargets, setMergeTargets] = useState({});
  // 勾選要匯出的孩子（roster_child_id 集合），載入預覽時預設全選
  const [selectedChildIds, setSelectedChildIds] = useState(new Set());
  // 搜尋與快速過濾（all / unrendered / missingPeriod）
  const [searchText, setSearchText] = useState("");
  const [quickFilter, setQuickFilter] = useState("all");
  // 「待確認」chip 點擊時捲動到待確認配對區塊
  const unlinkedSectionRef = useRef(null);

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

  const departmentPeriods = useMemo(
    () => allPeriods.filter(period => period.department === activeDepartment),
    [allPeriods, activeDepartment],
  );

  const togglePeriod = (periodId) => {
    setSelectedPeriodIds(prev =>
      prev.includes(periodId) ? prev.filter(id => id !== periodId) : [...prev, periodId]
    );
    setPreview(null);
  };

  // 全選/清除本部門全部期別（期末典型操作是整學期一次匯出）
  const isAllPeriodsSelected =
    departmentPeriods.length > 0 && departmentPeriods.every(period => selectedPeriodIds.includes(period.id));
  const toggleAllPeriods = () => {
    setSelectedPeriodIds(isAllPeriodsSelected ? [] : departmentPeriods.map(period => period.id));
    setPreview(null);
  };

  const handleDepartmentChange = (departmentCode) => {
    setActiveDepartment(departmentCode);
    setSelectedPeriodIds([]);
    setPreview(null);
  };

  const loadPreview = useCallback(async () => {
    if (selectedPeriodIds.length === 0) return;
    setIsLoadingPreview(true);
    try {
      const response = await fetchSemesterExportPreview(selectedPeriodIds);
      setPreview(response.data);
      setMergeTargets({});
      setSearchText("");
      setQuickFilter("all");
      setSelectedChildIds(new Set(response.data.children.map(group => group.roster_child_id)));
    } catch {
      toast.error("載入匯出預覽失敗");
    }
    setIsLoadingPreview(false);
  }, [selectedPeriodIds]);

  // 勾選期別後自動載入預覽（防抖 600ms），不必再手動按載入
  useEffect(() => {
    if (selectedPeriodIds.length === 0) return;
    const timer = setTimeout(() => { loadPreview(); }, 600);
    return () => clearTimeout(timer);
  }, [selectedPeriodIds, loadPreview]);

  // ── 整備度統計與缺期判斷 ────────────────────────────────────────────────────
  // 缺期定義：孩子首次出現的期別之後（含中斷與後段）沒有資料的期別

  const exportStats = useMemo(() => {
    if (!preview) return null;
    const periodIndexById = new Map(preview.periods.map((period, index) => [period.id, index]));
    let readyBooks = 0;
    let missingBooks = 0;
    const unrenderedChildIds = new Set();
    const missingPeriodChildIds = new Set();
    const firstPresentIndexByChild = new Map();
    for (const group of preview.children) {
      const presentIndexes = new Set(group.entries.map(entry => periodIndexById.get(entry.period_id)));
      const firstPresentIndex = Math.min(...presentIndexes);
      firstPresentIndexByChild.set(group.roster_child_id, firstPresentIndex);
      for (const entry of group.entries) {
        if (entry.has_pdf) readyBooks += 1;
        else missingBooks += 1;
      }
      if (group.entries.some(entry => !entry.has_pdf)) {
        unrenderedChildIds.add(group.roster_child_id);
      }
      for (let periodIndex = firstPresentIndex + 1; periodIndex < preview.periods.length; periodIndex++) {
        if (!presentIndexes.has(periodIndex)) {
          missingPeriodChildIds.add(group.roster_child_id);
          break;
        }
      }
    }
    return { readyBooks, missingBooks, unrenderedChildIds, missingPeriodChildIds, firstPresentIndexByChild };
  }, [preview]);

  // ── 搜尋與快速過濾 ──────────────────────────────────────────────────────────

  const filteredChildren = useMemo(() => {
    if (!preview || !exportStats) return [];
    const query = searchText.replace(/[\s\u3000]+/g, "");  // u3000＝全形空白
    return preview.children.filter(group => {
      if (query) {
        const haystack = `${group.name}${group.latest_project_name}${group.latest_project_owner_name ?? ""}`;
        if (!haystack.includes(query)) return false;
      }
      if (quickFilter === "unrendered") return exportStats.unrenderedChildIds.has(group.roster_child_id);
      if (quickFilter === "missingPeriod") return exportStats.missingPeriodChildIds.has(group.roster_child_id);
      return true;
    });
  }, [preview, exportStats, searchText, quickFilter]);

  // ── 名冊配對與合併（admin） ──────────────────────────────────────────────────

  const handleLinkStudent = async (studentId, rosterChildId) => {
    try {
      await linkStudentToRosterChild(studentId, rosterChildId);
      toast.success("已完成配對");
      await loadPreview();
    } catch {
      showRetryToast("配對失敗", () => handleLinkStudent(studentId, rosterChildId));
    }
  };

  const handleCreateNewChild = (entry) => {
    setConfirmModal({
      message: `確定「${entry.student_name}」（${entry.project_name}）是另一個新的孩子？將建立新的名冊項。`,
      confirmLabel: "建立新名冊項",
      confirmVariant: "primary",
      onConfirm: async () => {
        try {
          await linkStudentToNewRosterChild(entry.student_id);
          toast.success("已建立新名冊項");
          await loadPreview();
        } catch {
          showRetryToast("建立失敗", () => handleCreateNewChild(entry));
        }
      },
    });
  };

  // 拆分：這筆學生其實是另一個同名孩子 → 拆成新名冊項（錯誤合併的反向操作）
  const handleSplitEntry = (entry) => {
    setConfirmModal({
      message: `確定「${entry.project_name}」的「${entry.student_name}」不是同一個孩子？將把這筆拆成新的名冊項，其他期別不受影響。`,
      confirmLabel: "拆分",
      confirmVariant: "primary",
      onConfirm: async () => {
        try {
          await linkStudentToNewRosterChild(entry.student_id);
          toast.success("已拆成新名冊項");
          await loadPreview();
        } catch {
          showRetryToast("拆分失敗", () => handleSplitEntry(entry));
        }
      },
    });
  };

  const handleMerge = (sourceChild, targetChildId) => {
    const targetChild = preview.children.find(
      group => group.roster_child_id === Number(targetChildId)
    );
    if (!targetChild) return;
    setConfirmModal({
      message: `確定「${sourceChild.name}」和「${targetChild.name}」是同一個孩子？合併後以「${targetChild.name}」為準。`,
      confirmLabel: "合併",
      confirmVariant: "primary",
      onConfirm: async () => {
        try {
          await mergeRosterChildren(sourceChild.roster_child_id, targetChild.roster_child_id);
          toast.success("已合併名冊項");
          await loadPreview();
        } catch {
          showRetryToast("合併失敗", () => handleMerge(sourceChild, targetChildId));
        }
      },
    });
  };

  // ── 補產生缺漏 PDF（admin）：後端背景 job ＋ 前端輪詢進度 ───────────────────

  const pollRenderJob = async (jobId) => {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const response = await fetchRenderMissingProgress(jobId);
      setRenderJob(response.data);
      if (response.data.status !== "running") return response.data;
    }
  };

  const handleRenderMissing = (rosterChildIds, missingCount, scopeLabel) => {
    setConfirmModal({
      message: `將在背景補產生${scopeLabel}缺漏的 ${missingCount} 本相本 PDF，依數量可能需要數分鐘，進度會顯示在按鈕上。`,
      confirmLabel: "開始產生",
      confirmVariant: "primary",
      onConfirm: async () => {
        try {
          const startResponse = await renderMissingSemesterAlbums(selectedPeriodIds, rosterChildIds);
          setRenderJob(startResponse.data);
          const finalState = await pollRenderJob(startResponse.data.job_id);
          if (finalState.status === "failed") toast.error("補產生失敗");
          else if (finalState.errors.length > 0) toast.error(`完成 ${finalState.rendered} 本，失敗 ${finalState.errors.length} 本`);
          else toast.success(`已產生 ${finalState.rendered} 本`);
          setRenderJobErrors(finalState.errors ?? []);
          await loadPreview();
        } catch {
          toast.error("補產生失敗");
        } finally {
          setRenderJob(null);
        }
      },
    });
  };
  const isRenderingMissing = renderJob !== null;

  const handleDownload = () => {
    // 全選時不帶篩選參數，避免大量孩子撐爆 query string
    const isAllSelected = selectedChildIds.size === preview.children.length;
    const downloadUrl = buildSemesterExportDownloadUrl(
      selectedPeriodIds,
      "print",
      isAllSelected ? null : [...selectedChildIds],
    );
    triggerNativeDownload(downloadUrl);
    toast.success("已開始產生並下載，請留意瀏覽器的下載列");
  };

  // ── 匯出勾選：單一孩子 / 整班 / 全部 ────────────────────────────────────────

  const toggleChildSelected = (rosterChildId) => {
    setSelectedChildIds(prev => {
      const next = new Set(prev);
      if (next.has(rosterChildId)) next.delete(rosterChildId);
      else next.add(rosterChildId);
      return next;
    });
  };

  const setManySelected = (rosterChildIds, isSelected) => {
    setSelectedChildIds(prev => {
      const next = new Set(prev);
      rosterChildIds.forEach(childId => (isSelected ? next.add(childId) : next.delete(childId)));
      return next;
    });
  };

  const visibleChildIds = filteredChildren.map(group => group.roster_child_id);
  const visibleSelectedCount = visibleChildIds.filter(childId => selectedChildIds.has(childId)).length;
  // 過濾中：表頭 checkbox 與數字都以「畫面上的孩子」為視角，全域勾選數只在下載鈕呈現
  const isFilterActive = Boolean(preview) && filteredChildren.length !== preview.children.length;
  // 被篩選藏住的勾選（畫面外仍勾著的孩子），下載前要讓使用者知道
  const hiddenSelectedCount = selectedChildIds.size - visibleSelectedCount;

  /** 只保留畫面上的勾選（把畫面外的勾選全部取消） */
  const keepOnlyVisibleSelected = () => {
    setSelectedChildIds(new Set(visibleChildIds.filter(childId => selectedChildIds.has(childId))));
  };

  return (
    // 滿版直欄佈局：表格吃剩餘高度並內部滾動，X 卷軸落在表格底、下載列上方不被遮蓋
    <div className="mx-auto flex h-[calc(100svh-6rem)] max-w-6xl flex-col sm:h-[calc(100svh-8rem)]">
      <PageHeader
        icon={Archive}
        iconTone="review"
        title="學期彙整匯出"
        subtitle={isAdmin
          ? "選擇期別範圍，依名冊孩子分組下載整學期相本 PDF"
          : "檢視管轄老師各期相本的完成進度（唯讀）"}
      />

      {/* 期別選擇 */}
      <Surface className="mb-4 shrink-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {departments.length > 0 && (
            <SegmentedControl
              value={activeDepartment}
              onChange={handleDepartmentChange}
              options={departments.map(department => ({ value: department.code, label: department.name }))}
              size="sm"
              className="sm:w-56"
            />
          )}
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            {departmentPeriods.length > 1 && (
              <button
                type="button"
                onClick={toggleAllPeriods}
                className="inline-flex items-center rounded-lg border border-dashed border-indigo-300 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50"
              >
                {isAllPeriodsSelected ? "清除全選" : "全選期別"}
              </button>
            )}
            {departmentPeriods.map(period => (
              <label
                key={period.id}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  selectedPeriodIds.includes(period.id)
                    ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={selectedPeriodIds.includes(period.id)}
                  onChange={() => togglePeriod(period.id)}
                />
                <span>{period.name}</span>
                <span className="text-xs text-gray-400">{PERIOD_STATUS_LABELS[period.status] ?? period.status}</span>
              </label>
            ))}
            {departmentPeriods.length === 0 && (
              <span className="text-sm text-gray-400">此部門尚無期別</span>
            )}
          </div>
          <Button
            variant="neutral"
            size="sm"
            onClick={loadPreview}
            disabled={selectedPeriodIds.length === 0 || isLoadingPreview}
            className="sm:flex-shrink-0"
          >
            {isLoadingPreview
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
            重新整理
          </Button>
        </div>
      </Surface>

      {/* 整備度摘要 + 搜尋過濾 */}
      {preview && exportStats && (
        <SemesterSummaryBar
          preview={preview}
          exportStats={exportStats}
          searchText={searchText}
          onSearchTextChange={setSearchText}
          quickFilter={quickFilter}
          onQuickFilterChange={setQuickFilter}
          onJumpToUnlinked={() => unlinkedSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          isAdmin={isAdmin}
          isRenderingMissing={isRenderingMissing}
          renderJob={renderJob}
          onRenderMissing={handleRenderMissing}
        />
      )}

      {/* 補產生失敗清單：講清楚是哪幾本，不是只給數字 */}
      {renderJobErrors.length > 0 && (
        <SemesterRenderErrorsBanner errors={renderJobErrors} onDismiss={() => setRenderJobErrors([])} />
      )}

      {/* 待確認配對 */}
      {preview && preview.unlinked.length > 0 && (
        <SemesterUnlinkedSection
          sectionRef={unlinkedSectionRef}
          unlinked={preview.unlinked}
          isAdmin={isAdmin}
          onLinkStudent={handleLinkStudent}
          onCreateNewChild={handleCreateNewChild}
        />
      )}

      {/* 分組預覽表 */}
      {preview && (
        <SemesterChildrenTable
          preview={preview}
          exportStats={exportStats}
          filteredChildren={filteredChildren}
          isAdmin={isAdmin}
          selectedChildIds={selectedChildIds}
          visibleChildIds={visibleChildIds}
          visibleSelectedCount={visibleSelectedCount}
          isFilterActive={isFilterActive}
          mergeTargets={mergeTargets}
          setMergeTargets={setMergeTargets}
          isRenderingMissing={isRenderingMissing}
          onToggleChildSelected={toggleChildSelected}
          onSetManySelected={setManySelected}
          onRenderMissing={handleRenderMissing}
          onSplitEntry={handleSplitEntry}
          onMerge={handleMerge}
        />
      )}

      {/* 下載（admin；常駐佈局底部，不覆蓋表格卷軸） */}
      {isAdmin && preview && preview.children.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {preview.unlinked.length > 0 && (
            <span className="text-xs text-amber-600">
              尚有 {preview.unlinked.length} 位學生未配對，不會納入匯出
            </span>
          )}
          {/* 過濾把已勾選的孩子藏在畫面外時，下載前明確提示並提供一鍵修正 */}
          {isFilterActive && hiddenSelectedCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-amber-600">
              勾選中含 {hiddenSelectedCount} 位不在目前篩選的孩子
              <Button variant="neutral" size="xs" onClick={keepOnlyVisibleSelected}>
                只保留畫面上的
              </Button>
            </span>
          )}
          <Button variant="primary" size="lg" onClick={handleDownload} disabled={selectedChildIds.size === 0}>
            <Download className="h-4 w-4" />
            下載學期彙整 ZIP（{selectedChildIds.size} 位孩子・列印畫質）
          </Button>
        </div>
      )}

      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        confirmLabel={confirmModal?.confirmLabel}
        confirmVariant={confirmModal?.confirmVariant}
        onConfirm={async () => { await confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
