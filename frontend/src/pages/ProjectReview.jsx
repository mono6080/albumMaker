// 班級總覽頁:載入 project/template、完成/退回動作、教學導覽,並把派生狀態與
// 下載動作(整包 downloads)分發給進度區與學生區。
// 進度統計/篩選/工作階段的推導集中在 useProjectReviewDerivedState;
// 下載按鈕的顯示條件在此統一計算,教學導覽步驟過濾與畫面用同一組旗標。

import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { ChevronRight, CircleHelp, Pencil, Users } from "lucide-react";

import {
  completeProject,
  completeStudent,
  fetchProject as getProject,
  reopenProject,
  reopenStudent,
} from "../api/projectApi";
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
import useProjectReviewDerivedState from "../hooks/useProjectReviewDerivedState";
import useProjectReviewDownloads from "../hooks/useProjectReviewDownloads";
import { handleApiError } from "../utils/apiError";
import { startProductGuide } from "../utils/productGuide";

const PROJECT_REVIEW_GUIDE_STEPS = [
  {
    element: '[data-guide="review-progress"]',
    title: "班級進度與下一步",
    description: "一條看完班級進度：照片與文字進度、未填齊人數（點它會篩選出誰還缺），右側依階段建議下一步：製作 → 標記完成 → 交件。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="review-roster-button"]',
    title: "本期學生",
    description: "核對建立相本時帶入的成員與完整姓名快照；相本稱呼統一跟隨園所設定。",
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
    description: "標記這位學生完成（或全班完成）後，可只產出並下載他的 PDF；圖片按鈕在電腦下載 ZIP，手機會開啟系統分享。",
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
    element: '[data-guide="review-download-photos"]',
    title: "下載上傳照片",
    description: "把上傳過的原始照片打包成 ZIP 取回，依學生分資料夾；這是素材備份，不需標記完成、隨時可下載。",
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
  const effectiveMode = canDownloadPrint ? outputMode : "screen";
  const derived = useProjectReviewDerivedState({
    project,
    template,
    studentStatusFilter,
    studentSearch,
  });
  const downloadState = useProjectReviewDownloads({
    projectId,
    project,
    effectiveMode,
    getVisiblePageIndexes,
    projectLoadSequence,
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

  // 標記單一學生完成：該生內容鎖定並開放單人下載；最後一位完成時全班完成自動成立
  const handleCompleteStudent = (student) => {
    setConfirmModal({
      message: `確定標記「${student.name}」完成？完成後該生照片與文字將鎖定，並開放單人 PDF／圖片下載；需主管或管理員退回才能再修改。`,
      confirmLabel: "標記完成",
      confirmVariant: "success",
      onConfirm: async () => {
        try {
          const response = await completeStudent(projectId, student.id);
          if (response.data?.project_completed_at) {
            toast.success(`已標記 ${student.name} 完成；全班學生皆已完成，「全班完成」自動成立`);
          } else {
            toast.success(`已標記 ${student.name} 完成`);
          }
          await loadProject();
        } catch (error) {
          handleApiError(error, "標記完成失敗");
        }
      },
    });
  };

  // 退回單一學生完成（僅主管/admin）：全班完成已成立時一併解除
  const handleReopenStudent = (student) => {
    setConfirmModal({
      message: `退回後「${student.name}」的完成標記將解除、恢復可編輯；若「全班完成」已成立也會一併解除。確定退回？`,
      confirmLabel: "退回修改",
      confirmVariant: "primary",
      onConfirm: async () => {
        try {
          await reopenStudent(projectId, student.id);
          toast.success(`已退回 ${student.name}，恢復可編輯`);
          await loadProject();
        } catch (error) {
          handleApiError(error, "退回失敗");
        }
      },
    });
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-red-500 font-medium">{loadError}</p>
        <Link to="/projects" className="text-sm text-indigo-600 hover:underline">← 返回專案列表</Link>
      </div>
    );
  }

  if (!project || !template || !derived) {
    return <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>;
  }

  const pageCount = template.pages.length;
  const canReopenProject = canReopenProjectByCapability(project);

  // 下載相關顯示旗標:畫面與教學導覽的唯一來源
  const canOperateDownloads =
    canDownloadCurrentProject && (canEditCurrentProject || derived.hasRenderedStudents);
  const showDeliverableDownloads = derived.workStage >= 2 && canOperateDownloads;
  const hasAnyStudentDeliverableUnlocked =
    derived.isProjectCompleted || project.students.some(student => student.completed_at);

  const handleStartGuide = () => {
    const unavailableGuideElements = new Set();
    if (!canEditCurrentProject) unavailableGuideElements.add('[data-guide="review-roster-button"]');
    // 單人下載步驟：任一學生標記完成（或全班完成）即出現；交件下載步驟只看全班完成
    if (!hasAnyStudentDeliverableUnlocked || !canOperateDownloads) {
      unavailableGuideElements.add('[data-guide="review-download-student"]');
    }
    if (!derived.isProjectCompleted || !canOperateDownloads) {
      unavailableGuideElements.add('[data-guide="review-download-all"]');
    }
    if (!canDownloadCurrentProject) {
      unavailableGuideElements.add('[data-guide="review-download-photos"]');
    }
    const guideSteps = PROJECT_REVIEW_GUIDE_STEPS.filter(
      step => !unavailableGuideElements.has(step.element),
    );
    startProductGuide(guideSteps);
  };

  return (
    <div className="w-full">
      <PageHeader
        title={project.name}
        badge={(
          <>
            <Badge tone="review">班級總覽</Badge>
            {derived.isProjectCompleted && (
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
          workStage={derived.workStage}
          isProjectCompleted={derived.isProjectCompleted}
          classPhotoFilled={derived.classPhotoFilled}
          classPhotoTotal={derived.classPhotoTotal}
          classTextFilled={derived.classTextFilled}
          classTextTotal={derived.classTextTotal}
          contentIncompleteStudentCount={derived.contentIncompleteStudentCount}
          completedStudentCount={derived.completedStudentCount}
          studentTotal={project.students.length}
          commentsCount={comments.length}
          canEditCurrentProject={canEditCurrentProject}
          canDownloadCurrentProject={canDownloadCurrentProject}
          canReopenProject={canReopenProject}
          canDownloadPrint={canDownloadPrint}
          showDeliverableDownloads={showDeliverableDownloads}
          downloads={downloadState}
          outputMode={outputMode}
          onOutputModeChange={setOutputMode}
          onFilterIncomplete={() => {
            setStudentStatusFilter("incomplete");
            setStudentSearch("");
          }}
          onCompleteProject={handleCompleteProject}
          onReopenProject={handleReopenProject}
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
        visibleStudents={derived.visibleStudents}
        projectId={projectId}
        pageCount={pageCount}
        previewTimestamp={previewTimestamp}
        templateRevision={project.template_revision}
        canEditCurrentProject={canEditCurrentProject}
        canDownloadCurrentProject={canDownloadCurrentProject}
        canReopenProject={canReopenProject}
        isProjectCompleted={derived.isProjectCompleted}
        photoProgressByStudentId={derived.photoProgressByStudentId}
        textProgressByStudentId={derived.textProgressByStudentId}
        downloads={downloadState}
        studentSearch={studentSearch}
        onStudentSearchChange={setStudentSearch}
        studentStatusFilter={studentStatusFilter}
        onStudentStatusFilterChange={setStudentStatusFilter}
        emptyFilteredStudentMessage={derived.emptyFilteredStudentMessage}
        getVisiblePageIndexes={getVisiblePageIndexes}
        onPreview={(studentId, pageIndex) => setPreview({ studentId, pageIndex })}
        onCompleteStudent={handleCompleteStudent}
        onReopenStudent={handleReopenStudent}
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
        students={project.students}
        photoProgressByStudentId={derived.photoProgressByStudentId}
      />
    </div>
  );
}
