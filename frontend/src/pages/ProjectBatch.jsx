// 專案設定頁面
// 提供學生名單管理（批次新增、刪除、改名）與專案層級對應文字的統一填入，
// 文字變更後自動防抖儲存（600ms），並在右側顯示即時預覽

import { useCallback, useEffect, useState } from "react";
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
  Users, Plus, ChevronRight, X, Type, CircleHelp,
  Eye, Loader2, RefreshCw, Pencil, Check,
} from "lucide-react";
import PanelSwitcher from "../components/PanelSwitcher";
import { useInlineEdit } from "../hooks/useInlineEdit";
import AlbumPageNav from "../components/AlbumPageNav";
import ConfirmModal from "../components/ConfirmModal";
import ResponsiveActionGroup, {
  mobileVisibleHoverActionClass,
  responsiveActionItemClass,
} from "../components/ResponsiveActionGroup";
import TextVariableTextarea from "../components/TextVariableTextarea";
import {
  Badge,
  Button,
  IconButton,
  PageHeader,
  SegmentedControl,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { startProductGuide } from "../utils/productGuide";
import { filterFillableLabelTexts, getFillableTextLabels } from "../utils/textLabelRoles";

const BATCH_STUDENT_GUIDE_STEPS = [
  {
    element: '[data-guide="batch-student-input"]',
    title: "新增學生名單",
    description: "把學生姓名貼在這裡，可以一行一位，也可以用逗號或頓號分隔。",
    side: "right",
    align: "start",
  },
  {
    element: '[data-guide="batch-add-students"]',
    title: "新增學生",
    description: "按下新增後，系統會自動略過空白與重複姓名。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="batch-student-list"]',
    title: "已登記學生",
    description: "新增後在這裡檢查人數、修改姓名或刪除不需要的學生。",
    side: "right",
    align: "start",
  },
  {
    element: '[data-guide="batch-text-tab"]',
    title: "整班共用文字",
    description: "切到文字頁籤後，可以填每位學生共用的頁面文字。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="batch-review-link"]',
    title: "進入個人編輯",
    description: "學生名單與共用文字確認後，進入個人編輯逐位補照片與輸出。",
    side: "left",
    align: "center",
  },
];

const BATCH_TEXT_GUIDE_STEPS = [
  {
    element: '[data-guide="batch-page-nav"]',
    title: "切換頁面",
    description: "切換不同頁面，逐頁檢查需要填的文字欄位。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="batch-text-fields"]',
    title: "整班共用文字",
    description: "這裡填入全班共用文案，清空會輸出空白；按恢復預設可回到模板文字，{name} 會在輸出時自動替換姓名。",
    side: "left",
    align: "start",
  },
  {
    element: '[data-guide="batch-text-insert-name"]',
    title: "插入 {name}",
    description: "點一下就能在游標位置加入姓名變數，不需要手動輸入大括號。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="batch-preview-panel"]',
    title: "樣版預覽",
    description: "右側預覽會套用目前文字，確認文字位置與內容是否正確。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="batch-students-tab"]',
    title: "回到學生名單",
    description: "需要新增或修改學生時，回到登記學生頁籤。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="batch-review-link"]',
    title: "進入個人編輯",
    description: "共用文字填完後，進入個人編輯逐位補照片、覆寫文字或輸出 PDF。",
    side: "left",
    align: "center",
  },
];

export default function ProjectBatch() {
  const { id: projectId } = useParams();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [desktopTab, setDesktopTab] = useState("students"); // "students" | "texts"
  const [mobileTab, setMobileTab] = useState("students");   // "students" | "edit" | "preview"

  // 行動版分頁切換時同步桌面 tab
  const handleMobileTabChange = (selectedTab) => {
    setMobileTab(selectedTab);
    setDesktopTab(selectedTab === "students" ? "students" : "texts");
  };

  const startGuide = () => {
    startProductGuide(desktopTab === "students" ? BATCH_STUDENT_GUIDE_STEPS : BATCH_TEXT_GUIDE_STEPS);
  };

  // 學生名單 tab 狀態
  const [studentNamesInput, setStudentNamesInput] = useState("");
  const [isAddingStudents, setIsAddingStudents] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  // 對應文字 tab 狀態
  const [activePage, setActivePage] = useState(0);
  const [labelTexts, setLabelTexts] = useState({});  // { [pageIndex]: { [labelId]: text } }
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewTimestamp, setPreviewTimestamp] = useState(0);

  // ── 自動儲存對應文字（防抖 600ms） ────────────────────────────────────────

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

  const loadProjectData = useCallback(async () => {
    try {
      const projectResponse = await fetchProject(projectId);
      setProject(projectResponse.data);

      const templateResponse = await fetchTemplate(projectResponse.data.template_id);
      setTemplate(templateResponse.data);

      // 初始化對應文字狀態：只保存專案覆寫；未覆寫時由預覽/渲染使用模板預設。
      const savedProjectLabelTexts = projectResponse.data.label_texts || {};
      const initialLabelTexts = {};
      templateResponse.data.pages.forEach((templatePage, pageIndex) => {
        initialLabelTexts[pageIndex] = filterFillableLabelTexts(
          templatePage.layout?.text_labels || [],
          savedProjectLabelTexts[String(pageIndex)] || {}
        );
      });
      setLabelTexts(initialLabelTexts);
    } catch {
      setLoadError("找不到專案，請確認連結是否正確");
    }
  }, [projectId]);

  useEffect(() => { loadProjectData(); }, [loadProjectData]);

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

  const { editingId: editingStudentId, editingValue: editingStudentName,
    setEditingValue: setEditingStudentName, startEdit: startEditStudent,
    cancelEdit: cancelEditStudent, submitEdit: saveEditStudent } = useInlineEdit(
    useCallback(async (studentId, newName) => {
      await renameStudent(projectId, studentId, newName);
      await loadProjectData();
    }, [projectId, loadProjectData])
  );

  const handleDeleteStudent = (studentId, clickEvent) => {
    clickEvent.stopPropagation();
    setConfirmModal({
      message: "確定刪除此學生？",
      onConfirm: async () => {
        await deleteStudent(projectId, studentId);
        toast.success("已刪除");
        await loadProjectData();
      },
    });
  };

  // ── 對應文字操作 ──────────────────────────────────────────────────────────

  const getLabelText = (pageIndex, labelId) =>
    labelTexts[pageIndex]?.[String(labelId)] ?? "";

  const hasLabelTextOverride = (pageIndex, labelId) =>
    Object.prototype.hasOwnProperty.call(labelTexts[pageIndex] || {}, String(labelId));

  const setLabelText = (pageIndex, labelId, textValue) => {
    setLabelTexts(prevTexts => ({
      ...prevTexts,
      [pageIndex]: { ...(prevTexts[pageIndex] || {}), [String(labelId)]: textValue },
    }));
  };

  const restoreDefaultLabelText = (pageIndex, labelId) => {
    setLabelTexts(prevTexts => {
      const nextPageTexts = { ...(prevTexts[pageIndex] || {}) };
      delete nextPageTexts[String(labelId)];
      return { ...prevTexts, [pageIndex]: nextPageTexts };
    });
  };

  // ── 載入中 ────────────────────────────────────────────────────────────────

  if (loadError) return (
    <div className="flex flex-col items-center justify-center h-64 gap-3">
      <p className="text-red-500 font-medium">{loadError}</p>
      <Link to="/projects" className="text-sm text-indigo-600 hover:underline">← 返回專案列表</Link>
    </div>
  );

  if (!project || !template) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">載入中...</div>
    );
  }

  const templatePages = template.pages;
  const activePageLayout = templatePages[activePage]?.layout;
  const activePageTextLabels = getFillableTextLabels(activePageLayout);

  // ── 對應文字編輯面板 ──────────────────────────────────────────────────────

  const editorPanel = (
    <div className="space-y-3">
      <div data-guide="batch-page-nav">
        <AlbumPageNav page={activePage} total={templatePages.length} onChange={setActivePage} />
      </div>

      {activePageTextLabels.length > 0 ? (
        <Surface data-guide="batch-text-fields">
          <div className="flex items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-indigo-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              文字 — 第 {activePage + 1} 頁
            </h3>
            <span className="text-xs text-gray-400 hidden sm:inline">
              （{"{name}"} 會自動代入各學生姓名，清空會輸出空白）
            </span>
          </div>
          <div className="space-y-3">
            {activePageTextLabels.map(label => {
              const templateDefaultText = label.text ?? "";
              const currentValue = getLabelText(activePage, label.id);
              const hasOverride = hasLabelTextOverride(activePage, label.id);
              const len = currentValue.length;
              return (
                <div key={label.id} className="flex gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-1">
                    <span className="text-xs font-bold text-indigo-400">{label.id}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <TextVariableTextarea
                      rows={2}
                      className={`${fieldControlClass} resize-none`}
                      placeholder={templateDefaultText}
                      value={currentValue}
                      defaultText={templateDefaultText}
                      inheritedValue={templateDefaultText}
                      hasOverride={hasOverride}
                      onChange={value => setLabelText(activePage, label.id, value)}
                      onRestoreDefault={() => restoreDefaultLabelText(activePage, label.id)}
                      onScheduleSave={scheduleSave}
                      buttonGuideId="batch-text-insert-name"
                      maxLength={200}
                    />
                    {len > 0 && (
                      <div className={`text-right text-xs mt-0.5 ${len >= 180 ? "text-red-500" : "text-gray-300"}`}>
                        {len}/200
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Surface>
      ) : (
        <div className="flex items-center justify-center py-10 text-gray-400 text-sm">
          此頁沒有可填文字
        </div>
      )}
    </div>
  );

  // ── 模板預覽面板 ──────────────────────────────────────────────────────────

  const previewPanel = (
    <div className="space-y-3 sticky top-4" data-guide="batch-preview-panel">
      <AlbumPageNav page={activePage} total={templatePages.length} onChange={setActivePage} />
      <Surface padding="none" className="overflow-hidden">
        {/* 預覽標題列 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100">
          <div className="flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5 text-violet-500" />
            <span className="text-sm font-semibold text-gray-800">樣版預覽</span>
            <span className="text-xs text-gray-400">第 {activePage + 1} 頁</span>
          </div>
          <IconButton
            label="重新渲染預覽"
            onClick={() => { setPreviewTimestamp(Date.now()); setIsPreviewLoading(true); }}
            variant="primary"
            size="xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </IconButton>
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
      </Surface>
    </div>
  );

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      <PageHeader
        title={project.name}
        badge={<Badge tone="primary">專案設定</Badge>}
        meta={(
          <>
            <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
              <ChevronRight className="inline h-4 w-4 rotate-180 sm:hidden" />
              <span className="hidden sm:inline">相本專案</span>
            </Button>
          </>
        )}
        actions={(
        <ResponsiveActionGroup mobileColumns={2}>
          <Button
            as={Link}
            to={`/projects/${projectId}/review`}
            data-guide="batch-review-link"
            variant="success"
            size="touch"
            className={responsiveActionItemClass}
          >
            <span className="hidden sm:inline">個人編輯</span>
            <span className="sm:hidden">編輯</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
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

      {/* 行動版分頁切換器 */}
      <PanelSwitcher
        value={mobileTab}
        onChange={handleMobileTabChange}
        tabs={[
          { value: "students", label: "登記", icon: Users },
          { value: "edit",     label: "文字", icon: Type },
          { value: "preview",  label: "預覽", icon: Eye },
        ]}
      />

      {/* 桌面版 Pill 分頁 */}
      <SegmentedControl
        value={desktopTab}
        onChange={setDesktopTab}
        options={[
          { value: "students", label: "登記學生", icon: Users, guideId: "batch-students-tab" },
          { value: "texts", label: "文字", icon: Type, guideId: "batch-text-tab" },
        ]}
        className="mb-5 hidden w-fit lg:grid"
      />

      {/* Tab 1：登記學生 */}
      {desktopTab === "students" && (
        <div className="max-w-xl space-y-5">
          {/* 新增學生輸入區 */}
          <Surface>
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-4 h-4 text-indigo-500" />
              <h2 className="font-semibold text-gray-800 text-sm">新增學生名單</h2>
              <span className="text-xs text-gray-400 ml-1">
                （已有 {project.students.length} 位）
              </span>
            </div>
            <div className="flex gap-2 sm:gap-3 min-w-0">
              <textarea
                rows={3}
                data-guide="batch-student-input"
                className={`${fieldControlClass} flex-1 resize-none sm:px-4 sm:py-2.5`}
                placeholder="每行一位，或用逗號 / 頓號分隔"
                value={studentNamesInput}
                onChange={event => setStudentNamesInput(event.target.value)}
              />
              <Button
                onClick={handleAddStudents}
                disabled={isAddingStudents || !studentNamesInput.trim()}
                data-guide="batch-add-students"
                variant="primary"
                className="self-stretch"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">新增</span>
              </Button>
            </div>
          </Surface>

          {/* 已登記學生清單 */}
          {project.students.length > 0 && (
            <Surface data-guide="batch-student-list">
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                已登記學生（{project.students.length} 位）
              </div>
              <div className="space-y-1">
                {project.students.map((student, studentIndex) => (
                  <div
                    key={student.id}
                    className="group flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-gray-50 transition-colors min-w-0"
                  >
                    <span className="text-xs w-5 h-5 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center font-medium flex-shrink-0">
                      {studentIndex + 1}
                    </span>

                    {editingStudentId === student.id ? (
                      <>
                        <input
                          autoFocus
                          className={`${fieldControlClass} flex-1 py-0.5`}
                          value={editingStudentName}
                          onChange={event => setEditingStudentName(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === "Enter") saveEditStudent(student.id);
                            if (event.key === "Escape") cancelEditStudent();
                          }}
                        />
                        <IconButton
                          label="儲存學生名稱"
                          onClick={() => saveEditStudent(student.id)}
                          variant="success"
                          size="xs"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton
                          label="取消編輯學生名稱"
                          onClick={cancelEditStudent}
                          size="xs"
                        >
                          <X className="w-3.5 h-3.5" />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 text-sm text-gray-800 font-medium truncate">
                          {student.name}
                        </span>
                        <IconButton
                          label="編輯學生名稱"
                          onClick={() => startEditStudent(student.id, student.name)}
                          variant="primary"
                          size="xs"
                          className={mobileVisibleHoverActionClass}
                        >
                          <Pencil className="w-3 h-3" />
                        </IconButton>
                        <IconButton
                          label="刪除學生"
                          onClick={clickEvent => handleDeleteStudent(student.id, clickEvent)}
                          variant="danger"
                          size="xs"
                          className={mobileVisibleHoverActionClass}
                        >
                          <X className="w-3.5 h-3.5" />
                        </IconButton>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </Surface>
          )}

          {project.students.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">尚未新增任何學生</p>
            </div>
          )}
        </div>
      )}

      {/* Tab 2：對應文字（桌面版：左預覽 | 右編輯；行動版：分頁切換） */}
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
