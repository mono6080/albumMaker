// 學期彙整匯出頁（admin 匯出；supervisor 唯讀檢視管轄老師）
// 選擇部門與期別範圍 → 整備度摘要 + 搜尋過濾 → 依名冊孩子分組預覽各期相冊狀態 →
// 處理待確認配對、補渲染缺漏 → 勾選並下載「班級/孩子/期別.pdf」結構的 ZIP

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Archive, Download, GitMerge, Hammer, Loader2, RefreshCw, Search, Unlink } from "lucide-react";

import {
  fetchTemplateDepartments,
  fetchTemplatePeriods,
} from "../api/templateApi";
import {
  buildSemesterExportDownloadUrl,
  fetchSemesterExportPreview,
  linkStudentToNewRosterChild,
  linkStudentToRosterChild,
  mergeRosterChildren,
  renderMissingSemesterAlbums,
} from "../api/rosterApi";
import { usePermissions } from "../hooks/usePermissions";
import ConfirmModal from "../components/ConfirmModal";
import { Badge, Button, PageHeader, SegmentedControl, Surface, fieldControlClass } from "../components/ui";

const PERIOD_STATUS_LABELS = { draft: "草稿", active: "使用中", archived: "已封存" };

/** 支援「部分勾選」顯示的 checkbox（indeterminate 只能用 DOM 屬性設定） */
function TriStateCheckbox({ checked, indeterminate, onChange, title }) {
  return (
    <input
      type="checkbox"
      className="accent-indigo-600"
      checked={checked}
      ref={element => { if (element) element.indeterminate = !checked && indeterminate; }}
      onChange={onChange}
      title={title}
    />
  );
}

/** 整備度摘要的可點擊過濾 chip */
function StatChip({ label, count, tone, isActive, onClick }) {
  const toneClass = {
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    neutral: "bg-gray-50 text-gray-600 border-gray-200",
  }[tone] ?? "bg-gray-50 text-gray-600 border-gray-200";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-shadow ${toneClass} ${
        isActive ? "ring-2 ring-indigo-400" : "hover:shadow-sm"
      }`}
    >
      {label}
      <span className="font-bold">{count}</span>
    </button>
  );
}

export default function SemesterExport() {
  const { isAdmin } = usePermissions();
  const [departments, setDepartments] = useState([]);
  const [activeDepartment, setActiveDepartment] = useState(null);
  const [allPeriods, setAllPeriods] = useState([]);
  const [selectedPeriodIds, setSelectedPeriodIds] = useState([]);
  const [preview, setPreview] = useState(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isRenderingMissing, setIsRenderingMissing] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  // 各孩子列的合併目標選擇（roster_child_id → 目標 id 字串）
  const [mergeTargets, setMergeTargets] = useState({});
  // 勾選要匯出的孩子（roster_child_id 集合），載入預覽時預設全選
  const [selectedChildIds, setSelectedChildIds] = useState(new Set());
  // 搜尋與快速過濾（all / unrendered / missingPeriod）
  const [searchText, setSearchText] = useState("");
  const [quickFilter, setQuickFilter] = useState("all");

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

  const handleDepartmentChange = (departmentCode) => {
    setActiveDepartment(departmentCode);
    setSelectedPeriodIds([]);
    setPreview(null);
  };

  const loadPreview = async () => {
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
  };

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
      toast.error("配對失敗");
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
          toast.error("建立失敗");
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
          toast.error("拆分失敗");
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
          toast.error("合併失敗");
        }
      },
    });
  };

  // ── 補渲染缺漏（admin） ─────────────────────────────────────────────────────

  const handleRenderMissing = (rosterChildIds, missingCount, scopeLabel) => {
    setConfirmModal({
      message: `將補渲染${scopeLabel}缺漏的 ${missingCount} 本相冊，依數量可能需要數分鐘，期間請不要關閉頁面。`,
      confirmLabel: "開始渲染",
      confirmVariant: "primary",
      onConfirm: async () => {
        setIsRenderingMissing(true);
        try {
          const response = await renderMissingSemesterAlbums(selectedPeriodIds, rosterChildIds);
          const { rendered, errors } = response.data;
          if (errors.length > 0) toast.error(`完成 ${rendered} 本，失敗 ${errors.length} 本`);
          else toast.success(`已渲染 ${rendered} 本`);
          await loadPreview();
        } catch {
          toast.error("補渲染失敗");
        }
        setIsRenderingMissing(false);
      },
    });
  };

  const handleDownload = () => {
    // 全選時不帶篩選參數，避免大量孩子撐爆 query string
    const isAllSelected = selectedChildIds.size === preview.children.length;
    const downloadUrl = buildSemesterExportDownloadUrl(
      selectedPeriodIds,
      "print",
      isAllSelected ? null : [...selectedChildIds],
    );
    // ZIP 動輒數百 MB：走瀏覽器原生下載（cookie 認證照常帶），
    // 不經 axios blob — 避免 timeout 與整包塞進記憶體
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
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

  const periodColumns = preview?.periods ?? [];
  // 合併欄只有 admin 看得到，表格總欄數隨之增減
  const totalColumnCount = periodColumns.length + 1 + (isAdmin ? 1 : 0);
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

  // 每個孩子依期別整理格位：period_id → entries
  const buildEntriesByPeriod = (group) => {
    const entriesByPeriod = {};
    for (const entry of group.entries) {
      (entriesByPeriod[entry.period_id] ??= []).push(entry);
    }
    return entriesByPeriod;
  };

  return (
    // 滿版直欄佈局：表格吃剩餘高度並內部滾動，X 卷軸落在表格底、下載列上方不被遮蓋
    <div className="mx-auto flex h-[calc(100svh-6rem)] max-w-6xl flex-col sm:h-[calc(100svh-8rem)]">
      <PageHeader
        icon={Archive}
        iconTone="review"
        title="學期彙整匯出"
        subtitle={isAdmin
          ? "選擇期別範圍，依名冊孩子分組下載整學期相冊 PDF"
          : "檢視管轄老師各期相冊的完成進度（唯讀）"}
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
            variant="primary"
            size="sm"
            onClick={loadPreview}
            disabled={selectedPeriodIds.length === 0 || isLoadingPreview}
            className="sm:flex-shrink-0"
          >
            {isLoadingPreview
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
            載入預覽
          </Button>
        </div>
      </Surface>

      {/* 整備度摘要 + 搜尋過濾 */}
      {preview && exportStats && (
        <Surface padding="sm" className="mb-4 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={searchText}
                onChange={event => setSearchText(event.target.value)}
                placeholder="搜尋孩子 / 班級 / 老師"
                className="w-48 rounded-lg border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <StatChip
              label="全部孩子"
              count={preview.children.length}
              tone="neutral"
              isActive={quickFilter === "all"}
              onClick={() => setQuickFilter("all")}
            />
            <StatChip label="已就緒" count={`${exportStats.readyBooks} 本`} tone="success" isActive={false} onClick={() => setQuickFilter("all")} />
            <StatChip
              label="未渲染"
              count={`${exportStats.missingBooks} 本`}
              tone="warning"
              isActive={quickFilter === "unrendered"}
              onClick={() => setQuickFilter(quickFilter === "unrendered" ? "all" : "unrendered")}
            />
            <StatChip
              label="缺期"
              count={`${exportStats.missingPeriodChildIds.size} 位`}
              tone="warning"
              isActive={quickFilter === "missingPeriod"}
              onClick={() => setQuickFilter(quickFilter === "missingPeriod" ? "all" : "missingPeriod")}
            />
            {preview.unlinked.length > 0 && (
              <StatChip label="待確認" count={`${preview.unlinked.length} 位`} tone="warning" isActive={false} onClick={() => {}} />
            )}
            {isAdmin && exportStats.missingBooks > 0 && (
              <Button
                variant="secondary"
                size="xs"
                className="ml-auto"
                disabled={isRenderingMissing}
                onClick={() => handleRenderMissing(null, exportStats.missingBooks, "全部")}
              >
                {isRenderingMissing
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Hammer className="h-3.5 w-3.5" />}
                補渲染全部缺漏（{exportStats.missingBooks} 本）
              </Button>
            )}
          </div>
        </Surface>
      )}

      {/* 待確認配對 */}
      {preview && preview.unlinked.length > 0 && (
        <Surface className="mb-4 max-h-52 shrink-0 overflow-auto border-amber-200 bg-amber-50/60">
          <h2 className="mb-2 text-sm font-bold text-amber-800">
            待確認配對（{preview.unlinked.length}）
          </h2>
          <p className="mb-3 text-xs text-amber-700">
            名冊中有多個同名孩子，系統無法自動判斷這些學生是誰，請人工確認。未配對的學生不會納入匯出。
          </p>
          <div className="flex flex-col gap-2">
            {preview.unlinked.map(entry => (
              <div
                key={entry.student_id}
                className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-white p-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-gray-900">{entry.student_name}</span>
                  <span className="ml-2 text-gray-500">{entry.project_name}</span>
                  {entry.owner_name && (
                    <span className="ml-2 text-xs text-gray-400">老師:{entry.owner_name}</span>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.candidates.map(candidate => (
                      <Button
                        key={candidate.roster_child_id}
                        variant="secondary"
                        size="xs"
                        onClick={() => handleLinkStudent(entry.student_id, candidate.roster_child_id)}
                      >
                        就是「{candidate.name}」#{candidate.roster_child_id}
                      </Button>
                    ))}
                    <Button variant="neutral" size="xs" onClick={() => handleCreateNewChild(entry)}>
                      是新的孩子
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Surface>
      )}

      {/* 分組預覽表 */}
      {preview && (
        <Surface padding="none" className="mb-4 min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-max text-sm">
            {/* 表頭與左右欄固定：表格改為容器內部滾動，th/td 各自 sticky 並帶實色背景 */}
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="sticky left-0 top-0 z-30 border-b border-r border-gray-200 bg-gray-50 px-4 py-2.5 font-medium">
                  <span className="flex items-center gap-2">
                    {isAdmin && (
                      <TriStateCheckbox
                        checked={visibleSelectedCount === visibleChildIds.length && visibleChildIds.length > 0}
                        indeterminate={visibleSelectedCount > 0}
                        onChange={event => setManySelected(visibleChildIds, event.target.checked)}
                        title={isFilterActive ? "全選 / 取消目前過濾結果" : "全部全選 / 取消"}
                      />
                    )}
                    {/* 數字與 checkbox 同視角：過濾中顯示畫面上的勾選數，全域數字在下載鈕 */}
                    {isAdmin
                      ? (isFilterActive
                        ? `孩子（已選 ${visibleSelectedCount}/${visibleChildIds.length}・過濾中）`
                        : `孩子（已選 ${selectedChildIds.size}/${preview.children.length}）`)
                      : `孩子（${preview.children.length}）`}
                  </span>
                </th>
                {periodColumns.map(period => (
                  <th key={period.id} className="sticky top-0 z-20 border-b border-gray-200 bg-gray-50 px-4 py-2.5 font-medium">{period.name}</th>
                ))}
                {isAdmin && (
                  <th className="sticky right-0 top-0 z-30 border-b border-l border-gray-200 bg-gray-50 px-4 py-2.5 font-medium">合併</th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredChildren.map((group, groupIndex) => {
                const entriesByPeriod = buildEntriesByPeriod(group);
                const firstPresentIndex = exportStats.firstPresentIndexByChild.get(group.roster_child_id) ?? 0;
                // 班級（最新期別的專案）變化時插入分段列
                const previousGroup = filteredChildren[groupIndex - 1];
                const isNewClassSection =
                  !previousGroup || previousGroup.latest_project_name !== group.latest_project_name;
                const classChildren = filteredChildren.filter(
                  other => other.latest_project_name === group.latest_project_name
                );
                const classChildIds = classChildren.map(other => other.roster_child_id);
                const classSelectedCount = classChildIds.filter(childId => selectedChildIds.has(childId)).length;
                const classMissingCount = classChildren.reduce(
                  (count, other) => count + other.entries.filter(entry => !entry.has_pdf).length,
                  0,
                );
                return [
                  isNewClassSection && (
                    <tr key={`class-${group.latest_project_id}-${group.roster_child_id}`} className="border-b border-gray-200 bg-indigo-50">
                      <td colSpan={totalColumnCount} className="py-1.5 text-xs text-indigo-700">
                        {/* 班級標題跟著橫向捲動固定在左側 */}
                        <span className="sticky left-4 inline-flex items-center gap-2">
                          {isAdmin && (
                            <TriStateCheckbox
                              checked={classSelectedCount === classChildIds.length}
                              indeterminate={classSelectedCount > 0}
                              onChange={event => setManySelected(classChildIds, event.target.checked)}
                              title="整班全選 / 取消"
                            />
                          )}
                          <span className="font-bold">{group.latest_project_name}</span>
                          {group.latest_project_owner_name && (
                            <span className="font-normal text-indigo-500">
                              老師：{group.latest_project_owner_name}
                            </span>
                          )}
                          {isAdmin && classMissingCount > 0 && (
                            <button
                              type="button"
                              disabled={isRenderingMissing}
                              onClick={() => handleRenderMissing(classChildIds, classMissingCount, `「${group.latest_project_name}」`)}
                              className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-[11px] text-indigo-600 hover:bg-indigo-100 disabled:opacity-40"
                            >
                              補渲染 {classMissingCount}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ),
                  <tr key={group.roster_child_id} className="border-b border-gray-100 last:border-0">
                    <td className="sticky left-0 z-10 border-r border-gray-100 bg-white px-4 py-2.5 font-medium text-gray-900">
                      {isAdmin ? (
                        <label className="flex cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            className="accent-indigo-600"
                            checked={selectedChildIds.has(group.roster_child_id)}
                            onChange={() => toggleChildSelected(group.roster_child_id)}
                          />
                          {group.name}
                        </label>
                      ) : (
                        group.name
                      )}
                    </td>
                    {periodColumns.map((period, periodIndex) => (
                      <td key={period.id} className="px-4 py-2.5">
                        {(entriesByPeriod[period.id] ?? []).length === 0 ? (
                          // 缺期標記：入園後的期別沒資料（可能漏建或離園）用 amber 提示
                          periodIndex > firstPresentIndex ? (
                            <Badge tone="warning">無資料</Badge>
                          ) : (
                            <span className="text-gray-300" title="該期尚未入園">—</span>
                          )
                        ) : (
                          <div className="flex flex-col gap-1">
                            {entriesByPeriod[period.id].map(entry => (
                              <div key={entry.student_id} className="group/entry flex items-center gap-1.5">
                                <Badge tone={entry.has_pdf ? "success" : "warning"}>
                                  {entry.has_pdf ? "已渲染" : "未渲染"}
                                </Badge>
                                {/* 點擊班級名直接開該專案的審閱頁 */}
                                <a
                                  href={`/projects/${entry.project_id}/review`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs text-gray-500 underline-offset-2 hover:text-indigo-600 hover:underline"
                                  title="開啟專案審閱頁"
                                >
                                  {entry.project_name}
                                </a>
                                {/* 老師手動刪除的頁面標註（非漏印） */}
                                {entry.skipped_pages?.length > 0 && (
                                  <span
                                    className="rounded bg-orange-50 px-1 py-0.5 text-[10px] text-orange-600"
                                    title={`老師刪除了第 ${entry.skipped_pages.join("、")} 頁`}
                                  >
                                    缺頁 {entry.skipped_pages.join(",")}
                                  </span>
                                )}
                                {/* 拆分：孩子有多筆時才有意義（錯誤合併的反向操作） */}
                                {isAdmin && group.entries.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={() => handleSplitEntry(entry)}
                                    className="invisible rounded p-0.5 text-gray-300 hover:bg-red-50 hover:text-red-500 group-hover/entry:visible"
                                    title="這筆不是同一個孩子，拆成新名冊項"
                                  >
                                    <Unlink className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                    {isAdmin && (
                      <td className="sticky right-0 z-10 border-l border-gray-100 bg-white px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          {/* fieldControlClass 內含 w-full，改用 style 限寬避免合併欄過寬 */}
                          <select
                            value={mergeTargets[group.roster_child_id] ?? ""}
                            onChange={event =>
                              setMergeTargets(prev => ({
                                ...prev,
                                [group.roster_child_id]: event.target.value,
                              }))
                            }
                            style={{ width: "9rem" }}
                            className={`${fieldControlClass} py-1 text-xs`}
                          >
                            <option value="">同一個孩子是…</option>
                            {preview.children
                              .filter(other => other.roster_child_id !== group.roster_child_id)
                              .map(other => (
                                <option key={other.roster_child_id} value={other.roster_child_id}>
                                  {other.name}（{other.latest_project_name}）
                                </option>
                              ))}
                          </select>
                          <Button
                            variant="neutral"
                            size="xs"
                            disabled={!mergeTargets[group.roster_child_id]}
                            onClick={() => handleMerge(group, mergeTargets[group.roster_child_id])}
                            title="把這一列併入所選孩子"
                          >
                            <GitMerge className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>,
                ];
              })}
              {filteredChildren.length === 0 && (
                <tr>
                  <td colSpan={totalColumnCount} className="px-4 py-8 text-center text-gray-400">
                    {preview.children.length === 0 ? "所選期別內沒有學生" : "沒有符合搜尋 / 過濾條件的孩子"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Surface>
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
          <Button variant="primary" onClick={handleDownload} disabled={selectedChildIds.size === 0}>
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
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
    </div>
  );
}
