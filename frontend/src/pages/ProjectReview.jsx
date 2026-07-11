import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { completeProject, fetchProject as getProject, renderStudent, reopenProject } from "../api/projectApi";
import { fetchTemplate as getTemplate } from "../api/templateApi";
import {
  buildStudentPagePreviewUrl as previewUrl,
  buildDownloadPdfUrl as downloadPdf,
  buildDownloadImagesZipUrl as downloadImagesZip,
  buildDownloadAllZipUrl as downloadAllZip,
  buildDownloadAllImagesZipUrl as downloadAllImagesZip,
} from "../api/urls";
import { apiClient, renderClient } from "../api/authApi";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
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
  ChevronRight, CircleHelp, Download, ImageDown, Loader2, Pencil, Package,
  CheckCircle2, Clock, Printer, Monitor, MessageCircle, Send, Trash2, ImageOff,
  RotateCcw, Search, Users,
} from "lucide-react";
import { startProductGuide } from "../utils/productGuide";
import { showRetryToast } from "../utils/retryToast";
import { computeStudentPhotoProgress } from "../utils/photoProgress";
import ConfirmModal from "../components/ConfirmModal";
import RosterModal from "../components/RosterModal";
import {
  createFileFromBlob,
  downloadApiBlob,
  fetchApiBlob,
  getShareFailureMessage,
  isMobileDevice,
  shareFiles,
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

const REVIEW_PREVIEW_CONCURRENCY = 2;
const REVIEW_PREVIEW_MAX_RETRIES = 4;
let activeReviewPreviewLoads = 0;
const queuedReviewPreviewLoads = [];

function pumpReviewPreviewQueue() {
  while (activeReviewPreviewLoads < REVIEW_PREVIEW_CONCURRENCY && queuedReviewPreviewLoads.length > 0) {
    const task = queuedReviewPreviewLoads.shift();
    if (!task || task.cancelled) continue;

    task.started = true;
    activeReviewPreviewLoads += 1;
    task.start(() => {
      if (task.released) return;
      task.released = true;
      activeReviewPreviewLoads = Math.max(0, activeReviewPreviewLoads - 1);
      pumpReviewPreviewQueue();
    });
  }
}

function enqueueReviewPreviewLoad(start) {
  const task = {
    cancelled: false,
    released: false,
    started: false,
    start,
  };
  queuedReviewPreviewLoads.push(task);
  pumpReviewPreviewQueue();

  return () => {
    if (task.released || task.cancelled) return;
    task.cancelled = true;

    if (!task.started) {
      const taskIndex = queuedReviewPreviewLoads.indexOf(task);
      if (taskIndex >= 0) queuedReviewPreviewLoads.splice(taskIndex, 1);
      return;
    }

    task.released = true;
    activeReviewPreviewLoads = Math.max(0, activeReviewPreviewLoads - 1);
    pumpReviewPreviewQueue();
  };
}

function withPreviewRetryParam(src, retryIndex) {
  if (retryIndex <= 0) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}retry=${retryIndex}`;
}

function ReviewPreviewImage({ src, alt, className }) {
  const containerRef = useRef(null);
  const releaseLoadSlotRef = useRef(null);
  const retryTimerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loadSrc, setLoadSrc] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [retryIndex, setRetryIndex] = useState(0);
  const [hasLoadError, setHasLoadError] = useState(false);

  useEffect(() => {
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setLoadSrc("");
    setIsLoaded(false);
    setRetryIndex(0);
    setHasLoadError(false);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  }, [src]);

  useEffect(() => () => {
    window.clearTimeout(retryTimerRef.current);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        setIsVisible(true);
        observer.disconnect();
      },
      { rootMargin: "360px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || isLoaded || hasLoadError) return undefined;
    return enqueueReviewPreviewLoad(release => {
      releaseLoadSlotRef.current = release;
      setLoadSrc(withPreviewRetryParam(src, retryIndex));
    });
  }, [hasLoadError, isLoaded, isVisible, retryIndex, src]);

  const handleLoaded = () => {
    setIsLoaded(true);
    setHasLoadError(false);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  };

  const handleLoadFailed = () => {
    setLoadSrc("");
    setIsLoaded(false);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;

    if (retryIndex >= REVIEW_PREVIEW_MAX_RETRIES) {
      setHasLoadError(true);
      return;
    }

    const retryDelay = Math.min(1000 * (2 ** retryIndex), 5000);
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryIndex(current => current + 1);
    }, retryDelay);
  };

  return (
    <div ref={containerRef} className="relative h-24 w-full bg-gray-100">
      {loadSrc && (
        <img
          src={loadSrc}
          alt={alt}
          className={`${className} ${isLoaded ? "opacity-100" : "opacity-0"}`}
          onLoad={handleLoaded}
          onError={handleLoadFailed}
        />
      )}
      {!isLoaded && !hasLoadError && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        </div>
      )}
      {hasLoadError && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300">
          <ImageOff className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

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
  const [imageShareDrafts, setImageShareDrafts] = useState({});
  const [allImagesShareDraft, setAllImagesShareDraft] = useState(null);
  const [ts, setTs] = useState(() => Date.now());
  // 非 admin 固定使用 screen 模式
  const [outputMode, setOutputMode] = useState("print");
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
      const projectResponse = await getProject(id);
      setProject(projectResponse.data);
      const templateResponse = await getTemplate(projectResponse.data.template_id);
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
      setTs(Date.now());
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
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
          `${previewUrl(id, studentRecord.id, pageIndex)}?t=${requestTs}`,
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
      setTs(Date.now());
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
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

  const handleDownloadAll = async () => {
    const students = project.students;
    if (!students.length) return;
    setRenderingAll(true);
    setRenderAllProgress({ current: 0, total: students.length });
    try {
      for (let i = 0; i < students.length; i++) {
        setRenderAllProgress({ current: i + 1, total: students.length });
        await renderStudent(id, students[i].id);
      }
      await loadProject();
      setTs(Date.now());
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
      await downloadApiBlob(
        renderClient,
        downloadAllZip(id, effectiveMode),
        "albums.zip",
      );
    } catch { showRetryToast("批次產生失敗", handleDownloadAll); }
    setRenderingAll(false);
    setRenderAllProgress(null);
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

      for (let i = 0; i < students.length; i++) {
        setRenderAllImagesProgress({ current: i + 1, total: students.length });
        await renderStudent(id, students[i].id);
      }
      await loadProject();
      setTs(Date.now());
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
      await downloadApiBlob(
        renderClient,
        downloadAllImagesZip(id, effectiveMode),
        "album-images.zip",
      );
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
          <div className="flex gap-2">
            {/* 名單是工作台上的資料，用 Modal 管理，不再是獨立頁面 */}
            {canEditCurrentProject && (
              <Button
                type="button"
                onClick={() => setIsRosterOpen(true)}
                data-guide="review-roster-button"
                variant="secondary"
                size="touch"
              >
                <Users className="w-4 h-4" />
                <span className="hidden sm:inline">學生名單</span>
                <span className="sm:hidden">名單</span>
              </Button>
            )}
            <Button type="button" onClick={startGuide} variant="secondary" size="touch">
              <CircleHelp className="w-4 h-4" />
              <span className="hidden sm:inline">製作教學</span>
              <span className="sm:hidden">教學</span>
            </Button>
          </div>
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
              src={`${previewUrl(id, preview.studentId, preview.pageIndex)}?t=${ts}`}
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
          {visibleStudents.map(student => {
            const photoProgress = photoProgressByStudentId.get(student.id);
            const isStudentPhotoComplete = photoProgress.total === 0 || photoProgress.filled === photoProgress.total;
            const isStudentRendering = rendering[student.id];
            const isStudentImageRendering = renderingImages[student.id];
            const isStudentImageShareReady = isMobileDevice() && imageShareDrafts[student.id]?.files?.length > 0;
            const isStudentBusy = isStudentRendering || isStudentImageRendering;
            const studentSkippedPages = new Set(
              (student.pages_data || []).filter(p => p.skip).map(p => p.page_index)
            );
            return (
              <Surface
                key={student.id}
                data-guide="review-student-card"
                style={{ contentVisibility: "auto", containIntrinsicSize: "0 420px" }}
                padding="none"
                className={`overflow-hidden transition-all hover:shadow-md ${
                  isStudentPhotoComplete ? "border-emerald-100" : "border-gray-200"
                }`}
              >
                {/* Thumbnail strip — 跳過已刪除的頁面；點縮圖即預覽 */}
                <div data-guide="review-preview-student" className="flex gap-1 p-3 bg-gray-50 border-b border-gray-100 overflow-x-auto">
                  {Array.from({ length: pageCount }, (_, i) => {
                    if (studentSkippedPages.has(i)) return null;
                    return (
                      <button
                        key={i}
                        onClick={() => setPreview({ studentId: student.id, pageIndex: i })}
                        className="flex-shrink-0 w-20 rounded-lg overflow-hidden border border-gray-200 hover:border-indigo-400 hover:shadow-sm transition-all group"
                      >
                        <ReviewPreviewImage
                          src={`${previewUrl(id, student.id, i)}?t=${ts}`}
                          alt={`p${i + 1}`}
                          className="w-full h-24 object-cover"
                        />
                        <div className="text-center text-xs text-gray-400 py-0.5 group-hover:text-indigo-500">
                          第 {i + 1} 頁
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Student info：主要區可點（老師→編輯；其他角色→預覽），動作收成右側小 icon */}
                <div className="flex items-center gap-2 p-4">
                  {canEditCurrentProject ? (
                    <Link
                      to={`/projects/${id}/students/${student.id}/edit`}
                      className="group/main min-w-0 flex-1"
                    >
                      <div className="truncate font-semibold text-gray-900 transition-colors group-hover/main:text-indigo-700">
                        {student.name}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        {photoProgress.total > 0 && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
                            photoProgress.filled === photoProgress.total
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}>
                            {photoProgress.filled === photoProgress.total
                              ? "✓ 照片齊"
                              : `照片 ${photoProgress.filled}/${photoProgress.total}`}
                          </span>
                        )}
                      </div>
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPreview({ studentId: student.id, pageIndex: getVisiblePageIndexes(student)[0] ?? 0 })}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate font-semibold text-gray-900">{student.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        {photoProgress.total > 0 && (
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
                            photoProgress.filled === photoProgress.total
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}>
                            {photoProgress.filled === photoProgress.total
                              ? "✓ 照片齊"
                              : `照片 ${photoProgress.filled}/${photoProgress.total}`}
                          </span>
                        )}
                      </div>
                    </button>
                  )}
                  <div className="flex flex-shrink-0 items-center gap-0.5">
                    {canEditCurrentProject && (
                      <Link
                        to={`/projects/${id}/students/${student.id}/edit`}
                        aria-label="編輯"
                        title="編輯"
                        data-guide="review-edit-student"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-indigo-500 transition-colors hover:bg-indigo-50 hover:text-indigo-700"
                      >
                        <Pencil className="h-4 w-4" />
                      </Link>
                    )}
                    {/* 下載前要先渲染（owner/admin 限定），唯讀角色點了必 403，直接不顯示 */}
                    {canEditCurrentProject && (
                      <>
                        <IconButton
                          label={isStudentRendering ? "PDF 產生中" : "下載 PDF"}
                          onClick={() => handleDownloadOne(student.id)}
                          disabled={isStudentBusy}
                          data-guide="review-download-student"
                          variant="success"
                        >
                          {isStudentRendering
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Download className="h-4 w-4" />}
                        </IconButton>
                        <IconButton
                          label={isStudentImageShareReady ? "開始分享圖片" : "下載圖片"}
                          onClick={() => handleDownloadOneImages(student.id)}
                          disabled={isStudentBusy}
                          variant="info"
                        >
                          {isStudentImageRendering
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <ImageDown className="h-4 w-4" />}
                        </IconButton>
                      </>
                    )}
                  </div>
                </div>
              </Surface>
            );
          })}
        </div>
      )}

      {/* 審閱留言區（admin / 美學組 / 主管可新增；老師可讀取） */}
      {(canComment || currentUser?.role === "teacher") && (
        <Surface id="review-comments" className="mt-8 scroll-mt-20" data-guide="review-comments">
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle className="w-4 h-4 text-violet-500" />
            <h3 className="font-semibold text-gray-800 text-sm">審閱意見</h3>
            {comments.length > 0 && (
              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{comments.length}</span>
            )}
          </div>

          {/* 留言清單 */}
          {comments.length === 0 ? (
            <p className="text-sm text-gray-300 text-center py-4">尚無意見</p>
          ) : (
            <div className="space-y-3 mb-4">
              {comments.map((comment) => (
                <div key={comment.id} className="flex gap-3">
                  <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-xs font-bold text-violet-600 flex-shrink-0">
                    {comment.author_name?.[0] ?? "?"}
                  </div>
                  <div className="flex-1 bg-gray-50 rounded-xl px-3 py-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700">{comment.author_name}</span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-300">
                          {new Date(comment.created_at).toLocaleString("zh-TW", {
                            month: "numeric", day: "numeric",
                            hour: "2-digit", minute: "2-digit",
                          })}
                        </span>
                        {/* 後端允許 admin 或作者本人刪除，前端一致 */}
                        {(isAdmin || comment.author_id === currentUser?.id) && (
                          <IconButton
                            label="刪除留言"
                            onClick={() => handleDeleteComment(comment.id)}
                            variant="danger"
                            size="xs"
                          >
                            <Trash2 className="w-3 h-3" />
                          </IconButton>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.content}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 新增留言（老師唯讀，不顯示輸入區） */}
          {canComment && (
            <>
              <div className="flex gap-2 min-w-0">
                <textarea
                  rows={2}
                  value={newCommentText}
                  onChange={(e) => setNewCommentText(e.target.value)}
                  placeholder="輸入審閱意見..."
                  className={`${fieldControlClass} flex-1 resize-none`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmitComment();
                  }}
                />
                <Button
                  onClick={handleSubmitComment}
                  disabled={isSubmittingComment || !newCommentText.trim()}
                  variant="primary"
                  className="self-end"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">送出</span>
                </Button>
              </div>
              <p className="text-xs text-gray-300 mt-1.5">Ctrl+Enter 快速送出</p>
            </>
          )}
        </Surface>
      )}

      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        confirmLabel={confirmModal?.confirmLabel}
        confirmVariant={confirmModal?.confirmVariant}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />

      <RosterModal
        isOpen={isRosterOpen}
        onClose={() => setIsRosterOpen(false)}
        projectId={id}
        students={project.students}
        photoProgressByStudentId={photoProgressByStudentId}
        // 改名後名字渲染在縮圖裡，重載完要 bust 預覽快取
        onChanged={async () => { await loadProject(); setTs(Date.now()); }}
        // 後端對 admin 不鎖內容，前端一致：admin 在鎖定後仍可管理名單
        isLocked={isProjectCompleted && !isAdmin}
      />
    </div>
  );
}
