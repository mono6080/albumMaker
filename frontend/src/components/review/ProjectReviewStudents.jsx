// 班級總覽的學生區:搜尋、內容填齊篩選與學生卡格線。
// 篩選的「未填齊/已填齊」指內容進度,與 completed_at 標記完成是兩回事(詞彙 SSOT: utils/reviewCompletion.js)。
// 下載相關狀態整包收 downloads(useProjectReviewDownloads 的回傳),在 map 時拆給卡片。

import { CheckCircle2, Clock, Search, Users } from "lucide-react";

import StudentReviewCard from "../StudentReviewCard";
import { Badge, SegmentedControl, fieldControlClass } from "../ui";

const REVIEW_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "全部", icon: Users, guideId: "review-filter-all" },
  { value: "incomplete", label: "未填齊", icon: Clock, guideId: "review-filter-pending" },
  { value: "complete", label: "已填齊", icon: CheckCircle2, guideId: "review-filter-done" },
];

export default function ProjectReviewStudents({
  students,
  visibleStudents,
  projectId,
  pageCount,
  previewTimestamp,
  templateRevision,
  canEditCurrentProject,
  canDownloadCurrentProject,
  canReopenProject,
  isProjectCompleted,
  photoProgressByStudentId,
  textProgressByStudentId,
  downloads,
  studentSearch,
  onStudentSearchChange,
  studentStatusFilter,
  onStudentStatusFilterChange,
  emptyFilteredStudentMessage,
  getVisiblePageIndexes,
  onPreview,
  onCompleteStudent,
  onReopenStudent,
}) {
  return (
    <>
      {students.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-gray-800">學生</h2>
          <Badge tone="neutral">{students.length} 位</Badge>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <label className="relative w-full sm:w-52" data-guide="review-student-search">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-300" />
              <input
                type="search"
                value={studentSearch}
                onChange={event => onStudentSearchChange(event.target.value)}
                placeholder="搜尋學生"
                className={`${fieldControlClass} w-full pl-9`}
              />
            </label>
            <div className="w-full sm:w-auto" data-guide="review-status-filter">
              <SegmentedControl
                value={studentStatusFilter}
                onChange={onStudentStatusFilterChange}
                size="sm"
                className="w-full"
                options={REVIEW_STATUS_FILTER_OPTIONS}
              />
            </div>
          </div>
        </div>
      )}

      {students.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Users className="mx-auto mb-3 h-10 w-10 opacity-30" />
          <p className="text-sm">此相本沒有學生快照</p>
          <p className="mt-1 text-xs">請管理員確認遷移資料，或從正確班級重新建立本期相本</p>
        </div>
      ) : visibleStudents.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-sm">{emptyFilteredStudentMessage}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleStudents.map(student => (
            <StudentReviewCard
              key={student.id}
              student={student}
              projectId={projectId}
              pageCount={pageCount}
              ts={previewTimestamp}
              templateRevision={templateRevision}
              canEditCurrentProject={canEditCurrentProject}
              canDownloadCurrentProject={canDownloadCurrentProject}
              canReopenProject={canReopenProject}
              isProjectCompleted={isProjectCompleted}
              photoProgress={photoProgressByStudentId.get(student.id)}
              textProgress={textProgressByStudentId.get(student.id)}
              isRendering={downloads.rendering[student.id]}
              isImageRendering={downloads.renderingImages[student.id]}
              isImageShareReady={downloads.isImageShareReady(student.id)}
              isPhotosDownloading={downloads.downloadingPhotos[student.id]}
              getVisiblePageIndexes={getVisiblePageIndexes}
              onPreview={onPreview}
              onDownloadPdf={downloads.handleDownloadOne}
              onDownloadImages={downloads.handleDownloadOneImages}
              onDownloadPhotos={downloads.handleDownloadOnePhotos}
              onCompleteStudent={onCompleteStudent}
              onReopenStudent={onReopenStudent}
            />
          ))}
        </div>
      )}
    </>
  );
}
