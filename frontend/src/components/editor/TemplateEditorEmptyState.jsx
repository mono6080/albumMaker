import { Camera, ChevronLeft, Redo2, Undo2 } from "lucide-react";

import TemplateUsageBanner from "./TemplateUsageBanner";

export default function TemplateEditorEmptyState({
  template,
  isResponsiveCanvas,
  isPhoneEditor,
  confirmDialog,
  canUndo,
  canRedo,
  isSaving,
  hasUnsavedChanges,
  onExit,
  onUndo,
  onRedo,
  onSave,
  onAddPage,
}) {
  if (isResponsiveCanvas) {
    return (
      <div className={`mx-auto flex w-full max-w-[1042px] flex-col bg-slate-50 ${
        isPhoneEditor
          ? "fixed inset-0 z-30 h-dvh max-w-none overflow-hidden pb-[calc(4rem+env(safe-area-inset-bottom))]"
          : "h-[calc(100dvh-5.25rem)] min-h-0 overflow-hidden"
      }`}>
        {confirmDialog}
        <div
          className="flex min-h-14 flex-shrink-0 items-center gap-1 border-b border-gray-200 bg-white px-1.5 shadow-sm"
          data-guide={isPhoneEditor ? "mobile-editor-topbar" : "editor-compact-topbar"}
        >
          <button
            type="button"
            onClick={onExit}
            aria-label="返回模板列表"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-sm font-semibold text-gray-900" title={template.name}>
              {template.name}
            </h1>
            <p className="truncate text-[11px] text-gray-500">尚未建立頁面 · 0 張照片</p>
          </div>
          <span className="inline-flex flex-shrink-0 items-center" data-guide="history-actions">
            <button type="button" onClick={onUndo} disabled={!canUndo} aria-label="復原" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35">
              <Undo2 className="h-4 w-4" />
            </button>
            <button type="button" onClick={onRedo} disabled={!canRedo} aria-label="重做" className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35">
              <Redo2 className="h-4 w-4" />
            </button>
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving || !hasUnsavedChanges}
            data-guide="save-template"
            data-dirty={hasUnsavedChanges ? "true" : "false"}
            className="inline-flex min-h-11 min-w-14 flex-shrink-0 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {isSaving ? "儲存中" : "儲存"}
            {hasUnsavedChanges && (
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
            )}
          </button>
        </div>
        <TemplateUsageBanner template={template} />
        <div className="flex min-h-0 flex-1 items-center justify-center p-5">
          <section className="w-full max-w-sm rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center shadow-sm" aria-labelledby="empty-template-title">
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
              <Camera className="h-6 w-6" />
            </span>
            <h2 id="empty-template-title" className="mt-4 text-lg font-semibold text-gray-900">先建立第一頁</h2>
            <p className="mt-1 text-sm leading-6 text-gray-500">建立頁面後即可加入照片格、文字、背景與貼圖。</p>
            {!isPhoneEditor && (
              <button type="button" onClick={onAddPage} disabled={isSaving} className="mt-5 min-h-11 w-full rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                新增第一頁
              </button>
            )}
          </section>
        </div>
        {isPhoneEditor && (
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 p-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(15,23,42,0.08)]" data-guide="mobile-editor-dock">
            <button type="button" onClick={onAddPage} disabled={isSaving} aria-label="新增第一頁" className="inline-flex min-h-14 w-full items-center justify-center rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
              ＋ 新增第一頁
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {confirmDialog}
      <h1 className="text-2xl font-bold mb-4">編輯模板：{template.name}</h1>
      <div className="inline-flex items-center gap-1 text-sm text-gray-500 mb-4">
        <Camera className="w-4 h-4" />
        照片總計 0 張
      </div>
      <TemplateUsageBanner template={template} />
      <div className="flex items-center gap-2">
        <button
          onClick={onAddPage}
          disabled={isSaving}
          className="rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50"
        >
          新增第一頁
        </button>
        {hasUnsavedChanges && (
          <button
            onClick={onSave}
            disabled={isSaving}
            data-guide="save-template"
            data-dirty={hasUnsavedChanges ? "true" : "false"}
            className="rounded border border-indigo-200 bg-white px-4 py-2 text-indigo-700 disabled:opacity-50"
          >
            {isSaving ? "儲存中..." : "儲存"}
          </button>
        )}
      </div>
    </div>
  );
}
