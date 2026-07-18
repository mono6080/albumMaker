// 使用者管理：Excel 批次建立區塊（選檔、匯入、結果摘要）
// 匯入狀態與 API 呼叫在 UserManagement 頁，這裡只負責呈現與轉發事件

import { FileSpreadsheet, Upload } from "lucide-react";

export default function UserExcelImportForm({
  // 隱藏 file input 的 ref（由頁面持有，匯入成功後用來清空選檔）
  fileInputRef,
  importFile,
  onFileChange,
  isImporting,
  importResult,
  onSubmit,
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm space-y-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <FileSpreadsheet className="w-4 h-4 text-emerald-600 flex-shrink-0" />
          <h2 className="font-semibold text-gray-800 text-sm">Excel 批次建立</h2>
        </div>
        <div className="text-xs text-gray-400">
          欄位：username、display_name、password、role；匯入後到園所設定安排主管與班級
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          className="sr-only"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"
        >
          <FileSpreadsheet className="w-4 h-4" />
          選擇 Excel
        </button>
        <div className="min-w-0 flex-1 text-sm text-gray-500">
          <span className="block truncate">{importFile?.name ?? "尚未選擇檔案"}</span>
        </div>
        <button
          type="submit"
          disabled={isImporting || !importFile}
          className="inline-flex items-center gap-1.5 bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          <Upload className="w-4 h-4" />
          {isImporting ? "匯入中..." : "匯入"}
        </button>
      </div>
      {importResult && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
          <div>
            建立 {importResult.created_count} 位，略過 {importResult.skipped_count} 位，錯誤 {importResult.error_count} 筆
          </div>
          {importResult.errors?.slice(0, 3).map((item) => (
            <div key={`${item.row}-${item.username}`} className="text-red-600">
              第 {item.row} 列 {item.username || "未填帳號"}：{item.error}
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
