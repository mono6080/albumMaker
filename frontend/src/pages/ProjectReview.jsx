import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { ChevronRight, CircleHelp, Pencil, Users } from "lucide-react";

import { completeProject, fetchProject as getProject, reopenProject } from "../api/projectApi";
import { fetchProjectTemplatePair } from "../api/templateApi";
import ConfirmModal from "../components/ConfirmModal";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import ReviewCommentsPanel from "../components/ReviewCommentsPanel";
import RosterModal from "../components/RosterModal";
import ProjectReviewProgress from "../components/review/ProjectReviewProgress";
import ProjectReviewStudents from "../components/review/ProjectReviewStudents";
import StudentPreviewDialog from "../components/review/StudentPreviewDialog";
import { Badge, Button, PageHeader } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import useDialogA11y from "../hooks/useDialogA11y";
import { usePermissions } from "../hooks/usePermissions";
import useProjectReviewComments from "../hooks/useProjectReviewComments";
import useProjectReviewDownloads from "../hooks/useProjectReviewDownloads";
import { computeStudentPhotoProgress } from "../utils/photoProgress";
import { startProductGuide } from "../utils/productGuide";
import { computeStudentTextProgress } from "../utils/textProgress";

const PROJECT_REVIEW_GUIDE_STEPS = [
  {
    element: '[data-guide="review-progress"]',
    title: "班級進度與下一步",
    description: "一條看完班級進度：照片與文字進度、未完成人數（點它會篩選出誰還缺），右側依階段建議下一步：製作 → 全班完成 → 交件。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="review-roster-button"]',
    title: "本期學生快照",
    description: "核對建立相本時從班級目前名單帶入的固定快照；完整姓名只讀，這裡只調整相本稱呼。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="review-student-card"]',
    title: "學生卡片",
    description: "每張卡片是一位學生：照片進度、PDF 狀態一目了然，點卡片直接進入編輯。",
    side: "top",
    align: "start",
  },
  {
    element: '[data-guide="review-preview-student"]',
    title: "快速預覽",
    description: "點任一頁縮圖即可放大預覽，不用進編輯頁。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="review-download-student"]',
    title: "下載單一學生",
    description: "標記全班完成後，可只產出並下載這位學生的 PDF；圖片按鈕在電腦下載 ZIP，手機會開啟系統分享。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="review-download-all"]',
    title: "交件下載",
    description: "標記全班完成後，可批次產生並下載全班 PDF ZIP；全部圖片在電腦下載 ZIP，手機會準備圖片後開啟分享。",
    side: "left",
    align: "center",
  },
  {
    element: '[data-guide="review-comments"]',
    title: "審閱意見",
    description: "老師可查看主管或設計端留下的審閱意見；有權限的人員可新增或刪除留言。",
    side: "top",
    align: "start",
  },
];

export default function ProjectReview() {
  const { id: projectId } = useParams();
  const {
    canDownloadPrint,
    canCommentProject,
    canDownloadProject,
    canEditProject,
    canReopenProject: canReopenProjectByCapability,
    isAdmin,
  } = usePermissions();
  const { currentUser } = useAuth();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [projectLoadSequence, setProjectLoadSequence] = useState(0);
  const [preview, setPreview] = useState(null);
  const [previewTimestamp, setPreviewTimestamp] = useState(() => Date.now());
  const [outputMode, setOutputMode] = useState("print");
  const [studentStatusFilter, setStudentStatusFilter] = useState("all");
  const [studentSearch, setStudentSearch] = useState("");
  const [confirmModal, setConfirmModal] = useState(null);
  const [isRosterOpen, setIsRosterOpen] = useState(false);

  const previewDialogRef = useDialogA11y({
    isOpen: Boolean(preview),
    onClose: () => setPreview(null),
  });

  const loadProject = useCallback(async () => {
    try {
      const { projectData, templateResponse } = await fetchProjectTemplatePair(
        () => getProject(projectId),
      );
      setProject(projectData);
      setPreviewTimestamp(new Date(projectData.updated_at).getTime() || Date.now());
      setTemplate(templateResponse.data);
      setProjectLoadSequence(previous => previous + 1);
    } catch {
      setLoadError("找不到專案，請確認連結是否正確");
    }
  }, [projectId]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  const getVisiblePageIndexes = useCallback((studentRecord) => {
    if (!studentRecord) return [];
    const skippedPages = new Set(
      (studentRecord.pages_data || [])
        .filter(pageData => pageData.skip)
        .map(pageData => pageData.page_index),
    );
    return Array.from({ length: template?.pages.length ?? 0 }, (_, pageIndex) => pageIndex)
      .filter(pageIndex => !skippedPages.has(pageIndex));
  }, [template]);

  const {
    comments,
    newCommentText,
    setNewCommentText,
    isSubmittingComment,
    handleSubmitComment,
    handleDeleteComment,
  } = useProjectReviewComments(projectId, setConfirmModal);

  const canEditCurrentProject = project ? canEditProject(project) : false;
  const canDownloadCurrentProject = project ? canDownloadProject(project) : false;
  const canCommentCurrentProject = project ? canCommentProject(project) : false;
  const hasRenderedStudents = project?.students.some(student => student.output_filename) ?? false;
  const effectiveMode = canDownloadPrint ? outputMode : "screen";
  const downloadState = useProjectReviewDownloads({
    projectId,
    project,
    effectiveMode,
    getVisiblePageIndexes,
    reloadProject: loadProject,
    projectLoadSequence,
    canRender: canEditCurrentProject,
  });

  const handleCompleteProject = () => {
    setConfirmModal({
      message: "確定標記「全班完成」？完成後全班照片與文字將鎖定，並開放 PDF／圖片下載；需主管或管理員退回才能再修改。",
      confirmLabel: "全班完成",
      confirmVariant: "success",
      onConfirm: async () => {
        try {
          await completeProject(projectId);
          toast.success("已標記全班完成");
          await loadProject();
        } catch {
          toast.error("標記完成失敗");
        }
      },
    });
  };

  const handleReopenProject = () => {
    setConfirmModal({
      message: "退回後老師即可再修改全班照片與文字。確定退回「全班完成」？",
      confirmLabel: "退回修改",
      confirmVariant: "primary",
      onConfirm: async () => {
        try {
          await reopenProject(projectId);
          toast.success("已退回，恢復可編輯");
          await loadProject();
        } catch {
          toast.error("退回失敗");
        }
      },
    });
  };

  const handleStartGuide = () => {
    const unavailableGuideElements = new Set();
    if (!canEditCurrentProject) unavailableGuideElements.add('[data-guide="review-roster-button"]');
    if (!isProjectCompleted || !canDownloadCurrentProject || (!canEditCurrentProject && !hasRenderedStudents)) {
      unavailableGuideElements.add('[data-guide="review-download-student"]');
      unavailableGuideElements.add('[data-guide="review-download-all"]');
    }
    const guideSteps = PROJECT_REVIEW_GUIDE_STEPS.filter(
      step => !unavailableGuideElements.has(step.element),
    );
    startProductGuide(guideSteps);
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-red-500 font-medium">{loadError}</p>
        <Link to="/projects" className="text-sm text-indigo-600 hover:underline">← 返回專案列表</Link>
      </div>
    );
  }

  if (!project || !template) {
    return <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>;
  }

  const pageCount = template.pages.length;
  const isProjectCompleted = Boolean(project.completed_at);
  const canReopenProject = project ? canReopenProjectByCapability(project) : false;
  const photoProgressByStudentId = new Map(
    project.students.map(student => [
      student.id,
      computeStudentPhotoProgress(student.pages_data, template.pages),
    ]),
  );
  const classPhotoFilled = [...photoProgressByStudentId.values()]
    .reduce((sum, progress) => sum + progress.filled, 0);
  const classPhotoTotal = [...photoProgressByStudentId.values()]
    .reduce((sum, progress) => sum + progress.total, 0);
  const textProgressByStudentId = new Map(
    project.students.map(student => [
      student.id,
      computeStudentTextProgress(
        student.pages_data,
        template.pages,
        project.label_texts,
      ),
    ]),
  );
  const classTextFilled = [...textProgressByStudentId.values()]
    .reduce((sum, progress) => sum + progress.filled, 0);
  const classTextTotal = [...textProgressByStudentId.values()]
    .reduce((sum, progress) => sum + progress.total, 0);
  const incompleteStudents = project.students.filter(student => {
    const photoProgress = photoProgressByStudentId.get(student.id);
    const textProgress = textProgressByStudentId.get(student.id);
    const isPhotoComplete = photoProgress.total === 0
      || photoProgress.filled === photoProgress.total;
    const isTextComplete = textProgress.total === 0
      || textProgress.filled === textProgress.total;
    return !isPhotoComplete || !isTextComplete;
  });
  const workStage = isProjectCompleted
    ? 3
    : incompleteStudents.length === 0
      ? 2
      : 1;

  const trimmedStudentSearch = studentSearch.trim().toLowerCase();
  const visibleStudents = project.students.filter(student => {
    const photoProgress = photoProgressByStudentId.get(student.id);
    const textProgress = textProgressByStudentId.get(student.id);
    const isPhotoComplete = photoProgress.total === 0
      || photoProgress.filled === photoProgress.total;
    const isTextComplete = textProgress.total === 0
      || textProgress.filled === textProgress.total;
    const isContentComplete = isPhotoComplete && isTextComplete;
    const matchesStatus =
      studentStatusFilter === "all" ||
      (studentStatusFilter === "incomplete" && !isContentComplete) ||
      (studentStatusFilter === "complete" && isContentComplete);
    const matchesSearch =
      !trimmedStudentSearch ||
      (student.name ?? "").toLowerCase().includes(trimmedStudentSearch);
    return matchesStatus && matchesSearch;
  });
  const emptyFilteredStudentMessage = trimmedStudentSearch
    ? `沒有符合「${studentSearch.trim()}」的學生`
    : "目前篩選沒有學生";

  return (
    <div className="w-full">
      <PageHeader
        title={project.name}
        badge={(
          <>
            <Badge tone="review">班級總覽</Badge>
            {isProjectCompleted && (
              <Badge tone="success" title={`完成於 ${new Date(project.completed_at).toLocaleString("zh-TW")}`}>
                ✓ 全班完成
              </Badge>
            )}
          </>
        )}
        meta={(
          <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
            <ChevronRight className="inline h-4 w-4 rotate-180 sm:hidden" />
            相本工作
          </Button>
        )}
        actions={(
          <ResponsiveActionGroup mobileColumns={canEditCurrentProject ? 3 : 1}>
            {canEditCurrentProject && (
              <Button
                as={Link}
                to={`/projects/${projectId}/edit`}
                data-guide="review-edit-link"
                variant="primary"
                size="touch"
                className={responsiveActionItemClass}
              >
                <Pencil className="w-4 h-4" />
                <span className="hidden sm:inline">編輯相本</span>
                <span className="sm:hidden">編輯</span>
              </Button>
            )}
            {canEditCurrentProject && (
              <Button
                type="button"
                onClick={() => setIsRosterOpen(true)}
                data-guide="review-roster-button"
                variant="secondary"
                size="touch"
                className={responsiveActionItemClass}
              >
                <Users className="w-4 h-4" />
                <span className="hidden sm:inline">本期學生</span>
                <span className="sm:hidden">學生</span>
              </Button>
            )}
            <Button
              type="button"
              onClick={handleStartGuide}
              variant="secondary"
              size="touch"
              className={responsiveActionItemClass}
            >
              <CircleHelp className="w-4 h-4" />
              <span className="hidden sm:inline">製作教學</span>
              <span className="sm:hidden">教學</span>
            </Button>
          </ResponsiveActionGroup>
        )}
      />

      {project.students.length > 0 && (
        <ProjectReviewProgress
          projectId={projectId}
          workStage={workStage}
          classPhotoFilled={classPhotoFilled}
          classPhotoTotal={classPhotoTotal}
          classTextFilled={classTextFilled}
          classTextTotal={classTextTotal}
          incompleteStudentCount={incompleteStudents.length}
          commentsCount={comments.length}
          canEditCurrentProject={canEditCurrentProject}
          canDownloadCurrentProject={canDownloadCurrentProject}
          hasRenderedStudents={hasRenderedStudents}
          canReopenProject={canReopenProject}
          canDownloadPrint={canDownloadPrint}
          isBatchRendering={downloadState.isBatchRendering}
          renderingAll={downloadState.renderingAll}
          renderingAllImages={downloadState.renderingAllImages}
          renderAllProgress={downloadState.renderAllProgress}
          renderAllImagesProgress={downloadState.renderAllImagesProgress}
          isAllImagesShareReady={downloadState.isAllImagesShareReady}
          outputMode={outputMode}
          onOutputModeChange={setOutputMode}
          onFilterIncomplete={() => {
            setStudentStatusFilter("incomplete");
            setStudentSearch("");
          }}
          onCompleteProject={handleCompleteProject}
          onReopenProject={handleReopenProject}
          onDownloadAll={downloadState.handleDownloadAll}
          onDownloadAllImages={downloadState.handleDownloadAllImages}
        />
      )}

      <StudentPreviewDialog
        preview={preview}
        dialogRef={previewDialogRef}
        project={project}
        projectId={projectId}
        pageCount={pageCount}
        previewTimestamp={previewTimestamp}
        getVisiblePageIndexes={getVisiblePageIndexes}
        onPreviewChange={setPreview}
        onClose={() => setPreview(null)}
      />

      <ProjectReviewStudents
        students={project.students}
        visibleStudents={visibleStudents}
        projectId={projectId}
        pageCount={pageCount}
        previewTimestamp={previewTimestamp}
        templateRevision={project.template_revision}
        canEditCurrentProject={canEditCurrentProject}
        canDownloadCurrentProject={canDownloadCurrentProject}
        isProjectCompleted={isProjectCompleted}
        photoProgressByStudentId={photoProgressByStudentId}
        textProgressByStudentId={textProgressByStudentId}
        rendering={downloadState.rendering}
        renderingImages={downloadState.renderingImages}
        studentSearch={studentSearch}
        onStudentSearchChange={setStudentSearch}
        studentStatusFilter={studentStatusFilter}
        onStudentStatusFilterChange={setStudentStatusFilter}
        emptyFilteredStudentMessage={emptyFilteredStudentMessage}
        getVisiblePageIndexes={getVisiblePageIndexes}
        isImageShareReady={downloadState.isImageShareReady}
        onPreview={(studentId, pageIndex) => setPreview({ studentId, pageIndex })}
        onDownloadPdf={downloadState.handleDownloadOne}
        onDownloadImages={downloadState.handleDownloadOneImages}
      />

      {canDownloadCurrentProject && (
        <ReviewCommentsPanel
          comments={comments}
          canComment={canCommentCurrentProject}
          isAdmin={isAdmin}
          currentUser={currentUser}
          newCommentText={newCommentText}
          isSubmittingComment={isSubmittingComment}
          onChangeNewComment={setNewCommentText}
          onSubmitComment={handleSubmitComment}
          onDeleteComment={handleDeleteComment}
        />
      )}

      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        confirmLabel={confirmModal?.confirmLabel}
        confirmVariant={confirmModal?.confirmVariant}
        onConfirm={async () => {
          await confirmModal?.onConfirm();
          setConfirmModal(null);
        }}
        onCancel={() => setConfirmModal(null)}
      />

      <RosterModal
        isOpen={isRosterOpen}
        onClose={() => setIsRosterOpen(false)}
        projectId={projectId}
        students={project.students}
        photoProgressByStudentId={photoProgressByStudentId}
        onChanged={loadProject}
        isLocked={isProjectCompleted && !isAdmin}
      />
    </div>
  );
}
