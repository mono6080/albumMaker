// 模板編輯器的雙頁合併預覽 Modal
// 從 TemplateEditor 抽出：開啟前的強制儲存由父層負責，這裡只管瀏覽與翻組

import { useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, X } from "lucide-react";

import { buildTemplateSpreadPreviewUrl } from "../api/urls";

export default function SpreadPreviewModal({ templateId, pageCount, initialPageIndex, onClose }) {
  // 每次開啟都重新掛載，因此初始組別與時間戳直接由 useState 初始化
  const [spreadStartIndex, setSpreadStartIndex] = useState(() => Math.floor(initialPageIndex / 2) * 2);
  const [spreadPreviewTimestamp, setSpreadPreviewTimestamp] = useState(() => Date.now());

  const lastSpreadStartIndex = Math.max(0, Math.floor((pageCount - 1) / 2) * 2);
  const spreadEndIndex = Math.min(spreadStartIndex + 1, pageCount - 1);
  const spreadPreviewUrl = `${buildTemplateSpreadPreviewUrl(templateId, spreadStartIndex)}?t=${spreadPreviewTimestamp}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="雙頁預覽"
        className="w-[min(96vw,1200px)] max-h-[92vh] bg-white rounded-lg shadow-xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200">
          <BookOpen className="w-5 h-5 text-indigo-600" />
          <h2 className="font-semibold">雙頁預覽</h2>
          <span className="text-sm text-gray-500" data-guide="spread-page-range">
            第 {spreadStartIndex + 1}{spreadEndIndex > spreadStartIndex ? `-${spreadEndIndex + 1}` : ""} 頁
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉雙頁預覽"
            data-guide="spread-close"
            className="ml-auto w-8 h-8 inline-flex items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="bg-gray-100 p-3 overflow-auto">
          <img
            key={spreadPreviewUrl}
            src={spreadPreviewUrl}
            alt="雙頁合併預覽"
            data-guide="spread-preview-image"
            className="block mx-auto max-w-full max-h-[76vh] bg-white border border-gray-300"
          />
        </div>

        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={() => {
              setSpreadStartIndex(index => Math.max(0, index - 2));
              setSpreadPreviewTimestamp(Date.now());
            }}
            disabled={spreadStartIndex <= 0}
            data-guide="spread-prev"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            <ChevronLeft className="w-4 h-4" />
            上一組
          </button>
          <button
            type="button"
            onClick={() => {
              setSpreadStartIndex(index => Math.min(lastSpreadStartIndex, index + 2));
              setSpreadPreviewTimestamp(Date.now());
            }}
            disabled={spreadStartIndex >= lastSpreadStartIndex}
            data-guide="spread-next"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            下一組
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
