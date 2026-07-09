// 學期彙整匯出頁（admin 專用）
// 選擇部門與期別範圍 → 依名冊孩子分組預覽各期相冊狀態 →
// 處理待確認的同名歧義配對 → 下載「孩子/期別.pdf」結構的 ZIP

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Archive, Download, GitMerge, Loader2, RefreshCw } from "lucide-react";

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
} from "../api/rosterApi";
import { renderClient } from "../api/authApi";
import { downloadApiBlob } from "../utils/browserFiles";
import ConfirmModal from "../components/ConfirmModal";
import { Badge, Button, PageHeader, SegmentedControl, Surface, fieldControlClass } from "../components/ui";

const PERIOD_STATUS_LABELS = { draft: "草稿", active: "使用中", archived: "已封存" };

export default function SemesterExport() {
  const [departments, setDepartments] = useState([]);
  const [activeDepartment, setActiveDepartment] = useState(null);
  const [allPeriods, setAllPeriods] = useState([]);
  const [selectedPeriodIds, setSelectedPeriodIds] = useState([]);
  const [preview, setPreview] = useState(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);
  // 各孩子列的合併目標選擇（roster_child_id → 目標 id 字串）
  const [mergeTargets, setMergeTargets] = useState({});

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
    } catch {
      toast.error("載入匯出預覽失敗");
    }
    setIsLoadingPreview(false);
  };

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

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      await downloadApiBlob(
        renderClient,
        buildSemesterExportDownloadUrl(selectedPeriodIds, "print"),
        "semester_export.zip",
      );
    } catch {
      toast.error("下載失敗");
    }
    setIsDownloading(false);
  };

  const periodColumns = preview?.periods ?? [];

  // 每個孩子依期別整理格位：period_id → entries
  const buildEntriesByPeriod = (group) => {
    const entriesByPeriod = {};
    for (const entry of group.entries) {
      (entriesByPeriod[entry.period_id] ??= []).push(entry);
    }
    return entriesByPeriod;
  };

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        icon={Archive}
        iconTone="review"
        title="學期彙整匯出"
        subtitle="選擇期別範圍，依名冊孩子分組下載整學期相冊 PDF"
      />

      {/* 期別選擇 */}
      <Surface className="mb-4">
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

      {/* 待確認配對 */}
      {preview && preview.unlinked.length > 0 && (
        <Surface className="mb-4 border-amber-200 bg-amber-50/60">
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
                </div>
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
              </div>
            ))}
          </div>
        </Surface>
      )}

      {/* 分組預覽表 */}
      {preview && (
        <Surface padding="none" className="mb-4 overflow-x-auto">
          <table className="w-full min-w-max text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                <th className="px-4 py-2.5 font-medium">孩子（{preview.children.length}）</th>
                {periodColumns.map(period => (
                  <th key={period.id} className="px-4 py-2.5 font-medium">{period.name}</th>
                ))}
                <th className="px-4 py-2.5 font-medium">合併</th>
              </tr>
            </thead>
            <tbody>
              {preview.children.map(group => {
                const entriesByPeriod = buildEntriesByPeriod(group);
                return (
                  <tr key={group.roster_child_id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-2.5 font-medium text-gray-900">{group.name}</td>
                    {periodColumns.map(period => (
                      <td key={period.id} className="px-4 py-2.5">
                        {(entriesByPeriod[period.id] ?? []).length === 0 ? (
                          <span className="text-gray-300">—</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {entriesByPeriod[period.id].map(entry => (
                              <div key={entry.student_id} className="flex items-center gap-1.5">
                                <Badge tone={entry.has_pdf ? "success" : "warning"}>
                                  {entry.has_pdf ? "已渲染" : "未渲染"}
                                </Badge>
                                <span className="text-xs text-gray-500">{entry.project_name}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        <select
                          value={mergeTargets[group.roster_child_id] ?? ""}
                          onChange={event =>
                            setMergeTargets(prev => ({
                              ...prev,
                              [group.roster_child_id]: event.target.value,
                            }))
                          }
                          className={`${fieldControlClass} w-36 py-1 text-xs`}
                        >
                          <option value="">同一個孩子是…</option>
                          {preview.children
                            .filter(other => other.roster_child_id !== group.roster_child_id)
                            .map(other => (
                              <option key={other.roster_child_id} value={other.roster_child_id}>
                                {other.name}
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
                  </tr>
                );
              })}
              {preview.children.length === 0 && (
                <tr>
                  <td colSpan={periodColumns.length + 2} className="px-4 py-8 text-center text-gray-400">
                    所選期別內沒有學生
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Surface>
      )}

      {/* 下載 */}
      {preview && preview.children.length > 0 && (
        <div className="flex items-center justify-end gap-3">
          {preview.unlinked.length > 0 && (
            <span className="text-xs text-amber-600">
              尚有 {preview.unlinked.length} 位學生未配對，不會納入匯出
            </span>
          )}
          <Button variant="primary" onClick={handleDownload} disabled={isDownloading}>
            {isDownloading
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Download className="h-4 w-4" />}
            下載學期彙整 ZIP（列印畫質）
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
