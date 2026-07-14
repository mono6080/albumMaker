import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { completeProject, fetchProject as getProject, renderStudent, reopenProject } from "../api/projectApi";
import { fetchProjectTemplatePair } from "../api/templateApi";
import {
  appendPreviewCacheVersion,
  buildStudentPagePreviewUrl as previewUrl,
  buildDownloadPdfUrl as downloadPdf,
  buildDownloadImagesZipUrl as downloadImagesZip,
  buildDownloadAllZipUrl as downloadAllZip,
  buildDownloadAllImagesZipUrl as downloadAllImagesZip,
} from "../api/urls";
import { apiClient, renderClient } from "../api/authApi";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import useDialogA11y from "../hooks/useDialogA11y";
import {
  Badge,
  Button,
  IconButton,
  PageHeader,
  SegmentedControl,
  Surface,
  fieldControlClass,
} from "../components/ui";
import {
  ChevronRight, CircleHelp, ImageDown, Loader2, Pencil, Package,
  CheckCircle2, Clock, Printer, Monitor, MessageCircle,
  RotateCcw, Search, Users,
} from "lucide-react";
import { startProductGuide } from "../utils/productGuide";
import { showRetryToast } from "../utils/retryToast";
import { computeStudentPhotoProgress } from "../utils/photoProgress";
import ConfirmModal from "../components/ConfirmModal";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import RosterModal from "../components/RosterModal";
import StudentReviewCard from "../components/StudentReviewCard";
import ReviewCommentsPanel from "../components/ReviewCommentsPanel";
import {
  createFileFromBlob,
  downloadApiBlob,
  fetchApiBlob,
  getShareFailureMessage,
  isMobileDevice,
  shareFiles,
  triggerNativeDownload,
} from "../utils/browserFiles";

const PROJECT_REVIEW_GUIDE_STEPS = [
  {
    element: '[data-guide="review-progress"]',
    title: "班級進度與下一步",
    description: "一條看完班級進度：照片進度、缺照片人數（點它會篩選出誰還缺），右側依階段建議下一步：製作 → 全班完成 → 交件。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="review-roster-button"]',
    title: "學生名單",
    description: "在這裡管理學生：批次貼上新增、行內改名或刪除。名單就緒後再放素材與照片。",
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
    description: "只產出並下載這位學生的 PDF；圖片按鈕在電腦下載 ZIP，手機會開啟系統分享。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="review-download-all"]',
    title: "交件下載",
    description: "批次產生並下載全班 PDF ZIP；全部圖片在電腦下載 ZIP，手機會準備圖片後開啟分享。",
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
  const { id } = useParams();
  const { canDownloadPrint, canComment, canEditProject, isAdmin } = usePermissions();
  const { currentUser } = useAuth();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [rendering, setRendering] = useState({});
  const [renderingImages, setRenderingImages] = useState({});
  const [renderingAll, setRenderingAll] = useState(false);
  const [renderingAllImages, setRenderingAllImages] = useState(false);
  // { current: number, total: number } | null
  const [renderAllProgress, setRenderAllProgress] = useState(null);
  const [renderAllImagesProgress, setRenderAllImagesProgress] = useState(null);
  const [preview, setPreview] = useState(null);
  const previewDialogRef = useDialogA11y({
    isOpen: Boolean(preview),
    onClose: () => setPreview(null),
  });
  const [imageShareDrafts, setImageShareDrafts] = useState({});
  const [allImagesShareDraft, setAllImagesShareDraft] = useState(null);
  const [ts, setTs] = useState(() => Date.now());
  // 非 admin 固定使用 screen 模式
  const [outputMode, setOutputMode] = useState("print");
  // 下載時實際生效的輸出模式：無列印權限者一律 screen
  const effectiveMode = canDownloadPrint ? outputMode : "screen";
  const [studentStatusFilter, setStudentStatusFilter] = useState("all");
  const [studentSearch, setStudentSearch] = useState("");
  const [confirmModal, setConfirmModal] = useState(null);
  const [isRosterOpen, setIsRosterOpen] = useState(false);

  // ── 留言 ──────────────────────────────────────────────────────────────────
  const [comments, setComments] = useState([]);
  const [newCommentText, setNewCommentText] = useState("");
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  const loadProject = useCallback(async () => {
    try {
      const { projectData, templateResponse } = await fetchProjectTemplatePair(
        () => getProject(id),
      );
      setProject(projectData);
      // 預覽 URL 的版本戳跟著 updated_at 走：內容沒變就沿用同一組 URL，
      // 瀏覽器快取（後端已改為 private, max-age）能吃到，來回切頁不重載縮圖牆
      setTs(new Date(projectData.updated_at).getTime() || Date.now());
      setTemplate(templateResponse.data);
      setImageShareDrafts({});
      setAllImagesShareDraft(null);
    } catch {
      setLoadError("找不到專案，請確認連結是否正確");
    }
  }, [id]);

  const loadComments = useCallback(async () => {
    try {
      const response = await apiClient.get(`/projects/${id}/comments`);
      setComments(response.data);
    } catch { /* 靜默，留言非關鍵功能 */ }
  }, [id]);

  useEffect(() => {
    loadProject();
    loadComments();
  }, [loadProject, loadComments]);

  const getVisiblePageIndexes = useCallback((studentRecord) => {
    if (!studentRecord) return [];
    const skippedPages = new Set(
      (studentRecord.pages_data || []).filter(pageData => pageData.skip).map(pageData => pageData.page_index)
    );
    return Array.from({ length: template?.pages.length ?? 0 }, (_, pageIndex) => pageIndex)
      .filter(pageIndex => !skippedPages.has(pageIndex));
  }, [template]);

  const handleDownloadOne = async (studentId) => {
    setRendering(prev => ({ ...prev, [studentId]: true }));
    try {
      await renderStudent(id, studentId);
      await loadProject();
      await downloadApiBlob(
        renderClient,
        downloadPdf(id, studentId, effectiveMode),
        "album.pdf",
      );
    } catch { showRetryToast("產生失敗", () => handleDownloadOne(studentId)); }
    setRendering(prev => ({ ...prev, [studentId]: false }));
  };

  const buildShareImageFiles = async (students, requestTs, onProgress) => {
    const files = [];
    for (let studentIndex = 0; studentIndex < students.length; studentIndex++) {
      const studentRecord = students[studentIndex];
      onProgress?.(studentIndex + 1, students.length);

      const visiblePageIndexes = getVisiblePageIndexes(studentRecord);
      for (const [visibleIndex, pageIndex] of visiblePageIndexes.entries()) {
        const { blob } = await fetchApiBlob(
          renderClient,
          appendPreviewCacheVersion(
            previewUrl(id, studentRecord.id, pageIndex),
            requestTs,
            project.template_revision,
          ),
        );
        const file = createFileFromBlob(
          blob,
          `${studentRecord.name}_page${visibleIndex + 1}.jpg`,
          "image/jpeg",
        );
        if (file) files.push(file);
      }
    }
    return files;
  };

  const handleDownloadOneImages = async (studentId) => {
    setRenderingImages(prev => ({ ...prev, [studentId]: true }));
    try {
      const studentRecord = project.students.find(student => student.id === studentId);
      if (!studentRecord) return;

      if (isMobileDevice()) {
        const preparedShare = imageShareDrafts[studentId];
        if (preparedShare?.files?.length) {
          const shareResult = await shareFiles(preparedShare.files, preparedShare.title);
          if (shareResult === "shared") {
            setImageShareDrafts(prev => {
              const next = { ...prev };
              delete next[studentId];
              return next;
            });
            toast.success("已開啟分享");
          } else if (shareResult !== "cancelled") {
            toast.error(getShareFailureMessage(shareResult));
          }
          return;
        }

        const files = await buildShareImageFiles([studentRecord], Date.now());
        if (!files.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        setImageShareDrafts(prev => ({
          ...prev,
          [studentId]: { files, title: `${studentRecord.name} 相冊圖片` },
        }));
        toast.success("圖片已準備好，請再按一次開始分享");
        return;
      }

      await renderStudent(id, studentId);
      await loadProject();
      await downloadApiBlob(
        renderClient,
        downloadImagesZip(id, studentId, effectiveMode),
        "album-images.zip",
      );
    } catch { showRetryToast("產生圖片失敗", () => handleDownloadOneImages(studentId)); }
    finally {
      setRenderingImages(prev => ({ ...prev, [studentId]: false }));
    }
  };

  // 逐位渲染（單人失敗不中斷整批），失敗者自動補渲一輪；回傳仍失敗的名單
  const renderAllStudentsWithRetry = async (students, onProgress) => {
    const failedStudents = [];
    for (let i = 0; i < students.length; i++) {
      onProgress?.(i + 1, students.length);
      try { await renderStudent(id, students[i].id); }
      catch { failedStudents.push(students[i]); }
    }
    const stillFailed = [];
    for (const studentRecord of failedStudents) {
      try { await renderStudent(id, studentRecord.id); }
      catch { stillFailed.push(studentRecord); }
    }
    return stillFailed;
  };

  const handleDownloadAll = async () => {
    const students = project.students;
    if (!students.length) return;
    setRenderingAll(true);
    setRenderAllProgress({ current: 0, total: students.length });
    try {
      const stillFailed = await renderAllStudentsWithRetry(
        students,
        (current, total) => setRenderAllProgress({ current, total }),
      );
      await loadProject();
      if (stillFailed.length > 0) {
        // 內容沒變的學生後端會直接跳過，重試只重做失敗的，不用怕整批重來
        showRetryToast(`${stillFailed.map(s => s.name).join("、")} 產生失敗`, handleDownloadAll);
        return;
      }
      // ZIP 動輒數百 MB：走瀏覽器原生下載，不經 axios blob（避免 timeout 與整包塞記憶體）
      triggerNativeDownload(downloadAllZip(id, effectiveMode));
      toast.success("已開始下載，請留意瀏覽器的下載列");
    } catch { showRetryToast("批次產生失敗", handleDownloadAll); }
    finally {
      setRenderingAll(false);
      setRenderAllProgress(null);
    }
  };

  const handleDownloadAllImages = async () => {
    const students = project.students;
    if (!students.length) return;
    setRenderingAllImages(true);
    setRenderAllImagesProgress({ current: 0, total: students.length });
    try {
      if (isMobileDevice()) {
        if (allImagesShareDraft?.files?.length) {
          const shareResult = await shareFiles(allImagesShareDraft.files, allImagesShareDraft.title);
          if (shareResult === "shared") {
            setAllImagesShareDraft(null);
            toast.success("已開啟分享");
          } else if (shareResult !== "cancelled") {
            toast.error(getShareFailureMessage(shareResult));
          }
          return;
        }

        const files = await buildShareImageFiles(
          students,
          Date.now(),
          (current, total) => setRenderAllImagesProgress({ current, total }),
        );
        if (!files.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        setAllImagesShareDraft({ files, title: `${project.name} 全部圖片` });
        toast.success("圖片已準備好，請再按一次開始分享");
        return;
      }

      const stillFailed = await renderAllStudentsWithRetry(
        students,
        (current, total) => setRenderAllImagesProgress({ current, total }),
      );
      await loadProject();
      if (stillFailed.length > 0) {
        showRetryToast(`${stillFailed.map(s => s.name).join("、")} 產生失敗`, handleDownloadAllImages);
        return;
      }
      // 圖片 ZIP 比 PDF ZIP 更大：一樣走瀏覽器原生下載
      triggerNativeDownload(downloadAllImagesZip(id, effectiveMode));
      toast.success("已開始下載，請留意瀏覽器的下載列");
    } catch { showRetryToast("批次產生圖片失敗", handleDownloadAllImages); }
    finally {
      setRenderingAllImages(false);
      setRenderAllImagesProgress(null);
    }
  };

  const handleSubmitComment = async () => {
    if (!newCommentText.trim()) return;
    setIsSubmittingComment(true);
    try {
      await apiClient.post(
        `/projects/${id}/comments`,
        new URLSearchParams({ content: newCommentText.trim() })
      );
      setNewCommentText("");
      await loadComments();
    } catch (error) {
      toast.error(error.response?.data?.detail || "留言失敗");
    } finally {
      setIsSubmittingComment(false);
    }
  };

  // ── 全班完成 / 退回 ───────────────────────────────────────────────────────

  const handleCompleteProject = () => {
    setConfirmModal({
      message: "確定標記「全班完成」？完成後全班照片與文字將鎖定，需主管或管理員退回才能再修改；仍可預覽與下載。",
      confirmLabel: "全班完成",
      confirmVariant: "success",
      onConfirm: async () => {
        try {
          await completeProject(id);
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
          await reopenProject(id);
          toast.success("已退回，恢復可編輯");
          await loadProject();
        } catch {
          toast.error("退回失敗");
        }
      },
    });
  };

  // 刪除留言不可復原，先經 ConfirmModal 確認
  const handleDeleteComment = (commentId) => {
    setConfirmModal({
      message: "確定刪除這則留言？刪除後無法復原。",
      confirmLabel: "刪除",
      confirmVariant: "danger",
      onConfirm: async () => {
        try {
          await apiClient.delete(`/projects/${id}/comments/${commentId}`);
          await loadComments();
        } catch (error) {
          toast.error(error.response?.data?.detail || "刪除失敗");
        }
      },
    });
  };

  const startGuide = () => {
    // 沒有編輯權限時，過濾掉只有編輯者看得到的導覽元素
    const editOnlyGuideElements = [
      '[data-guide="review-roster-button"]',
      '[data-guide="review-download-student"]',
      '[data-guide="review-download-all"]',
    ];
    const guideSteps = canEditCurrentProject
      ? PROJECT_REVIEW_GUIDE_STEPS
      : PROJECT_REVIEW_GUIDE_STEPS.filter(step => !editOnlyGuideElements.includes(step.element));
    startProductGuide(guideSteps);
  };

  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3">
      <p className="text-red-500 font-medium">{loadError}</p>
      <Link to="/projects" className="text-sm text-indigo-600 hover:underline">← 返回專案列表</Link>
    </div>
  );

  if (!project || !template) return (
    <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
  );

  const pageCount = template.pages.length;
  const isBatchRendering = renderingAll || renderingAllImages;
  const isAllImagesShareReady = isMobileDevice() && allImagesShareDraft?.files?.length > 0;
  const canEditCurrentProject = canEditProject(project.owner_id);
  const isProjectCompleted = Boolean(project.completed_at);
  // 退回權限：admin 或主管（後端會再驗證管轄範圍）
  const canReopenProject = isAdmin || currentUser?.role === "supervisor";

  // ── 班級工作台：照片進度與階段判斷 ─────────────────────────────────────────
  // 階段 1 製作中（有照片格未填）→ 階段 2 照片備齊（可標記完成）→ 階段 3 已完成（交件）
  const photoProgressByStudentId = new Map(
    project.students.map(student => [
      student.id,
      computeStudentPhotoProgress(student.pages_data, template.pages),
    ])
  );
  const classPhotoFilled = [...photoProgressByStudentId.values()].reduce((sum, progress) => sum + progress.filled, 0);
  const classPhotoTotal = [...photoProgressByStudentId.values()].reduce((sum, progress) => sum + progress.total, 0);
  const incompleteStudents = project.students.filter(student => {
    const progress = photoProgressByStudentId.get(student.id);
    return progress.total > 0 && progress.filled < progress.total;
  });
  // 純文字模板（沒有照片格）沒有「製作照片」階段，直接視為可標記完成
  const workStage = isProjectCompleted ? 3 : classPhotoTotal === 0 || incompleteStudents.length === 0 ? 2 : 1;

  // 篩選以照片進度為軸（PDF 狀態是輸出產物，不當篩選依據）
  const trimmedStudentSearch = studentSearch.trim().toLowerCase();
  const visibleStudents = project.students.filter(student => {
    const progress = photoProgressByStudentId.get(student.id);
    const isPhotoComplete = progress.total === 0 || progress.filled === progress.total;
    const matchesStatus =
      studentStatusFilter === "all" ||
      (studentStatusFilter === "incomplete" && !isPhotoComplete) ||
      (studentStatusFilter === "complete" && isPhotoComplete);
    const matchesSearch =
      !trimmedStudentSearch ||
      (student.name ?? "").toLowerCase().includes(trimmedStudentSearch);
    return matchesStatus && matchesSearch;
  });
  const reviewStatusFilterOptions = [
    { value: "all", label: "全部", icon: Users, guideId: "review-filter-all" },
    { value: "incomplete", label: "缺照片", icon: Clock, guideId: "review-filter-pending" },
    { value: "complete", label: "照片齊", icon: CheckCircle2, guideId: "review-filter-done" },
  ];
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
          <>
            <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
              <ChevronRight className="inline h-4 w-4 rotate-180 sm:hidden" />
              相本專案
            </Button>
          </>
        )}
        actions={(
          // 與編輯頁相同的功能鈕排版（行動版滿寬網格）
          <ResponsiveActionGroup mobileColumns={canEditCurrentProject ? 3 : 1}>
            {/* 與編輯頁右上的「班級總覽」互為對稱切換按鈕（同專案卡的雙入口用語與用色） */}
            {canEditCurrentProject && (
              <Button
                as={Link}
                to={`/projects/${id}/edit`}
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
            {/* 名單是工作台上的資料，用 Modal 管理，不再是獨立頁面 */}
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
                <span className="hidden sm:inline">學生名單</span>
                <span className="sm:hidden">名單</span>
              </Button>
            )}
            <Button
              type="button"
              onClick={startGuide}
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

      {/* 班級工作台橫幅：階段 ｜ 照片進度 ｜ 下一步動作，一條看完 */}
      {project.students.length > 0 && (
        <Surface className="mb-4" data-guide="review-progress">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            {/* 三階段指示 */}
            <div className="flex flex-wrap items-center gap-1 text-[11px] font-medium lg:flex-shrink-0">
              {[
                { step: 1, label: "製作" },
                { step: 2, label: "全班完成" },
                { step: 3, label: "交件" },
              ].map(({ step, label }, index) => (
                <span key={step} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight className="h-3 w-3 text-gray-300" />}
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 ${
                      workStage === step
                        ? "bg-indigo-600 text-white"
                        : workStage > step
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-gray-100 text-gray-400"
                    }`}
                  >
                    {workStage > step ? "✓" : `${step}．`}{label}
                  </span>
                </span>
              ))}
            </div>

            {/* 班級進度（只看照片：PDF 是輸出產物，不是進度依據） */}
            <div className="min-w-0 flex-1 lg:border-l lg:border-gray-100 lg:pl-4">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-gray-600">照片進度</span>
                {classPhotoTotal === 0 ? (
                  <span className="text-gray-400">此模板沒有照片格（純文字相本）</span>
                ) : (
                  <span className={`font-semibold tabular-nums ${classPhotoFilled === classPhotoTotal ? "text-emerald-600" : "text-gray-700"}`}>
                    {classPhotoFilled} / {classPhotoTotal} 格
                  </span>
                )}
                {/* 缺照片摘要：點了直接套用篩選（並清掉搜尋字，避免數字對不上），誰缺就看下方學生卡 */}
                {incompleteStudents.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => { setStudentStatusFilter("incomplete"); setStudentSearch(""); }}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    <Clock className="h-3 w-3" />
                    缺照片 {incompleteStudents.length} 位
                  </button>
                ) : classPhotoTotal > 0 && (
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                    <CheckCircle2 className="h-3 w-3" />
                    全班照片齊
                  </span>
                )}
                {comments.length > 0 && (
                  <a
                    href="#review-comments"
                    className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 font-medium text-violet-700 transition-colors hover:bg-violet-100"
                  >
                    <MessageCircle className="h-3 w-3" />
                    {comments.length} 則審閱意見
                  </a>
                )}
              </div>
              {classPhotoTotal > 0 && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full transition-all ${classPhotoFilled === classPhotoTotal ? "bg-emerald-500" : "bg-indigo-500"}`}
                    style={{ width: `${(classPhotoFilled / classPhotoTotal) * 100}%` }}
                  />
                </div>
              )}
            </div>

            {/* 依階段的主要動作 */}
            <div className="flex flex-col gap-2 lg:w-72 lg:flex-shrink-0 lg:border-l lg:border-gray-100 lg:pl-4">
              {workStage === 1 && (
                canEditCurrentProject ? (
                  <>
                    <Button
                      as={Link}
                      to={`/projects/${id}/edit`}
                      variant="primary"
                      fullWidth
                    >
                      <Pencil className="h-4 w-4" />
                      繼續製作（{incompleteStudents.length} 位缺照片）
                    </Button>
                    {/* 一張照片都還沒放就不給「直接完成」——那只會是誤觸 */}
                    {classPhotoFilled > 0 && (
                      <Button onClick={handleCompleteProject} disabled={isBatchRendering} variant="successSoft" size="sm" fullWidth>
                        <CheckCircle2 className="h-4 w-4" />
                        直接標記全班完成
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-500">製作中：還有 {incompleteStudents.length} 位學生缺照片。</p>
                )
              )}
              {workStage === 2 && (
                canEditCurrentProject ? (
                  <>
                    <Button onClick={handleCompleteProject} disabled={isBatchRendering} variant="success" fullWidth>
                      <CheckCircle2 className="h-4 w-4" />
                      全班完成
                    </Button>
                    <p className="text-xs leading-relaxed text-gray-400">
                      照片已備齊。標記完成後內容鎖定，需主管或管理員退回才能修改。
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-500">照片已備齊，待老師標記全班完成。</p>
                )
              )}
              {workStage === 3 && (
                <>
                  <p className="text-sm font-medium text-emerald-700">
                    ✓ 已標記全班完成，內容鎖定{canEditCurrentProject ? "；請下載交件。" : "。"}
                  </p>
                  {canReopenProject && (
                    <Button onClick={handleReopenProject} variant="neutral" size="sm" fullWidth>
                      <RotateCcw className="h-4 w-4" />
                      退回修改
                    </Button>
                  )}
                </>
              )}

              {/* 交件下載：照片備齊（階段 2）才出現；下載前要先渲染，
                  渲染只有 owner/admin 有權限，唯讀角色（美編、非轄下主管）點了必 403，直接不顯示 */}
              {workStage >= 2 && canEditCurrentProject && (
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <Button
                      onClick={handleDownloadAll}
                      disabled={isBatchRendering}
                      data-guide="review-download-all"
                      variant={workStage === 3 ? "success" : "neutral"}
                      size="sm"
                      className="flex-1"
                    >
                      {renderingAll ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {renderAllProgress ? `${renderAllProgress.current}/${renderAllProgress.total}` : "產生中..."}
                        </>
                      ) : (
                        <><Package className="h-4 w-4" />PDF ZIP</>
                      )}
                    </Button>
                    <Button
                      onClick={handleDownloadAllImages}
                      disabled={isBatchRendering}
                      variant={workStage === 3 ? "info" : "neutral"}
                      size="sm"
                      className="flex-1"
                    >
                      {renderingAllImages ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {renderAllImagesProgress ? `${renderAllImagesProgress.current}/${renderAllImagesProgress.total}` : "產生中..."}
                        </>
                      ) : (
                        <><ImageDown className="h-4 w-4" />{isAllImagesShareReady ? "開始分享" : "全部圖片"}</>
                      )}
                    </Button>
                  </div>
                  {/* 畫質只影響下載，跟著交件動作走（僅 admin） */}
                  {canDownloadPrint && (
                    <SegmentedControl
                      value={outputMode}
                      onChange={setOutputMode}
                      size="sm"
                      options={[
                        { value: "print", label: "列印畫質", icon: Printer },
                        { value: "screen", label: "螢幕畫質", icon: Monitor },
                      ]}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </Surface>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
          onClick={() => setPreview(null)}
        >
          <Surface
            ref={previewDialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="學生頁面預覽"
            padding="none"
            variant="dialog"
            className="max-w-md w-full overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center px-5 py-4 border-b border-gray-100">
              <div>
                <div className="font-semibold text-gray-900">
                  {project.students.find(s => s.id === preview.studentId)?.name}
                </div>
                <div className="text-xs text-gray-400">第 {preview.pageIndex + 1} 頁預覽</div>
              </div>
              <IconButton
                label="關閉預覽"
                onClick={() => setPreview(null)}
                size="md"
              >
                ✕
              </IconButton>
            </div>
            <img
              src={appendPreviewCacheVersion(
                previewUrl(id, preview.studentId, preview.pageIndex),
                ts,
                project.template_revision,
              )}
              alt="preview"
              className="w-full"
            />
            {pageCount > 1 && (() => {
              const previewStudent = project.students.find(s => s.id === preview.studentId);
              const visiblePages = getVisiblePageIndexes(previewStudent);
              return visiblePages.length > 1 ? (
                <div className="flex justify-center gap-2 p-3 border-t border-gray-100">
                  {visiblePages.map(i => (
                    <button
                      key={i}
                      onClick={() => setPreview(p => ({ ...p, pageIndex: i }))}
                      className={`h-8 w-8 rounded-lg text-xs font-medium transition-colors ${
                        preview.pageIndex === i
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
          </Surface>
        </div>
      )}

      {/* 學生區標題列：標題＋人數＋搜尋＋篩選；手機版搜尋與篩選各佔滿一列 */}
      {project.students.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-gray-800">學生</h2>
          <Badge tone="neutral">{project.students.length} 位</Badge>
          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <label className="relative w-full sm:w-52" data-guide="review-student-search">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-300" />
              <input
                type="search"
                value={studentSearch}
                onChange={(event) => setStudentSearch(event.target.value)}
                placeholder="搜尋學生"
                className={`${fieldControlClass} w-full pl-9`}
              />
            </label>
            <div className="w-full sm:w-auto" data-guide="review-status-filter">
              <SegmentedControl
                value={studentStatusFilter}
                onChange={setStudentStatusFilter}
                size="sm"
                className="w-full"
                options={reviewStatusFilterOptions}
              />
            </div>
          </div>
        </div>
      )}

      {/* Students grid */}
      {project.students.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <Users className="mx-auto mb-3 h-10 w-10 opacity-30" />
          <p className="text-sm">尚無學生</p>
          {canEditCurrentProject ? (
            <Button
              type="button"
              onClick={() => setIsRosterOpen(true)}
              variant="primary"
              className="mt-4"
            >
              <Users className="h-4 w-4" />
              新增學生名單
            </Button>
          ) : (
            <p className="mt-1 text-xs">待老師新增學生名單</p>
          )}
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
              projectId={id}
              pageCount={pageCount}
              ts={ts}
              templateRevision={project.template_revision}
              canEditCurrentProject={canEditCurrentProject}
              photoProgress={photoProgressByStudentId.get(student.id)}
              isRendering={rendering[student.id]}
              isImageRendering={renderingImages[student.id]}
              isImageShareReady={isMobileDevice() && imageShareDrafts[student.id]?.files?.length > 0}
              getVisiblePageIndexes={getVisiblePageIndexes}
              onPreview={(studentId, pageIndex) => setPreview({ studentId, pageIndex })}
              onDownloadPdf={handleDownloadOne}
              onDownloadImages={handleDownloadOneImages}
            />
          ))}
        </div>
      )}

      {/* 審閱留言區（admin / 美學組 / 主管可新增；老師可讀取） */}
      {(canComment || currentUser?.role === "teacher") && (
        <ReviewCommentsPanel
          comments={comments}
          canComment={canComment}
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
        onConfirm={async () => { await confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />

      <RosterModal
        isOpen={isRosterOpen}
        onClose={() => setIsRosterOpen(false)}
        projectId={id}
        students={project.students}
        photoProgressByStudentId={photoProgressByStudentId}
        // 改名後名字渲染在縮圖裡，重載完要 bust 預覽快取
        onChanged={loadProject}
        // 後端對 admin 不鎖內容，前端一致：admin 在鎖定後仍可管理名單
        isLocked={isProjectCompleted && !isAdmin}
      />
    </div>
  );
}
