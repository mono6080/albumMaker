import { ChevronLeft, ChevronRight } from "lucide-react";

export default function AlbumPageNav({ page, total, onChange }) {
  if (total <= 1) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <button
          onClick={() => onChange(p => Math.max(0, p - 1))}
          disabled={page === 0}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden sm:inline">上一頁</span>
        </button>
        <span className="text-sm text-gray-500">
          第 {page + 1} 頁 ／ 共 {total} 頁
        </span>
        <button
          onClick={() => onChange(p => Math.min(total - 1, p + 1))}
          disabled={page === total - 1}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-30 transition-colors"
        >
          <span className="hidden sm:inline">下一頁</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="flex justify-center gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            onClick={() => onChange(i)}
            className={`rounded-full transition-all ${
              page === i ? "w-5 h-2 bg-indigo-500" : "w-2 h-2 bg-gray-300 hover:bg-gray-400"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
