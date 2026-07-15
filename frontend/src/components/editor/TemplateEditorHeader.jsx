import {
  BookOpen,
  Camera,
  ChevronLeft,
  CircleHelp,
  Redo2,
  Undo2,
} from "lucide-react";

import { Button } from "../ui";

export default function TemplateEditorHeader({
  isResponsiveCanvas,
  isPhoneEditor,
  templateName,
  pageIndex,
  pageCount,
  totalPhotoCount,
  canUndo,
  canRedo,
  isSaving,
  hasUnsavedChanges,
  hasRepairableMaterialLinks,
  onExit,
  onUndo,
  onRedo,
  onSave,
  onStartGuide,
  onOpenSpreadPreview,
}) {
  if (isResponsiveCanvas) {
    return (
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
          <h1 className="truncate text-sm font-semibold text-gray-900" title={templateName}>
            {templateName}
          </h1>
          <p className="truncate text-[11px] text-gray-500">
            第 {pageIndex + 1}/{pageCount} 頁 · {totalPhotoCount} 張照片
          </p>
        </div>
        <span className="inline-flex flex-shrink-0 items-center" data-guide="history-actions">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="復原"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label="重做"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-35"
          >
            <Redo2 className="h-4 w-4" />
          </button>
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving || hasRepairableMaterialLinks}
          title={hasRepairableMaterialLinks ? "請先清除失效素材連結" : undefined}
          data-guide="save-template"
          data-dirty={hasUnsavedChanges ? "true" : "false"}
          className="inline-flex min-h-11 min-w-14 flex-shrink-0 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {isSaving ? "儲存中" : "儲存"}
          {hasUnsavedChanges && (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
          )}
        </button>
        <span className="sr-only" aria-live="polite">
          {isSaving ? "儲存中" : hasUnsavedChanges ? "有未儲存變更" : "已儲存"}
        </span>
      </div>
    );
  }

  return (
    <div className="mb-3 flex flex-shrink-0 flex-wrap items-center gap-3" data-guide="editor-header">
      <button onClick={onExit} className="text-sm text-gray-500 hover:text-gray-700">
        ← 返回
      </button>
      <h1 className="text-lg font-bold">{templateName}</h1>
      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">模板編輯器</span>
      <span data-guide="template-photo-count" className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
        <Camera className="h-3 w-3" />
        照片總計 {totalPhotoCount} 張
      </span>
      <div className="ml-auto flex items-center gap-2" data-guide="top-actions">
        <Button type="button" onClick={onStartGuide} variant="secondary" size="sm">
          <CircleHelp className="h-4 w-4" />
          製作教學
        </Button>
        <span className="inline-flex items-center gap-2" data-guide="history-actions">
          <button type="button" onClick={onUndo} disabled={!canUndo} aria-label="復原" title="復原 (Ctrl+Z)" className="inline-flex h-8 w-8 items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-35">
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={onRedo} disabled={!canRedo} aria-label="重做" title="重做 (Ctrl+Y / Ctrl+Shift+Z)" className="inline-flex h-8 w-8 items-center justify-center rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-35">
            <Redo2 className="h-4 w-4" />
          </button>
        </span>
        <button type="button" onClick={onOpenSpreadPreview} disabled={isSaving || pageCount === 0} data-guide="spread-preview" className="inline-flex items-center gap-1.5 rounded border border-gray-200 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
          <BookOpen className="h-4 w-4" />
          雙頁預覽
        </button>
        <button onClick={onSave} disabled={isSaving || hasRepairableMaterialLinks} title={hasRepairableMaterialLinks ? "請先清除失效素材連結" : undefined} data-guide="save-template" data-dirty={hasUnsavedChanges ? "true" : "false"} className="inline-flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50">
          {isSaving ? "儲存中..." : "儲存"}
          {hasUnsavedChanges && (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-300" />
          )}
        </button>
      </div>
    </div>
  );
}
