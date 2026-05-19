import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { fetchProject as getProject, renderStudent } from "../api/projectApi";
import { fetchTemplate as getTemplate } from "../api/templateApi";
import {
  buildStudentPagePreviewUrl as previewUrl,
  buildDownloadPdfUrl as downloadPdf,
  buildDownloadImagesZipUrl as downloadImagesZip,
  buildDownloadAllZipUrl as downloadAllZip,
  buildDownloadAllImagesZipUrl as downloadAllImagesZip,
} from "../api/urls";
import { apiClient } from "../api/authApi";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import {
  ChevronRight, CircleHelp, Download, ImageDown, Loader2, Eye, Pencil, Package,
  CheckCircle2, Clock, Printer, Monitor, MessageCircle, Send, Trash2,
} from "lucide-react";
import { startProductGuide } from "../utils/productGuide";
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
    title: "輸出進度",
    description: "這裡會顯示已產生 PDF 的學生數，方便確認還有誰沒完成。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="review-student-card"]',
    title: "學生卡片",
    description: "每張卡片是一位學生，可看縮圖、進入編輯、預覽或下載。",
    side: "top",
    align: "start",
  },
  {
    element: '[data-guide="review-edit-student"]',
    title: "編輯學生",
    description: "進入個人編輯頁，上傳照片、覆寫文字並確認預覽。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="review-preview-student"]',
    title: "快速預覽",
    description: "不進入編輯頁也能快速打開此學生的頁面預覽。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="review-download-student"]',
    title: "下載單位學生",
    description: "只產出並下載這位學生的 PDF；圖片按鈕在電腦下載 ZIP，手機開啟分享。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="review-download-all"]',
    title: "下載全部 ZIP",
    description: "所有學生確認完成後，用這裡批次產生並下載 PDF ZIP；全部圖片在電腦下載 ZIP，手機開啟分享。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="review-comments"]',
    title: "審閱意見",
    description: "老師可以在這裡查看主管或設計端留下的審閱意見。",
    side: "top",
    align: "start",
  },
];

export default function ProjectReview() {
  const { id } = useParams();
  const { canDownloadPrint, canComment, isAdmin } = usePermissions();
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
  const [ts, setTs] = useState(0);
  // 非 admin 固定使用 screen 模式
  const [outputMode, setOutputMode] = useState("print");

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

  const showRetryToast = (message, onRetry) => {
    toast.custom(t => (
      <div className={`flex items-center gap-3 bg-white border border-red-200 rounded-xl shadow-lg px-4 py-3 transition-opacity ${t.visible ? "opacity-100" : "opacity-0"}`}>
        <span className="text-sm text-red-600 font-medium">{message}</span>
        <button
          onClick={() => { toast.dismiss(t.id); onRetry(); }}
          className="text-xs bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 px-2.5 py-1 rounded-lg transition-colors font-medium"
        >
          重試
        </button>
        <button
          onClick={() => toast.dismiss(t.id)}
          className="text-gray-400 hover:text-gray-600 text-xs"
        >
          ✕
        </button>
      </div>
    ), { duration: 8000 });
  };

  const handleDownloadOne = async (studentId) => {
    setRendering(prev => ({ ...prev, [studentId]: true }));
    try {
      await renderStudent(id, studentId);
      await loadProject();
      setTs(Date.now());
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
      await downloadApiBlob(
        apiClient,
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
          apiClient,
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
        const files = await buildShareImageFiles([studentRecord], Date.now());
        if (!files.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        const shareResult = await shareFiles(files, `${studentRecord.name} 相冊圖片`);
        if (shareResult === "shared") {
          toast.success("已開啟分享");
        } else if (shareResult !== "cancelled") {
          toast.error(getShareFailureMessage(shareResult));
        }
        return;
      }

      await renderStudent(id, studentId);
      await loadProject();
      setTs(Date.now());
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
      await downloadApiBlob(
        apiClient,
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
        apiClient,
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
        const files = await buildShareImageFiles(
          students,
          Date.now(),
          (current, total) => setRenderAllImagesProgress({ current, total }),
        );
        if (!files.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        const shareResult = await shareFiles(files, `${project.name} 全部圖片`);
        if (shareResult === "shared") {
          toast.success("已開啟分享");
        } else if (shareResult !== "cancelled") {
          toast.error(getShareFailureMessage(shareResult));
        }
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
        apiClient,
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

  const handleDeleteComment = async (commentId) => {
    try {
      await apiClient.delete(`/projects/${id}/comments/${commentId}`);
      await loadComments();
    } catch (error) {
      toast.error(error.response?.data?.detail || "刪除失敗");
    }
  };

  const startGuide = () => {
    startProductGuide(PROJECT_REVIEW_GUIDE_STEPS);
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
  const doneCount = project.students.filter(s => s.output_filename).length;
  const isBatchRendering = renderingAll || renderingAllImages;

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Link to="/projects" className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0">
          <ChevronRight className="w-4 h-4 rotate-180" />
        </Link>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-gray-400 text-sm hidden sm:inline flex-shrink-0">相本專案</span>
          <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block flex-shrink-0" />
          <span className="font-semibold text-gray-900 truncate">{project.name}</span>
          <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full flex-shrink-0">輸出</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          {/* 完整畫質切換：僅 admin 可見 */}
          {canDownloadPrint && (
            <div className="flex items-center bg-gray-100 rounded-xl p-0.5 text-xs font-medium flex-shrink-0">
              <button
                onClick={() => setOutputMode("print")}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg transition-colors ${
                  outputMode === "print" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <Printer className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">完整畫質</span>
              </button>
              <button
                onClick={() => setOutputMode("screen")}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg transition-colors ${
                  outputMode === "screen" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">螢幕顯示</span>
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={startGuide}
            className="flex items-center gap-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 px-3 py-2 rounded-xl text-sm font-medium hover:bg-indigo-100 transition-colors shadow-sm flex-shrink-0"
          >
            <CircleHelp className="w-4 h-4" />
            <span>製作教學</span>
          </button>
          <button
            onClick={handleDownloadAll}
            disabled={isBatchRendering || project.students.length === 0}
            data-guide="review-download-all"
            className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 transition-colors shadow-sm flex-shrink-0"
          >
            {renderingAll
              ? <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {renderAllProgress
                    ? <span>{renderAllProgress.current}/{renderAllProgress.total}</span>
                    : <span className="hidden sm:inline">產生中...</span>
                  }
                </>
              : <><Package className="w-4 h-4" /><span>PDF ZIP</span></>
            }
          </button>
          <button
            onClick={handleDownloadAllImages}
            disabled={isBatchRendering || project.students.length === 0}
            className="flex items-center gap-1.5 bg-sky-600 text-white px-3 py-2 rounded-xl text-sm font-medium hover:bg-sky-700 disabled:opacity-40 transition-colors shadow-sm flex-shrink-0"
          >
            {renderingAllImages
              ? <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {renderAllImagesProgress
                    ? <span>{renderAllImagesProgress.current}/{renderAllImagesProgress.total}</span>
                    : <span className="hidden sm:inline">產生中...</span>
                  }
                </>
              : <><ImageDown className="w-4 h-4" /><span>全部圖片</span></>
            }
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {project.students.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-6 shadow-sm" data-guide="review-progress">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-gray-600">已產生</span>
            <span className="font-medium text-gray-900">{doneCount} / {project.students.length}</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${project.students.length ? (doneCount / project.students.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
          onClick={() => setPreview(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center px-5 py-4 border-b border-gray-100">
              <div>
                <div className="font-semibold text-gray-900">
                  {project.students.find(s => s.id === preview.studentId)?.name}
                </div>
                <div className="text-xs text-gray-400">第 {preview.pageIndex + 1} 頁預覽</div>
              </div>
              <button
                onClick={() => setPreview(null)}
                className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
              >
                ✕
              </button>
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
                      className={`w-7 h-7 rounded-lg text-xs font-medium transition-colors ${
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
          </div>
        </div>
      )}

      {/* Students grid */}
      {project.students.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <p className="text-sm">尚無學生，請先在「專案設定」新增</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {project.students.map(student => {
            const isDone = !!student.output_filename;
            const isStudentRendering = rendering[student.id];
            const isStudentImageRendering = renderingImages[student.id];
            const isStudentBusy = isStudentRendering || isStudentImageRendering;
            const studentSkippedPages = new Set(
              (student.pages_data || []).filter(p => p.skip).map(p => p.page_index)
            );
            return (
              <div
                key={student.id}
                data-guide="review-student-card"
                style={{ contentVisibility: "auto", containIntrinsicSize: "0 420px" }}
                className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all hover:shadow-md ${
                  isDone ? "border-emerald-100" : "border-gray-200"
                }`}
              >
                {/* Thumbnail strip — 跳過已刪除的頁面 */}
                <div className="flex gap-1 p-3 bg-gray-50 border-b border-gray-100 overflow-x-auto">
                  {Array.from({ length: pageCount }, (_, i) => {
                    if (studentSkippedPages.has(i)) return null;
                    return (
                      <button
                        key={i}
                        onClick={() => setPreview({ studentId: student.id, pageIndex: i })}
                        className="flex-shrink-0 w-20 rounded-lg overflow-hidden border border-gray-200 hover:border-indigo-400 hover:shadow-sm transition-all group"
                      >
                        <img
                          src={`${previewUrl(id, student.id, i)}?t=${ts}`}
                          alt={`p${i + 1}`}
                          className="w-full h-24 object-cover"
                          loading="lazy"
                        />
                        <div className="text-center text-xs text-gray-400 py-0.5 group-hover:text-indigo-500">
                          第 {i + 1} 頁
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Student info */}
                <div className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="font-semibold text-gray-900">{student.name}</div>
                      <div className={`flex items-center gap-1 text-xs mt-0.5 ${isDone ? "text-emerald-600" : "text-gray-400"}`}>
                        {isDone
                          ? <><CheckCircle2 className="w-3 h-3" />已產生輸出</>
                          : <><Clock className="w-3 h-3" />尚未產生</>
                        }
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Link
                      to={`/projects/${id}/students/${student.id}/edit`}
                      data-guide="review-edit-student"
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                      編輯
                    </Link>
                    <button
                      onClick={() => setPreview({ studentId: student.id, pageIndex: 0 })}
                      data-guide="review-preview-student"
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <Eye className="w-3 h-3" />
                      預覽
                    </button>
                    <button
                      onClick={() => handleDownloadOne(student.id)}
                      disabled={isStudentBusy}
                      data-guide="review-download-student"
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 disabled:opacity-40 transition-colors ml-auto"
                    >
                      {isStudentRendering
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Download className="w-3 h-3" />
                      }
                      {isStudentRendering ? "產生中..." : "PDF"}
                    </button>
                    <button
                      onClick={() => handleDownloadOneImages(student.id)}
                      disabled={isStudentBusy}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-sky-50 text-sky-700 rounded-lg hover:bg-sky-100 disabled:opacity-40 transition-colors"
                    >
                      {isStudentImageRendering
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <ImageDown className="w-3 h-3" />
                      }
                      {isStudentImageRendering ? "產生中..." : "圖片"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 審閱留言區（admin / 美學組 / 主管可新增；老師可讀取） */}
      {(canComment || currentUser?.role === "teacher") && (
        <div className="mt-8 bg-white border border-gray-200 rounded-2xl shadow-sm p-5" data-guide="review-comments">
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
                        {isAdmin && (
                          <button
                            onClick={() => handleDeleteComment(comment.id)}
                            className="p-0.5 text-gray-200 hover:text-red-400 transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
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
              <div className="flex gap-2">
                <textarea
                  rows={2}
                  value={newCommentText}
                  onChange={(e) => setNewCommentText(e.target.value)}
                  placeholder="輸入審閱意見..."
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 bg-gray-50 resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmitComment();
                  }}
                />
                <button
                  onClick={handleSubmitComment}
                  disabled={isSubmittingComment || !newCommentText.trim()}
                  className="self-end flex items-center gap-1 bg-violet-600 text-white px-3 py-2 rounded-xl text-sm font-medium hover:bg-violet-700 disabled:opacity-40 transition-colors"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">送出</span>
                </button>
              </div>
              <p className="text-xs text-gray-300 mt-1.5">Ctrl+Enter 快速送出</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
