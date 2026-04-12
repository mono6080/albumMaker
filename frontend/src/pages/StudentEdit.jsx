import { useEffect, useState, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  getProject, getTemplate, batchUpdateTexts,
  renderStudent, downloadPdf, previewUrl
} from "../api";
import {
  ChevronRight, ChevronLeft, RefreshCw, Download,
  Loader2, MessageCircle
} from "lucide-react";
import PhotoManager from "../components/PhotoManager";
import PanelSwitcher from "../components/PanelSwitcher";
import AlbumPageNav from "../components/AlbumPageNav";

// A4 ratio: 794 × 1123
const PAGE_RATIO = 1123 / 794;

function PagePreview({ projectId, studentId, pageIndex, ts }) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ aspectRatio: "794 / 1123" }}
    >
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
        </div>
      )}
      <img
        key={ts}
        src={`${previewUrl(projectId, studentId, pageIndex)}?t=${ts}`}
        alt={`第 ${pageIndex + 1} 頁`}
        className="w-full h-full object-cover"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </div>
  );
}

export default function StudentEdit() {
  const { projectId, studentId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [student, setStudent] = useState(null);
  const [projectBubbleTexts, setProjectBubbleTexts] = useState({});
  const [loadError, setLoadError] = useState(null);
  // Which page is selected for editing (0-based)
  const [activePage, setActivePage] = useState(0);
  const [texts, setTexts] = useState({});
  const [rendering, setRendering] = useState(false);
  const [ts, setTs] = useState(Date.now());
  // Mobile: which tab is active
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"

  // Text auto-save (500ms debounce)
  const textsRef = useRef(texts);
  useEffect(() => { textsRef.current = texts; }, [texts]);
  const textSaveTimerRef = useRef(null);
  useEffect(() => {
    if (!student) return;
    clearTimeout(textSaveTimerRef.current);
    textSaveTimerRef.current = setTimeout(async () => {
      const cur = textsRef.current;
      const payload = {};
      Object.entries(cur).forEach(([pidx, bubbles]) => { payload[pidx] = bubbles; });
      try {
        await batchUpdateTexts(projectId, { students: { [studentId]: payload } });
        setTs(Date.now());
      } catch (_) {}
    }, 500);
  }, [texts, student]);

  const load = async () => {
    try {
      const r = await getProject(projectId);
      setProject(r.data);
      const s = r.data.students.find(s => s.id === Number(studentId));
      if (!s) {
        setLoadError("找不到該學生");
        return;
      }
      setStudent(s);
      setProjectBubbleTexts(r.data.bubble_texts || {});
      const tr = await getTemplate(r.data.template_id);
      setTemplate(tr.data);
      const t = {};
      (s?.pages_data || []).forEach(pd => {
        t[pd.page_index] = pd.bubble_texts || {};
      });
      setTexts(t);
    } catch (e) {
      setLoadError("找不到專案或學生");
    }
  };

  useEffect(() => { load(); }, [projectId, studentId]);

  const getText = (pageIdx, bubbleId) => texts[pageIdx]?.[String(bubbleId)] ?? "";
  const setText = (pageIdx, bubbleId, val) => {
    setTexts(prev => ({
      ...prev,
      [pageIdx]: { ...(prev[pageIdx] || {}), [String(bubbleId)]: val }
    }));
  };

  const refresh = () => setTs(Date.now());

  const handleRender = async () => {
    // Flush pending text save before rendering
    clearTimeout(textSaveTimerRef.current);
    const cur = textsRef.current;
    const payload = {};
    Object.entries(cur).forEach(([pidx, bubbles]) => { payload[pidx] = bubbles; });
    await batchUpdateTexts(projectId, { students: { [studentId]: payload } });

    setRendering(true);
    try {
      await renderStudent(projectId, studentId);
      toast.success("PDF 已產生");
      await load();
      refresh();
    } catch { toast.error("產生失敗"); }
    setRendering(false);
  };


  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <p className="text-red-500 font-medium">{loadError}</p>
      <Link to="/projects" className="text-sm text-indigo-600 hover:underline">← 返回專案列表</Link>
    </div>
  );

  if (!project || !template || !student) return (
    <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
  );

  const pages = template.pages;
  const pageCount = pages.length;

  // Layout for editor
  const layout = pages[activePage]?.layout;

  // ── Shared preview panel content ──────────────────────────────────────────
  const previewPanel = (
    <div className="space-y-3">
      <AlbumPageNav page={activePage} total={pageCount} onChange={setActivePage} />
      <PagePreview
        projectId={projectId} studentId={studentId}
        pageIndex={activePage} ts={ts}
      />
      <div className="flex justify-center">
        <button onClick={refresh}
          className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 py-1.5 px-3 rounded-lg hover:bg-gray-100 transition-colors">
          <RefreshCw className="w-3 h-3" />重新整理預覽
        </button>
      </div>
    </div>
  );

  // ── Photo panel ────────────────────────────────────────────────────────────
  const photoPanel = (
    <PhotoManager
      projectId={projectId} studentId={studentId}
      pages={pages} student={student}
      onPhotoSaved={() => setTs(Date.now())}
      onSaved={() => { load(); setTs(Date.now()); }}
    />
  );

  // ── Text panel ─────────────────────────────────────────────────────────────
  const textPanel = (
    <div className="space-y-4">
      <AlbumPageNav page={activePage} total={pageCount} onChange={setActivePage} />
      {layout?.text_bubbles?.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle className="w-4 h-4 text-violet-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              第 {activePage + 1} 頁氣泡文字
            </h3>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">({"{name}"} 自動代入姓名)</span>
          </div>
          <div className="space-y-3">
            {layout.text_bubbles.map(bubble => {
              const rawDefault =
                projectBubbleTexts[String(activePage)]?.[String(bubble.id)] ?? bubble.text ?? "";
              const defaultText = rawDefault.replace("{name}", student.name);
              return (
                <div key={bubble.id} className="flex gap-3">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-1 text-xs font-bold"
                    style={{ background: bubble.fill + "60", color: bubble.font_color || "#555" }}>
                    {bubble.id}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs text-gray-400 mb-1">預設：{defaultText.substring(0, 25)}</div>
                    <textarea rows={2}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                      placeholder={defaultText}
                      value={getText(activePage, bubble.id)}
                      onChange={e => setText(activePage, bubble.id, e.target.value)}
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

  return (
    <div className="w-full">
      {/* ── Breadcrumb + actions ── */}
      <div className="flex flex-wrap items-center gap-2 mb-4 sm:mb-6 text-sm">
        <Link to="/projects" className="text-gray-400 hover:text-gray-600 transition-colors hidden sm:inline">相本專案</Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />
        <Link to={`/projects/${projectId}/review`} className="text-gray-400 hover:text-gray-600 transition-colors">
          <ChevronLeft className="w-3.5 h-3.5 inline sm:hidden" />
          <span>{project.name}</span>
        </Link>
        <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />
        <span className="font-semibold text-gray-900">{student.name}</span>
        <span className="text-xs bg-violet-100 text-violet-700 px-2 py-0.5 rounded-full">個別編輯</span>
        <div className="ml-auto flex gap-2">
          <button onClick={handleRender} disabled={rendering}
            className="flex items-center gap-1.5 bg-emerald-600 text-white px-3 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 transition-colors shadow-sm">
            {rendering ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            <span className="hidden sm:inline">{rendering ? "產生中..." : "產生 PDF"}</span>
            <span className="sm:hidden">{rendering ? "..." : "PDF"}</span>
          </button>
          {student.output_filename && (
            <a href={downloadPdf(projectId, studentId)}
              className="flex items-center gap-1.5 border border-gray-200 text-gray-700 px-3 py-2 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">下載</span>
            </a>
          )}
        </div>
      </div>

      <PanelSwitcher
        value={mobileTab}
        onChange={setMobileTab}
        tabs={[
          { value: "photo",   label: "📷 照片" },
          { value: "text",    label: "💬 文字" },
          { value: "preview", label: "👁 預覽" },
        ]}
      />

      {/* ── Desktop: preview left | photo+text right ── */}
      {/* ── Mobile: one panel at a time ── */}
      <div className="lg:flex lg:gap-6 lg:items-start">
        {/* Preview — left on desktop, full on mobile when preview tab */}
        <div className={`lg:block lg:flex-shrink-0 lg:w-1/3 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`}>
          {previewPanel}
        </div>
        {/* Photo — right on desktop, full on mobile when photo tab */}
        <div className={`lg:block lg:flex-1 lg:min-w-0 ${mobileTab === "photo" ? "block" : "hidden lg:block"} lg:space-y-6`}>
          {photoPanel}
          {/* Text panel visible on desktop below photos */}
          <div className="hidden lg:block">
            {textPanel}
          </div>
        </div>
        {/* Text — mobile only when text tab */}
        <div className={`lg:hidden ${mobileTab === "text" ? "block" : "hidden"} w-full`}>
          {textPanel}
        </div>
      </div>
    </div>
  );
}
