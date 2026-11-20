// 學期彙整匯出：老師手動刪頁的相本清單（哪本相本少幾頁、為什麼）
// 範圍跟著目前的校別／班級篩選與搜尋，與下方表格一致

import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

import { Surface } from "./ui";
import { groupSkippedPagesByReason } from "../utils/skippedPages";

export default function SemesterSkippedPagesSection({ rows }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const totalPages = rows.reduce((count, row) => count + row.entry.skipped_pages.length, 0);

  return (
    <Surface padding="none" className="mb-4 shrink-0 overflow-hidden border-orange-200 bg-orange-50/60">
      <button
        type="button"
        aria-expanded={isExpanded}
        aria-controls="semester-skipped-pages"
        onClick={() => setIsExpanded(current => !current)}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300"
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-orange-800">
            缺頁相本（{rows.length} 本，共少 {totalPages} 頁）
          </h2>
          <p className="mt-0.5 text-xs text-orange-700">
            老師手動刪除的頁面與原因；這些頁不會出現在 PDF，下載的匯出說明也會列出。
          </p>
        </div>
        {isExpanded
          ? <ChevronUp aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-orange-400" />
          : <ChevronDown aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-orange-400" />}
      </button>
      {isExpanded && (
        <ul id="semester-skipped-pages" className="flex max-h-72 flex-col gap-2 overflow-y-auto border-t border-orange-200 p-3">
          {rows.map(({ key, childName, periodName, entry }) => (
            <li
              key={key}
              className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-orange-200 bg-white p-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="min-w-0 sm:w-64 sm:flex-shrink-0">
                <p className="text-sm">
                  <span className="font-medium text-gray-900">{childName}</span>
                  <span className="ml-2 text-xs text-gray-500">{periodName}</span>
                  <span className="ml-2 whitespace-nowrap text-xs font-medium text-orange-700">
                    少 {entry.skipped_pages.length} 頁
                  </span>
                </p>
                <a
                  href={`/projects/${entry.project_id}/review`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 break-words text-xs text-gray-700 underline-offset-2 hover:text-indigo-600 hover:underline"
                >
                  <span className="min-w-0 break-words">{entry.project_name}</span>
                  <ExternalLink aria-hidden="true" className="h-3 w-3 flex-shrink-0" />
                  <span className="sr-only">（在新分頁開啟）</span>
                </a>
              </div>
              <ul className="min-w-0 flex-1 space-y-0.5 text-xs text-gray-700">
                {groupSkippedPagesByReason(entry.skipped_pages).map(({ reason, pages }) => (
                  <li key={reason} className="break-words">
                    <span className="text-gray-500">第 {pages.join("、")} 頁：</span>{reason}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
