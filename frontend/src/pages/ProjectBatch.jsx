import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  getProject, batchAddStudents, deleteStudent,
  getTemplate, updateProjectBubbleTexts, projectPreviewUrl, renameStudent
} from "../api";
import { Users, Plus, ChevronRight, X, MessageCircle, Eye, Loader2, RefreshCw, Pencil, Check } from "lucide-react";
import PanelSwitcher from "../components/PanelSwitcher";
import AlbumPageNav from "../components/AlbumPageNav";

export default function ProjectBatch() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [tab, setTab] = useState("students"); // "students" | "texts"
  const [mobileTab, setMobileTab] = useState("students"); // "students" | "edit" | "preview"

  const handleMobileTab = (v) => {
    setMobileTab(v);
    setTab(v === "students" ? "students" : "texts");
  };

  // Tab 1 state
  const [namesInput, setNamesInput] = useState("");
  const [editingStudentId, setEditingStudentId] = useState(null);
  const [editingStudentName, setEditingStudentName] = useState("");
  const [adding, setAdding] = useState(false);

  // Tab 2 state — bubbleTexts[pageIndex][bubbleId] = text
  const [activePage, setActivePage] = useState(0);
  const [bubbleTexts, setBubbleTexts] = useState({});
  const [previewLoading, setPreviewLoading] = useState(false);
  const [ts, setTs] = useState(Date.now());

  // Debounced save to project bubble texts
  const bubbleTextsRef = useRef(bubbleTexts);
  useEffect(() => { bubbleTextsRef.current = bubbleTexts; }, [bubbleTexts]);
  const saveTimerRef = useRef(null);

  const scheduleSave = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      const payload = {};
      Object.entries(bubbleTextsRef.current).forEach(([pi, bubbles]) => {
        payload[String(pi)] = bubbles;
      });
      try {
        await updateProjectBubbleTexts(id, payload);
        setTs(Date.now());
      } catch (_) {}
    }, 600);
  };

  const load = async () => {
    const r = await getProject(id);
    setProject(r.data);
    const tr = await getTemplate(r.data.template_id);
    setTemplate(tr.data);
    const projectBt = r.data.bubble_texts || {};
    const bt = {};
    tr.data.pages.forEach((p, i) => {
      bt[i] = {};
      (p.layout?.text_bubbles || []).forEach(b => {
        bt[i][String(b.id)] = projectBt[String(i)]?.[String(b.id)] ?? b.text ?? "";
      });
    });
    setBubbleTexts(bt);
  };

  useEffect(() => { load(); }, [id]);

  const handleAddStudents = async () => {
    const names = namesInput.split(/[\n,，、]/).map(n => n.trim()).filter(Boolean);
    if (!names.length) return;
    setAdding(true);
    const res = await batchAddStudents(id, names);
    const { created = [], skipped = [] } = res.data || {};
    setNamesInput("");
    if (created.length) toast.success(`已新增 ${created.length} 位學生`);
    if (skipped.length) toast.error(`已略過重複名稱：${skipped.join("、")}`);
    if (!created.length && !skipped.length) toast.error("未新增任何學生");
    await load();
    setAdding(false);
  };

  const startEditStudent = (s) => { setEditingStudentId(s.id); setEditingStudentName(s.name); };
  const cancelEditStudent = () => { setEditingStudentId(null); setEditingStudentName(""); };
  const saveEditStudent = async (sid) => {
    if (!editingStudentName.trim()) return cancelEditStudent();
    await renameStudent(id, sid, editingStudentName.trim());
    cancelEditStudent();
    await load();
  };

  const handleDeleteStudent = async (sid, e) => {
    e.stopPropagation();
    if (!confirm("確定刪除此學生？")) return;
    await deleteStudent(id, sid);
    toast.success("已刪除");
    await load();
  };

  const getBubbleText = (pageIdx, bubbleId) =>
    bubbleTexts[pageIdx]?.[String(bubbleId)] ?? "";

  const setBubbleText = (pageIdx, bubbleId, val) => {
    setBubbleTexts(prev => ({
      ...prev,
      [pageIdx]: { ...(prev[pageIdx] || {}), [String(bubbleId)]: val },
    }));
    scheduleSave();
  };

  if (!project || !template) return (
    <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
  );

  const pages = template.pages;
  const layout = pages[activePage]?.layout;

  // ── 氣泡文字 editor panel ──────────────────────────────────────────────────
  const editorPanel = (
    <div className="space-y-3">
      <AlbumPageNav page={activePage} total={pages.length} onChange={setActivePage} />

      {layout?.text_bubbles?.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <MessageCircle className="w-4 h-4 text-violet-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              氣泡文字 — 第 {activePage + 1} 頁
            </h3>
            <span className="text-xs text-gray-400 hidden sm:inline">
              （{"{name}"} 會自動代入各學生姓名）
            </span>
          </div>
          <div className="space-y-3">
            {layout.text_bubbles.map(bubble => (
              <div key={bubble.id} className="flex gap-3">
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-1"
                  style={{ background: bubble.fill + "60" }}
                >
                  <span className="text-xs font-bold" style={{ color: bubble.font_color || "#555" }}>
                    {bubble.id}
                  </span>
                </div>
                <div className="flex-1">
                  <textarea
                    rows={2}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                    value={getBubbleText(activePage, bubble.id)}
                    onChange={e => setBubbleText(activePage, bubble.id, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center py-10 text-gray-400 text-sm">
          此頁沒有氣泡文字
        </div>
      )}
    </div>
  );

  // ── 樣版預覽 panel ─────────────────────────────────────────────────────────
  const previewPanel = (
    <div className="space-y-3 sticky top-4">
      <AlbumPageNav page={activePage} total={pages.length} onChange={setActivePage} />
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <div className="flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">樣版預覽</span>
            <span className="text-xs text-gray-400">第 {activePage + 1} 頁</span>
          </div>
          <button
            onClick={() => { setTs(Date.now()); setPreviewLoading(true); }}
            title="重新渲染"
            className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="relative bg-gray-50" style={{ aspectRatio: "794/1123" }}>
          {previewLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
            </div>
          )}
          <img
            key={`proj-${id}-${activePage}-${ts}`}
            src={`${projectPreviewUrl(id, activePage)}?t=${ts}`}
            alt="preview"
            className="w-full h-full object-contain"
            onLoad={() => setPreviewLoading(false)}
            onError={() => setPreviewLoading(false)}
          />
        </div>
      </div>
    </div>
  );

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center gap-2 sm:gap-3 mb-5 sm:mb-6">
        <Link to="/projects" className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0">
          <ChevronRight className="w-4 h-4 rotate-180" />
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <span className="text-gray-400 text-sm hidden sm:inline">相本專案</span>
          <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />
          <span className="font-semibold text-gray-900 truncate">{project.name}</span>
          <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full flex-shrink-0">專案設定</span>
        </div>
        <Link
          to={`/projects/${id}/review`}
          className="ml-auto flex items-center gap-1 sm:gap-1.5 text-sm bg-emerald-600 text-white px-3 sm:px-4 py-2 rounded-xl hover:bg-emerald-700 transition-colors flex-shrink-0"
        >
          <span className="hidden sm:inline">個人編輯</span>
          <span className="sm:hidden">編輯</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* Mobile: 三格 PanelSwitcher，永遠顯示 */}
      <PanelSwitcher
        value={mobileTab}
        onChange={handleMobileTab}
        tabs={[
          { value: "students", label: "👥 登記" },
          { value: "edit",     label: "✏️ 文字" },
          { value: "preview",  label: "👁 預覽" },
        ]}
      />

      {/* Desktop: pill tabs */}
      <div className="hidden lg:flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setTab("students")}
          className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === "students" ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Users className="w-4 h-4" />
          登記學生
        </button>
        <button
          onClick={() => setTab("texts")}
          className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            tab === "texts" ? "bg-white text-indigo-700 shadow-sm" : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <MessageCircle className="w-4 h-4" />
          氣泡文字
        </button>
      </div>

      {/* Tab 1: 登記學生 */}
      {tab === "students" && (
        <div className="max-w-xl space-y-5">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-indigo-500" />
              <h2 className="font-semibold text-gray-800 text-sm">新增學生名單</h2>
              <span className="text-xs text-gray-400 ml-1">（已有 {project.students.length} 位）</span>
            </div>
            <div className="flex gap-2 sm:gap-3">
              <textarea
                rows={3}
                className="flex-1 border border-gray-200 rounded-xl px-3 sm:px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                placeholder="每行一位，或用逗號 / 頓號分隔"
                value={namesInput}
                onChange={e => setNamesInput(e.target.value)}
              />
              <button
                onClick={handleAddStudents}
                disabled={adding || !namesInput.trim()}
                className="self-stretch flex items-center gap-2 bg-indigo-600 text-white px-4 sm:px-5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">新增</span>
              </button>
            </div>
          </div>

          {project.students.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                已登記學生（{project.students.length} 位）
              </div>
              <div className="space-y-1">
                {project.students.map((s, i) => (
                  <div
                    key={s.id}
                    className="group flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-xs w-5 h-5 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center font-medium flex-shrink-0">
                      {i + 1}
                    </span>
                    {editingStudentId === s.id ? (
                      <>
                        <input
                          autoFocus
                          className="flex-1 border border-indigo-300 rounded-lg px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          value={editingStudentName}
                          onChange={e => setEditingStudentName(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") saveEditStudent(s.id); if (e.key === "Escape") cancelEditStudent(); }}
                        />
                        <button onClick={() => saveEditStudent(s.id)} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"><Check className="w-3.5 h-3.5" /></button>
                        <button onClick={cancelEditStudent} className="p-1 text-gray-400 hover:bg-gray-100 rounded"><X className="w-3.5 h-3.5" /></button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-sm text-gray-800 font-medium">{s.name}</span>
                        <button onClick={() => startEditStudent(s)} className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-indigo-600 rounded-lg">
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button onClick={e => handleDeleteStudent(s.id, e)} className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-red-500 rounded-lg">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {project.students.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">尚未新增任何學生</p>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: 氣泡文字 */}
      {tab === "texts" && (
        <div className="lg:grid lg:gap-6 lg:items-start" style={{ gridTemplateColumns: "1fr 2fr" }}>
          <div className={mobileTab === "preview" ? "block" : "hidden lg:block"}>
            {previewPanel}
          </div>
          <div className={mobileTab === "edit" ? "block" : "hidden lg:block"}>
            {editorPanel}
          </div>
        </div>
      )}
    </div>
  );
}
