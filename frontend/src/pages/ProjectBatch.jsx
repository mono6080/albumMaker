// 專案設定頁面
// 提供學生名單管理（批次新增、刪除、改名）與專案層級對印文字的統一填入，
// 文字變更後自動防抖儲存（600ms），並在右側顯示即時預覽

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";

import {
  fetchProject, batchAddStudents, deleteStudent,
  updateProjectLabelTexts, renameStudent,
} from "../api/projectApi";
import { fetchTemplate } from "../api/templateApi";
import { buildProjectPagePreviewUrl } from "../api/urls";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  Users, Plus, ChevronRight, X, Type,
  Eye, Loader2, RefreshCw, Pencil, Check,
} from "lucide-react";
import PanelSwitcher from "../components/PanelSwitcher";
import AlbumPageNav from "../components/AlbumPageNav";

export default function ProjectBatch() {
  const { id: projectId } = useParams();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [desktopTab, setDesktopTab] = useState("students"); // "students" | "texts"
  const [mobileTab, setMobileTab] = useState("students");   // "students" | "edit" | "preview"

  // 行動版分頁切換時同步桌面 tab
  const handleMobileTabChange = (selectedTab) => {
    setMobileTab(selectedTab);
    setDesktopTab(selectedTab === "students" ? "students" : "texts");
  };

  // 學生名單 tab 狀態
  const [studentNamesInput, setStudentNamesInput] = useState("");
  const [editingStudentId, setEditingStudentId] = useState(null);
  const [editingStudentName, setEditingStudentName] = useState("");
  const [isAddingStudents, setIsAddingStudents] = useState(false);

  // 對印文字 tab 狀態
  const [activePage, setActivePage] = useState(0);
  const [labelTexts, setLabelTexts] = useState({});  // { [pageIndex]: { [labelId]: text } }
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewTimestamp, setPreviewTimestamp] = useState(Date.now());

  // ── 自動儲存對印文字（防抖 600ms） ────────────────────────────────────────

  const { scheduleSave } = useAutoSave(
    labelTexts,
    async (currentLabelTexts) => {
      const payload = {};
      Object.entries(currentLabelTexts).forEach(([pageIndex, labels]) => {
        payload[String(pageIndex)] = labels;
      });
      try {
        await updateProjectLabelTexts(projectId, payload);
        setPreviewTimestamp(Date.now());
      } catch { /* 靜默失敗 */ }
    },
    600
  );

  // ── 資料載入 ──────────────────────────────────────────────────────────────

  const loadProjectData = async () => {
    const projectResponse = await fetchProject(projectId);
    setProject(projectResponse.data);

    const templateResponse = await fetchTemplate(projectResponse.data.template_id);
    setTemplate(templateResponse.data);

    // 初始化對印文字狀態（專案設定優先，若無則使用模板預設）
    const savedProjectLabelTexts = projectResponse.data.label_texts || {};
    const initialLabelTexts = {};
    templateResponse.data.pages.forEach((templatePage, pageIndex) => {
      initialLabelTexts[pageIndex] = {};
      (templatePage.layout?.text_labels || []).forEach(label => {
        initialLabelTexts[pageIndex][String(label.id)] =
          savedProjectLabelTexts[String(pageIndex)]?.[String(label.id)] ?? label.text ?? "";
      });
    });
    setLabelTexts(initialLabelTexts);
  };

  useEffect(() => { loadProjectData(); }, [projectId]);

  // ── 學生名單管理 ──────────────────────────────────────────────────────────

  const handleAddStudents = async () => {
    const parsedNames = studentNamesInput
      .split(/[\n,，、]/)
      .map(name => name.trim())
      .filter(Boolean);
    if (!parsedNames.length) return;

    setIsAddingStudents(true);
    const response = await batchAddStudents(projectId, parsedNames);
    const { created = [], skipped = [] } = response.data || {};
    setStudentNamesInput("");

    if (created.length) toast.success(`已新增 ${created.length} 位學生`);
    if (skipped.length) toast.error(`已略過重複名稱：${skipped.join("、")}`);
    if (!created.length && !skipped.length) toast.error("未新增任何學生");

    await loadProjectData();
    setIsAddingStudents(false);
  };

  const startEditStudent = (student) => {
    setEditingStudentId(student.id);
    setEditingStudentName(student.name);
  };

  const cancelEditStudent = () => {
    setEditingStudentId(null);
    setEditingStudentName("");
  };

  const saveEditStudent = async (studentId) => {
    if (!editingStudentName.trim()) {
      cancelEditStudent();
      return;
    }
    await renameStudent(projectId, studentId, editingStudentName.trim());
    cancelEditStudent();
    await loadProjectData();
  };

  const handleDeleteStudent = async (studentId, clickEvent) => {
    clickEvent.stopPropagation();
    if (!confirm("確定刪除此學生？")) return;
    await deleteStudent(projectId, studentId);
    toast.success("已刪除");
    await loadProjectData();
  };

  // ── 對印文字操作 ──────────────────────────────────────────────────────────

  const getLabelText = (pageIndex, labelId) =>
    labelTexts[pageIndex]?.[String(labelId)] ?? "";

  const setLabelText = (pageIndex, labelId, textValue) => {
    setLabelTexts(prevTexts => ({
      ...prevTexts,
      [pageIndex]: { ...(prevTexts[pageIndex] || {}), [String(labelId)]: textValue },
    }));
    scheduleSave();
  };

  // ── 載入中 ────────────────────────────────────────────────────────────────

  if (!project || !template) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
    );
  }

  const templatePages = template.pages;
  const activePageLayout = templatePages[activePage]?.layout;

  // ── 對印文字編輯面板 ──────────────────────────────────────────────────────

  const editorPanel = (
    <div className="space-y-3">
      <AlbumPageNav page={activePage} total={templatePages.length} onChange={setActivePage} />

      {activePageLayout?.text_labels?.length > 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-indigo-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              對印文字 — 第 {activePage + 1} 頁
            </h3>
            <span className="text-xs text-gray-400 hidden sm:inline">
              （{"{name}"} 會自動代入各學生姓名）
            </span>
          </div>
          <div className="space-y-3">
            {activePageLayout.text_labels.map(label => (
              <div key={label.id} className="flex gap-3">
                <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-1">
                  <span className="text-xs font-bold text-indigo-400">{label.id}</span>
                </div>
                <div className="flex-1">
                  <textarea
                    rows={2}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                    value={getLabelText(activePage, label.id)}
                    onChange={event => setLabelText(activePage, label.id, event.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center py-10 text-gray-400 text-sm">
          此頁沒有對印文字方塊
        </div>
      )}
    </div>
  );

  // ── 模板預覽面板 ──────────────────────────────────────────────────────────

  const previewPanel = (
    <div className="space-y-3 sticky top-4">
      <AlbumPageNav page={activePage} total={templatePages.length} onChange={setActivePage} />
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden">
        {/* 預覽標題列 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <div className="flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">樣版預覽</span>
            <span className="text-xs text-gray-400">第 {activePage + 1} 頁</span>
          </div>
          <button
            onClick={() => { setPreviewTimestamp(Date.now()); setIsPreviewLoading(true); }}
            title="重新渲染"
            className="p-1 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 預覽圖區域 */}
        <div className="relative bg-gray-50" style={{ aspectRatio: "794/1123" }}>
          {isPreviewLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
            </div>
          )}
          <img
            key={`proj-${projectId}-${activePage}-${previewTimestamp}`}
            src={`${buildProjectPagePreviewUrl(projectId, activePage)}?t=${previewTimestamp}`}
            alt="preview"
            className="w-full h-full object-contain"
            onLoad={() => setIsPreviewLoading(false)}
            onError={() => setIsPreviewLoading(false)}
          />
        </div>
      </div>
    </div>
  );

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      {/* 頂部標頭 */}
      <div className="flex items-center gap-2 sm:gap-3 mb-5 sm:mb-6">
        <Link
          to="/projects"
          className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
        >
          <ChevronRight className="w-4 h-4 rotate-180" />
        </Link>
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <span className="text-gray-400 text-sm hidden sm:inline">相本專案</span>
          <ChevronRight className="w-3.5 h-3.5 text-gray-300 hidden sm:block" />
          <span className="font-semibold text-gray-900 truncate">{project.name}</span>
          <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full flex-shrink-0">
            專案設定
          </span>
        </div>
        <Link
          to={`/projects/${projectId}/review`}
          className="ml-auto flex items-center gap-1 sm:gap-1.5 text-sm bg-emerald-600 text-white px-3 sm:px-4 py-2 rounded-xl hover:bg-emerald-700 transition-colors flex-shrink-0"
        >
          <span className="hidden sm:inline">個人編輯</span>
          <span className="sm:hidden">編輯</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* 行動版分頁切換器 */}
      <PanelSwitcher
        value={mobileTab}
        onChange={handleMobileTabChange}
        tabs={[
          { value: "students", label: "👥 登記" },
          { value: "edit",     label: "✏️ 文字" },
          { value: "preview",  label: "👁 預覽" },
        ]}
      />

      {/* 桌面版 Pill 分頁 */}
      <div className="hidden lg:flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit">
        <button
          onClick={() => setDesktopTab("students")}
          className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            desktopTab === "students"
              ? "bg-white text-indigo-700 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Users className="w-4 h-4" />
          登記學生
        </button>
        <button
          onClick={() => setDesktopTab("texts")}
          className={`flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
            desktopTab === "texts"
              ? "bg-white text-indigo-700 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          <Type className="w-4 h-4" />
          對印文字
        </button>
      </div>

      {/* Tab 1：登記學生 */}
      {desktopTab === "students" && (
        <div className="max-w-xl space-y-5">
          {/* 新增學生輸入區 */}
          <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-indigo-500" />
              <h2 className="font-semibold text-gray-800 text-sm">新增學生名單</h2>
              <span className="text-xs text-gray-400 ml-1">
                （已有 {project.students.length} 位）
              </span>
            </div>
            <div className="flex gap-2 sm:gap-3">
              <textarea
                rows={3}
                className="flex-1 border border-gray-200 rounded-xl px-3 sm:px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none"
                placeholder="每行一位，或用逗號 / 頓號分隔"
                value={studentNamesInput}
                onChange={event => setStudentNamesInput(event.target.value)}
              />
              <button
                onClick={handleAddStudents}
                disabled={isAddingStudents || !studentNamesInput.trim()}
                className="self-stretch flex items-center gap-2 bg-indigo-600 text-white px-4 sm:px-5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">新增</span>
              </button>
            </div>
          </div>

          {/* 已登記學生清單 */}
          {project.students.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                已登記學生（{project.students.length} 位）
              </div>
              <div className="space-y-1">
                {project.students.map((student, studentIndex) => (
                  <div
                    key={student.id}
                    className="group flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-xs w-5 h-5 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center font-medium flex-shrink-0">
                      {studentIndex + 1}
                    </span>

                    {editingStudentId === student.id ? (
                      <>
                        <input
                          autoFocus
                          className="flex-1 border border-indigo-300 rounded-lg px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          value={editingStudentName}
                          onChange={event => setEditingStudentName(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") saveEditStudent(student.id);
                            if (event.key === "Escape") cancelEditStudent();
                          }}
                        />
                        <button
                          onClick={() => saveEditStudent(student.id)}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={cancelEditStudent}
                          className="p-1 text-gray-400 hover:bg-gray-100 rounded"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-sm text-gray-800 font-medium">
                          {student.name}
                        </span>
                        <button
                          onClick={() => startEditStudent(student)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-indigo-600 rounded-lg"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={clickEvent => handleDeleteStudent(student.id, clickEvent)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 text-gray-400 hover:text-red-500 rounded-lg"
                        >
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

      {/* Tab 2：對印文字（桌面版：左預覽 | 右編輯；行動版：分頁切換） */}
      {desktopTab === "texts" && (
        <div
          className="lg:grid lg:gap-6 lg:items-start"
          style={{ gridTemplateColumns: "1fr 2fr" }}
        >
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
