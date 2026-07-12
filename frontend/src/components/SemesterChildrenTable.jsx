// 學期彙整匯出：依名冊孩子分組的預覽表
// 表頭與左右欄 sticky、班級分段列、缺期標記、匯出勾選、admin 的補產生/拆分/合併操作。
// 狀態、過濾計算與 API 呼叫都在 SemesterExport 頁，這裡只負責呈現與轉發事件

import { GitMerge, Unlink } from "lucide-react";

import { Badge, Button, Surface, fieldControlClass } from "./ui";

// 名冊比對用：移除所有空白（含全形），與後端 normalize_child_name 規則對齊
const normalizeChildName = (name) => (name ?? "").replace(/[\s\u3000]+/g, "");

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

// 每個孩子依期別整理格位：period_id → entries
const buildEntriesByPeriod = (group) => {
  const entriesByPeriod = {};
  for (const entry of group.entries) {
    (entriesByPeriod[entry.period_id] ??= []).push(entry);
  }
  return entriesByPeriod;
};

export default function SemesterChildrenTable({
  preview,
  exportStats,
  filteredChildren,
  isAdmin,
  selectedChildIds,
  visibleChildIds,
  visibleSelectedCount,
  isFilterActive,
  mergeTargets,
  setMergeTargets,
  isRenderingMissing,
  onToggleChildSelected,
  onSetManySelected,
  onRenderMissing,
  onSplitEntry,
  onMerge,
}) {
  const periodColumns = preview?.periods ?? [];
  // 合併欄只有 admin 看得到，表格總欄數隨之增減
  const totalColumnCount = periodColumns.length + 1 + (isAdmin ? 1 : 0);
  return (
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
                    onChange={event => onSetManySelected(visibleChildIds, event.target.checked)}
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
            // 合併下拉：同名孩子（最可能是誤拆）排最前，其餘收在後面
            const otherChildren = preview.children.filter(
              other => other.roster_child_id !== group.roster_child_id
            );
            const sameNameMergeCandidates = otherChildren.filter(
              other => normalizeChildName(other.name) === normalizeChildName(group.name)
            );
            const otherMergeCandidates = otherChildren.filter(
              other => !sameNameMergeCandidates.includes(other)
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
                          onChange={event => onSetManySelected(classChildIds, event.target.checked)}
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
                          onClick={() => onRenderMissing(classChildIds, classMissingCount, `「${group.latest_project_name}」`)}
                          className="rounded border border-indigo-200 bg-white px-1.5 py-0.5 text-[11px] text-indigo-600 hover:bg-indigo-100 disabled:opacity-40"
                        >
                          補產生 {classMissingCount}
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
                        onChange={() => onToggleChildSelected(group.roster_child_id)}
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
                              {entry.has_pdf ? "已產生" : "未產生"}
                            </Badge>
                            {/* 點擊班級名直接開該專案的班級總覽 */}
                            <a
                              href={`/projects/${entry.project_id}/review`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-gray-500 underline-offset-2 hover:text-indigo-600 hover:underline"
                              title="開啟班級總覽"
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
                                onClick={() => onSplitEntry(entry)}
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
                        {sameNameMergeCandidates.length > 0 && (
                          <optgroup label="同名（最可能）">
                            {sameNameMergeCandidates.map(other => (
                              <option key={other.roster_child_id} value={other.roster_child_id}>
                                {other.name}（{other.latest_project_name}）
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {otherMergeCandidates.length > 0 && (
                          <optgroup label="其他孩子">
                            {otherMergeCandidates.map(other => (
                              <option key={other.roster_child_id} value={other.roster_child_id}>
                                {other.name}（{other.latest_project_name}）
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <Button
                        variant="neutral"
                        size="xs"
                        disabled={!mergeTargets[group.roster_child_id]}
                        onClick={() => onMerge(group, mergeTargets[group.roster_child_id])}
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
  );
}
