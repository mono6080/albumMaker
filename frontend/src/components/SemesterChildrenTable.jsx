// 學期彙整匯出：依後端校別／班級 snapshot 分組的 accordion。
// 孩子每一期狀態只讀 cell.status，不以出現順序推測入園、離園或缺相本。

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

import { Badge, Button, Surface } from "./ui";

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

function groupKey(group) {
  return `${groupCampusId(group)}:${groupClassroomId(group)}`;
}

function periodTemplateId(period) {
  return period.template_period_id ?? period.id;
}

function periodLabel(period) {
  return period.period_name ?? period.name ?? "未命名期別";
}

function entrySourceLabel(entry) {
  return `${entry.campus_name ?? "未命名校別"}／${entry.classroom_name ?? "未命名班級"}`;
}

function EntryLink({ entry }) {
  return (
    <div className="min-w-0">
      <a
        href={`/projects/${entry.project_id}/review`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1 break-words text-xs text-gray-700 underline-offset-2 hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        <span>{entry.project_name}</span>
        <ExternalLink aria-hidden="true" className="h-3 w-3 flex-shrink-0" />
        <span className="sr-only">（在新分頁開啟）</span>
      </a>
      <p className="mt-0.5 text-[10px] text-gray-400">{entrySourceLabel(entry)}</p>
      {(entry.skipped_pages ?? []).length > 0 && (
        <span
          className="mt-1 inline-block rounded bg-orange-50 px-1 py-0.5 text-[10px] text-orange-700"
          title={`老師刪除了第 ${entry.skipped_pages.join("、")} 頁`}
        >
          缺頁 {entry.skipped_pages.join("、")}
        </span>
      )}
    </div>
  );
}

function SemesterCell({ cell }) {
  if (!cell) return <span className="text-xs text-gray-400">不適用</span>;
  const entries = cell.entries ?? [];
  if (cell.status === "not_enrolled") return <Badge tone="neutral">尚未入園</Badge>;
  if (cell.status === "departed") return <Badge tone="neutral">已離園</Badge>;
  if (cell.status === "no_album") return <Badge tone="warning">無相本</Badge>;
  if (cell.status === "duplicate") {
    return (
      <div className="space-y-2">
        <Badge tone="danger">重複 {entries.length} 本，不匯出</Badge>
        {entries.map(entry => <EntryLink key={entry.student_id} entry={entry} />)}
      </div>
    );
  }
  const entry = entries[0];
  return (
    <div className="space-y-1.5">
      <Badge tone={cell.status === "ready" ? "success" : "warning"}>
        {cell.status === "ready" ? "已產生 PDF" : "未產生 PDF"}
      </Badge>
      {entry && <EntryLink entry={entry} />}
    </div>
  );
}

function GroupCheckbox({ group, children, selectedChildIds, onSetManySelected }) {
  const childIds = children.map(child => child.roster_child_id);
  const selectedCount = childIds.filter(childId => selectedChildIds.has(childId)).length;
  return (
    <input
      type="checkbox"
      aria-label={`選取 ${groupCampusName(group)} ${groupClassroomName(group)} 的孩子`}
      className="h-4 w-4 flex-shrink-0 accent-indigo-600"
      checked={childIds.length > 0 && selectedCount === childIds.length}
      ref={element => {
        if (element) element.indeterminate = selectedCount > 0 && selectedCount < childIds.length;
      }}
      onChange={event => onSetManySelected(childIds, event.target.checked)}
    />
  );
}

export default function SemesterChildrenTable({
  classroomGroups,
  periods,
  isAdmin,
  selectedChildIds,
  isRenderingMissing,
  onToggleChildSelected,
  onSetManySelected,
  onRenderMissing,
}) {
  const [expandedGroupKeys, setExpandedGroupKeys] = useState(new Set());

  const toggleGroup = (selectedGroupKey) => {
    setExpandedGroupKeys(current => {
      const next = new Set(current);
      if (next.has(selectedGroupKey)) next.delete(selectedGroupKey);
      else next.add(selectedGroupKey);
      return next;
    });
  };

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-1">
      {classroomGroups.map(group => {
        const selectedGroupKey = groupKey(group);
        const isExpanded = expandedGroupKeys.has(selectedGroupKey);
        const children = group.children ?? [];
        const childIds = children.map(child => child.roster_child_id);
        const selectedCount = childIds.filter(childId => selectedChildIds.has(childId)).length;
        const notRenderedCount = children.reduce((count, child) => (
          count + (child.cells ?? []).filter(cell => cell.status === "not_rendered").length
        ), 0);
        const issueCount = children.reduce((count, child) => (
          count + (child.cells ?? []).filter(cell => (
            cell.status === "no_album" || cell.status === "duplicate"
          )).length
        ), 0);
        return (
          <Surface key={selectedGroupKey} as="section" padding="none" className="overflow-hidden">
            <div className="flex min-h-11 items-center gap-3 px-3 py-2 sm:px-4">
              {isAdmin && (
                <GroupCheckbox
                  group={group}
                  children={children}
                  selectedChildIds={selectedChildIds}
                  onSetManySelected={onSetManySelected}
                />
              )}
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={`semester-classroom-${selectedGroupKey}`}
                onClick={() => toggleGroup(selectedGroupKey)}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-bold text-gray-900">
                    {groupCampusName(group)}／{groupClassroomName(group)}
                  </h2>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {children.length} 位孩子
                    {isAdmin ? ` · 已選 ${selectedCount}` : ""}
                    {notRenderedCount > 0 ? ` · ${notRenderedCount} 本 PDF 未產生` : ""}
                    {issueCount > 0 ? ` · ${issueCount} 格需核對` : ""}
                  </p>
                </div>
                {isExpanded
                  ? <ChevronUp aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-gray-400" />
                  : <ChevronDown aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-gray-400" />}
              </button>
              {isAdmin && notRenderedCount > 0 && (
                <Button
                  size="xs"
                  variant="neutral"
                  disabled={isRenderingMissing}
                  onClick={() => onRenderMissing(childIds, notRenderedCount, `「${groupCampusName(group)}／${groupClassroomName(group)}」`)}
                >
                  補產生 {notRenderedCount}
                </Button>
              )}
            </div>

            {isExpanded && (
              <div id={`semester-classroom-${selectedGroupKey}`} className="overflow-x-auto border-t border-gray-100">
                <table className="w-full min-w-max text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
                      <th scope="col" className="sticky left-0 z-20 min-w-40 border-r border-gray-200 bg-gray-50 px-4 py-2.5 font-medium">
                        孩子
                      </th>
                      {periods.map(period => (
                        <th key={periodTemplateId(period)} scope="col" className="min-w-56 px-4 py-2.5 font-medium">
                          {periodLabel(period)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {children.map(child => {
                      const cellsByPeriodId = new Map((child.cells ?? []).map(cell => [
                        cell.template_period_id,
                        cell,
                      ]));
                      return (
                        <tr key={child.roster_child_id} className="border-b border-gray-100 align-top last:border-0">
                          <th scope="row" className="sticky left-0 z-10 border-r border-gray-100 bg-white px-4 py-3 text-left font-medium text-gray-900">
                            {isAdmin ? (
                              <label className="flex min-h-11 cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  aria-label={`選取 ${child.name}`}
                                  className="h-4 w-4 accent-indigo-600"
                                  checked={selectedChildIds.has(child.roster_child_id)}
                                  onChange={() => onToggleChildSelected(child.roster_child_id)}
                                />
                                <span>{child.name}</span>
                              </label>
                            ) : child.name}
                          </th>
                          {periods.map(period => (
                            <td key={periodTemplateId(period)} className="px-4 py-3">
                              <SemesterCell cell={cellsByPeriodId.get(periodTemplateId(period))} />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Surface>
        );
      })}

      {classroomGroups.length === 0 && (
        <Surface className="text-center text-sm text-gray-500">
          沒有符合搜尋或狀態篩選的班級與孩子。
        </Surface>
      )}
    </div>
  );
}
