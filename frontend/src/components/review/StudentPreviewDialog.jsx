import { appendPreviewCacheVersion, buildStudentPagePreviewUrl } from "../../api/urls";
import { IconButton, Surface } from "../ui";

export default function StudentPreviewDialog({
  preview,
  dialogRef,
  project,
  projectId,
  pageCount,
  previewTimestamp,
  getVisiblePageIndexes,
  onPreviewChange,
  onClose,
}) {
  if (!preview) return null;

  const previewStudent = project.students.find(student => student.id === preview.studentId);
  const visiblePages = getVisiblePageIndexes(previewStudent);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <Surface
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="學生頁面預覽"
        padding="none"
        variant="dialog"
        className="max-w-md w-full overflow-hidden"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex justify-between items-center px-5 py-4 border-b border-gray-100">
          <div>
            <div className="font-semibold text-gray-900">{previewStudent?.name}</div>
            <div className="text-xs text-gray-400">第 {preview.pageIndex + 1} 頁預覽</div>
          </div>
          <IconButton label="關閉預覽" onClick={onClose} size="md">✕</IconButton>
        </div>
        <img
          src={appendPreviewCacheVersion(
            buildStudentPagePreviewUrl(projectId, preview.studentId, preview.pageIndex),
            previewTimestamp,
            project.template_revision,
          )}
          alt="preview"
          className="w-full"
        />
        {pageCount > 1 && visiblePages.length > 1 && (
          <div className="flex justify-center gap-2 p-3 border-t border-gray-100">
            {visiblePages.map(pageIndex => (
              <button
                key={pageIndex}
                onClick={() => onPreviewChange({ ...preview, pageIndex })}
                className={`h-8 w-8 rounded-lg text-xs font-medium transition-colors ${
                  preview.pageIndex === pageIndex
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {pageIndex + 1}
              </button>
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}
