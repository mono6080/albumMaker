import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { fetchProject as getProject, renderStudent, renderAllStudents as renderAll } from "../api/projectApi";
import { fetchTemplate as getTemplate } from "../api/templateApi";
import { buildStudentPagePreviewUrl as previewUrl, buildDownloadPdfUrl as downloadPdf, buildDownloadAllZipUrl as downloadAllZip } from "../api/urls";
import { apiClient } from "../api/authApi";
import { useAuth } from "../context/AuthContext";
import { usePermissions } from "../hooks/usePermissions";
import {
  ChevronRight, Download, Loader2, Eye, Pencil, Package,
  CheckCircle2, Clock, Printer, Monitor, MessageCircle, Send, Trash2,
} from "lucide-react";

export default function ProjectReview() {
  const { id } = useParams();
  const { canDownloadPrint, canComment, isAdmin } = usePermissions();
  const { currentUser } = useAuth();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [rendering, setRendering] = useState({});
  const [renderingAll, setRenderingAll] = useState(false);
  // { current: number, total: number } | null
  const [renderAllProgress, setRenderAllProgress] = useState(null);
  const [preview, setPreview] = useState(null);
  const [ts, setTs] = useState(Date.now());
  // 非 admin 固定使用 screen 模式
  const [outputMode, setOutputMode] = useState("print");

  // ── 留言 ──────────────────────────────────────────────────────────────────
  const [comments, setComments] = useState([]);
  const [newCommentText, setNewCommentText] = useState("");
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  const loadProject = async () => {
    const projectResponse = await getProject(id);
    setProject(projectResponse.data);
    const templateResponse = await getTemplate(projectResponse.data.template_id);
    setTemplate(templateResponse.data);
  };

  const loadComments = async () => {
    try {
      const response = await apiClient.get(`/projects/${id}/comments`);
      setComments(response.data);
    } catch { /* 靜默，留言非關鍵功能 */ }
  };

  useEffect(() => {
    loadProject();
    loadComments();
  }, [id]);

  /** 透過 apiClient 下載 blob 並觸發瀏覽器儲存，確保 Bearer token 隨請求傳送 */
  const triggerBlobDownload = async (url, fallbackFilename) => {
    // urls.js 回傳的路徑已含 /api 前綴；apiClient.baseURL 也是 /api，需去掉重複的前綴
    const apiPath = url.startsWith("/api") ? url.slice(4) : url;
    const response = await apiClient.get(apiPath, { responseType: "blob" });
    const disposition = response.headers["content-disposition"] ?? "";
    // 嘗試從 filename*=UTF-8'' 或 filename= 讀取檔名
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = disposition.match(/filename="([^"]+)"/i);
    const filename = utf8Match
      ? decodeURIComponent(utf8Match[1])
      : asciiMatch
        ? asciiMatch[1]
        : fallbackFilename;
    const blobUrl = URL.createObjectURL(response.data);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
  };

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
      await triggerBlobDownload(
        downloadPdf(id, studentId, effectiveMode),
        "album.pdf",
      );
    } catch { showRetryToast("產生失敗", () => handleDownloadOne(studentId)); }
    setRendering(prev => ({ ...prev, [studentId]: false }));
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
      await triggerBlobDownload(
        downloadAllZip(id, effectiveMode),
        "albums.zip",
      );
    } catch { showRetryToast("批次產生失敗", handleDownloadAll); }
    setRenderingAll(false);
    setRenderAllProgress(null);
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

  if (!project || !template) return (
    <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
  );

  const pageCount = template.pages.length;
  const doneCount = project.students.filter(s => s.output_filename).length;

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
            onClick={handleDownloadAll}
            disabled={renderingAll || project.students.length === 0}
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
              : <><Package className="w-4 h-4" /><span>下載全部 ZIP</span></>
            }
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {project.students.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 mb-6 shadow-sm">
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
              const previewSkipped = new Set(
                (previewStudent?.pages_data || []).filter(p => p.skip).map(p => p.page_index)
              );
              const visiblePages = Array.from({ length: pageCount }, (_, i) => i).filter(i => !previewSkipped.has(i));
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
            const studentSkippedPages = new Set(
              (student.pages_data || []).filter(p => p.skip).map(p => p.page_index)
            );
            return (
              <div
                key={student.id}
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
                          ? <><CheckCircle2 className="w-3 h-3" />已產生 PDF</>
                          : <><Clock className="w-3 h-3" />尚未產生</>
                        }
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Link
                      to={`/projects/${id}/students/${student.id}/edit`}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                      編輯
                    </Link>
                    <button
                      onClick={() => setPreview({ studentId: student.id, pageIndex: 0 })}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      <Eye className="w-3 h-3" />
                      預覽
                    </button>
                    <button
                      onClick={() => handleDownloadOne(student.id)}
                      disabled={isStudentRendering}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 disabled:opacity-40 transition-colors ml-auto"
                    >
                      {isStudentRendering
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Download className="w-3 h-3" />
                      }
                      {isStudentRendering ? "產生中..." : "下載"}
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
        <div className="mt-8 bg-white border border-gray-200 rounded-2xl shadow-sm p-5">
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
