// 學生個人編輯頁面
// 提供單一學生的照片上傳、氣泡文字編輯與即時預覽，
// 文字變更後自動防抖儲存（500ms）

import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { fetchProject, renderStudent, batchUpdateStudentTexts } from "../api/projectApi";
import { fetchTemplate } from "../api/templateApi";
import { buildDownloadPdfUrl, buildStudentPagePreviewUrl } from "../api/urls";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  ChevronRight, ChevronLeft, RefreshCw, Download,
  Loader2, MessageCircle,
} from "lucide-react";
import PhotoManager from "../components/PhotoManager";
import PanelSwitcher from "../components/PanelSwitcher";
import AlbumPageNav from "../components/AlbumPageNav";

// ── 頁面預覽子元件 ────────────────────────────────────────────────────────────

/**
 * 單頁渲染預覽圖，依 timestamp 更新觸發重新載入。
 */
function PagePreview({ projectId, studentId, pageIndex, timestamp }) {
  const [isLoaded, setIsLoaded] = useState(false);

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ aspectRatio: "794 / 1123" }}
    >
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
        </div>
      )}
      <img
        key={timestamp}
        src={`${buildStudentPagePreviewUrl(projectId, studentId, pageIndex)}?t=${timestamp}`}
        alt={`第 ${pageIndex + 1} 頁`}
        className="w-full h-full object-cover"
        onLoad={() => setIsLoaded(true)}
        onError={() => setIsLoaded(true)}
      />
    </div>
  );
}

// ── 主頁面元件 ────────────────────────────────────────────────────────────────

export default function StudentEdit() {
  const { projectId, studentId } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [student, setStudent] = useState(null);
  const [projectBubbleTexts, setProjectBubbleTexts] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [activePage, setActivePage] = useState(0);
  const [bubbleTexts, setBubbleTexts] = useState({});  // { [pageIndex]: { [bubbleId]: text } }
  const [isRendering, setIsRendering] = useState(false);
  const [previewTimestamp, setPreviewTimestamp] = useState(Date.now());
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"

  // ── 自動儲存氣泡文字（防抖 500ms） ────────────────────────────────────────

  const { scheduleSave, flushSave } = useAutoSave(
    bubbleTexts,
    async (currentBubbleTexts) => {
      // 將 { [pageIndex]: { [bubbleId]: text } } 轉換為 API payload 格式
      const payload = {};
      Object.entries(currentBubbleTexts).forEach(([pageIndex, bubbles]) => {
        payload[pageIndex] = bubbles;
      });
      try {
        await batchUpdateStudentTexts(projectId, { students: { [studentId]: payload } });
        setPreviewTimestamp(Date.now());
      } catch { /* 靜默失敗，不打擾使用者 */ }
    },
    500
  );

  // 每次 bubbleTexts 變更且已載入學生資料時，排程自動儲存
  useEffect(() => {
    if (!student) return;
    scheduleSave();
  }, [bubbleTexts]);

  // ── 資料載入 ──────────────────────────────────────────────────────────────

  const loadStudentData = async () => {
    try {
      const projectResponse = await fetchProject(projectId);
      setProject(projectResponse.data);

      const foundStudent = projectResponse.data.students.find(
        (studentRecord) => studentRecord.id === Number(studentId)
      );
      if (!foundStudent) {
        setLoadError("找不到該學生");
        return;
      }
      setStudent(foundStudent);
      setProjectBubbleTexts(projectResponse.data.bubble_texts || {});

      const templateResponse = await fetchTemplate(projectResponse.data.template_id);
      setTemplate(templateResponse.data);

      // 初始化氣泡文字狀態（從學生頁面資料讀取）
      const initialTexts = {};
      (foundStudent?.pages_data || []).forEach(pageData => {
        initialTexts[pageData.page_index] = pageData.bubble_texts || {};
      });
      setBubbleTexts(initialTexts);
    } catch {
      setLoadError("找不到專案或學生");
    }
  };

  useEffect(() => { loadStudentData(); }, [projectId, studentId]);

  // ── 氣泡文字操作 ──────────────────────────────────────────────────────────

  const getBubbleText = (pageIndex, bubbleId) =>
    bubbleTexts[pageIndex]?.[String(bubbleId)] ?? "";

  const setBubbleText = (pageIndex, bubbleId, textValue) => {
    setBubbleTexts(prevTexts => ({
      ...prevTexts,
      [pageIndex]: { ...(prevTexts[pageIndex] || {}), [String(bubbleId)]: textValue },
    }));
  };

  const refreshPreview = () => setPreviewTimestamp(Date.now());

  // ── 渲染（含前置強制儲存） ────────────────────────────────────────────────

  const handleRenderPdf = async () => {
    // 先強制同步儲存，確保渲染使用最新文字
    await flushSave();

    setIsRendering(true);
    try {
      await renderStudent(projectId, studentId);
      toast.success("PDF 已產生");
      await loadStudentData();
      refreshPreview();
    } catch {
      toast.error("產生失敗");
    }
    setIsRendering(false);
  };

  // ── 載入中 / 錯誤狀態 ─────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-500 font-medium">{loadError}</p>
        <Link to="/projects" className="text-sm text-indigo-600 hover:underline">
          ← 返回專案列表
        </Link>
      </div>
    );
  }

  if (!project || !template || !student) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
    );
  }

  const templatePages = template.pages;
  const pageCount = templatePages.length;
  const activePageLayout = templatePages[activePage]?.layout;

  // ── 共用面板內容 ──────────────────────────────────────────────────────────

  const previewPanel = (
    <div className="space-y-3">
      <AlbumPageNav page={activePage} total={pageCount} onChange={setActivePage} />
      <PagePreview
        projectId={projectId}
        studentId={studentId}
        pageIndex={activePage}
        timestamp={previewTimestamp}
      />
      <div className="flex justify-center">
        <button
          onClick={refreshPreview}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 py-1.5 px-3 rounded-lg hover:bg-gray-100 transition-colors"
        >
          <RefreshCw className="w-3 h-3" />重新整理預覽
        </button>
      </div>
    </div>
  );

  const photoPanel = (
    <PhotoManager
      projectId={projectId}
      studentId={studentId}
      pages={templatePages}
      student={student}
      onPhotoSaved={() => setPreviewTimestamp(Date.now())}
      onSaved={() => { loadStudentData(); setPreviewTimestamp(Date.now()); }}
    />
  );

  const textPanel = (
    <div className="space-y-4">
      <AlbumPageNav page={activePage} total={pageCount} onChange={setActivePage} />
      {activePageLayout?.text_bubbles?.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle className="w-4 h-4 text-violet-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              第 {activePage + 1} 頁氣泡文字
            </h3>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">
              ({"{name}"} 自動代入姓名)
            </span>
          </div>
          <div className="space-y-3">
            {activePageLayout.text_bubbles.map(bubble => {
              const rawDefaultText =
                projectBubbleTexts[String(activePage)]?.[String(bubble.id)] ?? bubble.text ?? "";
              const displayDefaultText = rawDefaultText.replace("{name}", student.name);
              return (
                <div key={bubble.id} className="flex gap-3">
                  <div
                    className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-1 text-xs font-bold"
                    style={{ background: bubble.fill + "60", color: bubble.font_color || "#555" }}
                  >
                    {bubble.id}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-gray-400 mb-1">
                      預設：{displayDefaultText.substring(0, 25)}
                    </div>
                    <textarea
                      rows={2}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                      placeholder={displayDefaultText}
                      value={getBubbleText(activePage, bubble.id)}
                      onChange={event => setBubbleText(activePage, bubble.id, event.target.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 text-gray-300 text-sm">此頁沒有氣泡文字</div>
      )}
    </div>
  );

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      {/* 麵包屑導覽列 + 動作按鈕 */}
      <div className="flex flex-wrap items-center gap-2 mb-4 sm:mb-6 text-sm">
        <Link
          to="/projects"
          className="text-gray-400 hover:text-gray-600 transition-colors hidden sm:inline"
        >
          相本專案
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />
        <Link
          to={`/projects/${projectId}/review`}
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5 inline sm:hidden" />
          <span>{project.name}</span>
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />
        <span className="font-semibold text-gray-900">{student.name}</span>
        <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">個別編輯</span>

        <div className="ml-auto flex gap-2">
          <button
            onClick={handleRenderPdf}
            disabled={isRendering}
            className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 transition-colors shadow-sm"
          >
            {isRendering
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <RefreshCw className="w-4 h-4" />}
            <span className="hidden sm:inline">{isRendering ? "產生中..." : "產生 PDF"}</span>
            <span className="sm:hidden">{isRendering ? "..." : "PDF"}</span>
          </button>

          {student.output_filename && (
            <a
              href={buildDownloadPdfUrl(projectId, studentId)}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-700 px-3 py-2 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">下載</span>
            </a>
          )}
        </div>
      </div>

      {/* 行動裝置分頁切換 */}
      <PanelSwitcher
        value={mobileTab}
        onChange={setMobileTab}
        tabs={[
          { value: "photo",   label: "📷 照片" },
          { value: "text",    label: "💬 文字" },
          { value: "preview", label: "👁 預覽" },
        ]}
      />

      {/* 桌面版：左側預覽 | 右側照片 + 文字；行動版：單頁面板切換 */}
      <div className="lg:flex lg:gap-6 lg:items-start">
        {/* 預覽面板 */}
        <div className={`lg:block lg:flex-shrink-0 lg:w-1/3 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`}>
          {previewPanel}
        </div>

        {/* 照片面板 + 桌面版文字面板 */}
        <div className={`lg:block lg:flex-1 lg:min-w-0 ${mobileTab === "photo" ? "block" : "hidden lg:block"} lg:space-y-6`}>
          {photoPanel}
          <div className="hidden lg:block">
            {textPanel}
          </div>
        </div>

        {/* 行動版文字面板（獨立顯示） */}
        <div className={`lg:hidden ${mobileTab === "text" ? "block" : "hidden"} w-full`}>
          {textPanel}
        </div>
      </div>
    </div>
  );
}
