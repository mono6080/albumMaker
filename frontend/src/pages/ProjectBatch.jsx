// 專案設定頁面
// 提供學生名單管理（批次新增、刪除、改名）與專案層級對應文字的統一填入，
// 文字變更後自動防抖儲存（600ms），並在右側顯示即時預覽

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";

import {
  fetchProject, batchAddStudents, deleteStudent,
  updateProjectLabelTexts, renameStudent, uploadSharedProjectPhoto,
} from "../api/projectApi";
import { fetchTemplate } from "../api/templateApi";
import { buildProjectPagePreviewUrl } from "../api/urls";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  Users, Plus, ChevronRight, X, Type, CircleHelp,
  Eye, Loader2, RefreshCw, Pencil, Check, ImagePlus, Upload,
} from "lucide-react";
import PanelSwitcher from "../components/PanelSwitcher";
import { useInlineEdit } from "../hooks/useInlineEdit";
import AlbumPageNav from "../components/AlbumPageNav";
import BatchPhotoWizard from "../components/BatchPhotoWizard";
import ConfirmModal from "../components/ConfirmModal";
import PhotoSlotCard from "../components/PhotoSlotCard";
import ResponsiveActionGroup, {
  mobileVisibleHoverActionClass,
  responsiveActionItemClass,
} from "../components/ResponsiveActionGroup";
import TextVariableTextarea from "../components/TextVariableTextarea";
import TextAlignControl from "../components/TextAlignControl";
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
import {
  getLabelEntryAlign,
  getLabelEntryTextOverride,
  hasLabelEntryTextOverride,
  withLabelEntryAlign,
  withLabelEntryText,
  withoutLabelEntryText,
} from "../utils/labelTextEntries";

function uploadStatusLabel(status) {
  if (!status) return "";
  if (status.phase === "processing") return "處理中";
  return "上傳中";
}
import { filterFillableLabelTexts, getFillableTextLabels } from "../utils/textLabelRoles";
import { handleApiError } from "../utils/apiError";

const BATCH_STUDENT_GUIDE_STEPS = [
  {
    element: '[data-guide="batch-student-input"]',
    title: "新增學生名單",
    description: "把學生姓名貼在這裡，可以一行一位，也可以用逗號、頓號或空白分隔。",
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
    description: "新增後在這裡檢查人數、修改姓名或刪除不需要的學生。刪除前會再確認。",
    side: "right",
    align: "start",
  },
  {
    element: '[data-guide="batch-photos-tab"]',
    title: "全班共用照片",
    description: "如果某一格要放團體照或共用照片，切到這裡一次套用到所有學生。",
    side: "bottom",
    align: "center",
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
    description: "學生名單、共用照片與共用文字確認後，進入個人編輯逐位微調與輸出。",
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
    description: "這裡填入全班共用文案。清空會輸出空白；按恢復預設可回到模板文字，{name} 會在輸出時自動替換姓名。",
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
    description: "預覽會套用目前共用文字，確認文字位置與內容是否正確。",
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
    description: "共用文字填完後，進入個人編輯逐位補照片、覆寫文字、切換學生或輸出檔案。",
    side: "left",
    align: "center",
  },
];

const BATCH_PHOTO_GUIDE_STEPS = [
  {
    element: '[data-guide="batch-shared-photo-page"]',
    title: "選擇頁面",
    description: "先切到團體照或共用照片所在的相本頁面。",
    side: "bottom",
    align: "start",
  },
  {
    element: '[data-guide="batch-shared-photo-slots"]',
    title: "選擇照片格",
    description: "選一個照片格，系統會把同一張照片套用到所有學生的同一頁同一格。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="batch-shared-photo-upload"]',
    title: "套用到全班",
    description: "選擇照片後按套用，會覆蓋所有學生此格原本的照片；每位學生會各自保存一份，後續仍可個別調整。",
    side: "left",
    align: "center",
  },
  {
    element: '[data-guide="batch-review-link"]',
    title: "進入個人編輯",
    description: "共用照片套用後，進入個人編輯逐位確認裁切、補其他照片並輸出。",
    side: "left",
    align: "center",
  },
];

export default function ProjectBatch() {
  const { id: projectId } = useParams();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [desktopTab, setDesktopTab] = useState("students"); // "students" | "photos" | "texts"
  const [mobileTab, setMobileTab] = useState("students");   // "students" | "photos" | "edit" | "preview"

  // 行動版分頁切換時同步桌面 tab
  const handleMobileTabChange = (selectedTab) => {
    setMobileTab(selectedTab);
    setDesktopTab(selectedTab === "students" ? "students" : selectedTab === "photos" ? "photos" : "texts");
  };

  const startGuide = () => {
    startProductGuide(
      desktopTab === "students"
        ? BATCH_STUDENT_GUIDE_STEPS
        : desktopTab === "photos"
          ? BATCH_PHOTO_GUIDE_STEPS
          : BATCH_TEXT_GUIDE_STEPS
    );
  };

  // 學生名單 tab 狀態
  const [studentNamesInput, setStudentNamesInput] = useState("");
  const [isAddingStudents, setIsAddingStudents] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  // 共用照片 tab 狀態
  const sharedPhotoInputRef = useRef(null);
  const [selectedSharedPhotoSlotId, setSelectedSharedPhotoSlotId] = useState(null);
  const [sharedPhotoFile, setSharedPhotoFile] = useState(null);
  const [isSharedPhotoUploading, setIsSharedPhotoUploading] = useState(false);
  const [sharedPhotoUploadStatus, setSharedPhotoUploadStatus] = useState(null);

  // 批次照片分配 Modal
  const [isBatchWizardOpen, setIsBatchWizardOpen] = useState(false);

  // 對應文字 tab 狀態
  const [activePage, setActivePage] = useState(0);
  const [labelTexts, setLabelTexts] = useState({});  // { [pageIndex]: { [labelId]: text | { text, text_align } } }
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewTimestamp, setPreviewTimestamp] = useState(() => Date.now());

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

  useEffect(() => {
    if (!template) return;
    const pagePhotoSlots = template.pages[activePage]?.layout?.photo_slots || [];
    setSelectedSharedPhotoSlotId(previousSlotId =>
      pagePhotoSlots.some(slot => String(slot.id) === String(previousSlotId))
        ? previousSlotId
        : pagePhotoSlots[0]?.id ?? null
    );
  }, [template, activePage]);

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

  const clearSharedPhotoFile = () => {
    setSharedPhotoFile(null);
    if (sharedPhotoInputRef.current) sharedPhotoInputRef.current.value = "";
  };

  const handleUploadSharedPhoto = async () => {
    if (!sharedPhotoFile || selectedSharedPhotoSlotId == null || isSharedPhotoUploading) return;

    setIsSharedPhotoUploading(true);
    setSharedPhotoUploadStatus({ phase: "uploading", percent: 0 });
    try {
      const response = await uploadSharedProjectPhoto(
        projectId,
        activePage,
        selectedSharedPhotoSlotId,
        sharedPhotoFile,
        pct => setSharedPhotoUploadStatus({
          phase: pct >= 100 ? "processing" : "uploading",
          percent: pct,
        }),
      );
      const updated = response.data?.updated ?? 0;
      toast.success(`已套用到 ${updated} 位學生`);
      clearSharedPhotoFile();
      setPreviewTimestamp(Date.now());
      await loadProjectData();
    } catch (error) {
      handleApiError(error, "共用照片上傳失敗");
    } finally {
      setIsSharedPhotoUploading(false);
      setSharedPhotoUploadStatus(null);
    }
  };

  // ── 對應文字操作 ──────────────────────────────────────────────────────────

  const getLabelEntry = (pageIndex, labelId) =>
    labelTexts[pageIndex]?.[String(labelId)];

  const getLabelText = (pageIndex, labelId) =>
    getLabelEntryTextOverride(getLabelEntry(pageIndex, labelId)) ?? "";

  const getLabelAlign = (pageIndex, labelId, fallbackAlign = "center") =>
    getLabelEntryAlign(getLabelEntry(pageIndex, labelId), fallbackAlign);

  const hasLabelTextOverride = (pageIndex, labelId) =>
    hasLabelEntryTextOverride(getLabelEntry(pageIndex, labelId));

  const updateLabelEntry = (pageIndex, labelId, getNextEntry) => {
    const labelIdKey = String(labelId);
    setLabelTexts(prevTexts => {
      const currentPageTexts = { ...(prevTexts[pageIndex] || {}) };
      const nextEntry = getNextEntry(currentPageTexts[labelIdKey]);
      if (nextEntry === undefined) {
        delete currentPageTexts[labelIdKey];
      } else {
        currentPageTexts[labelIdKey] = nextEntry;
      }
      return { ...prevTexts, [pageIndex]: currentPageTexts };
    });
  };

  const setLabelText = (pageIndex, labelId, textValue, fallbackAlign = "center") => {
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withLabelEntryText(currentEntry, textValue, fallbackAlign)
    );
  };

  const setLabelAlign = (pageIndex, labelId, textAlign, fallbackAlign = "center") => {
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withLabelEntryAlign(currentEntry, textAlign, fallbackAlign)
    );
  };

  const restoreDefaultLabelText = (pageIndex, labelId, fallbackAlign = "center") => {
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withoutLabelEntryText(currentEntry, fallbackAlign)
    );
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
  const activePagePhotoSlots = activePageLayout?.photo_slots || [];
  const selectedSharedPhotoSlot = activePagePhotoSlots.find(
    slot => String(slot.id) === String(selectedSharedPhotoSlotId)
  );

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
              const defaultAlign = label.text_align ?? "center";
              const currentValue = getLabelText(activePage, label.id);
              const currentAlign = getLabelAlign(activePage, label.id, defaultAlign);
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
                      onChange={value => setLabelText(activePage, label.id, value, defaultAlign)}
                      onRestoreDefault={() => restoreDefaultLabelText(activePage, label.id, defaultAlign)}
                      onScheduleSave={scheduleSave}
                      buttonGuideId="batch-text-insert-name"
                      maxLength={200}
                    />
                    <TextAlignControl
                      value={currentAlign}
                      onChange={value => setLabelAlign(activePage, label.id, value, defaultAlign)}
                      onScheduleSave={scheduleSave}
                      className="mt-2"
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

  const sharedPhotoPanel = (
    <div className="max-w-4xl space-y-5">
      {/* Step 1：選擇頁面與照片格 */}
      <Surface data-guide="batch-shared-photo-page">
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">1</span>
          <h2 className="min-w-0 flex-1 text-sm font-semibold text-gray-800">選擇頁面與照片格</h2>
          <Badge tone="info">{project.students.length} 位</Badge>
        </div>

        {/* 頁面縮圖選擇器 */}
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          頁面
        </div>
        <div className="mb-4 grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {templatePages.map((_, pi) => {
            const isSelected = pi === activePage;
            return (
              <button
                key={pi}
                type="button"
                onClick={() => { if (pi !== activePage) setActivePage(pi); }}
                aria-pressed={isSelected}
                className={`group relative overflow-hidden rounded-md border bg-white transition-all ${
                  isSelected
                    ? "border-indigo-400 ring-2 ring-indigo-300"
                    : "border-gray-200 hover:border-indigo-200"
                }`}
                style={{ aspectRatio: "794/1123" }}
              >
                <img
                  src={`${buildProjectPagePreviewUrl(projectId, pi)}?t=${previewTimestamp}`}
                  alt={`第 ${pi + 1} 頁`}
                  className="absolute inset-0 h-full w-full object-cover"
                  draggable={false}
                  loading="lazy"
                />
                <span
                  className={`absolute inset-x-0 bottom-0 px-1 py-0.5 text-center text-[10px] font-semibold ${
                    isSelected ? "bg-indigo-600/85 text-white" : "bg-black/55 text-white"
                  }`}
                >
                  P{pi + 1}
                </span>
              </button>
            );
          })}
        </div>

        {/* 當前頁面的照片格 */}
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            照片格（第 {activePage + 1} 頁）
          </div>
        </div>
        {activePagePhotoSlots.length > 0 ? (
          <div
            data-guide="batch-shared-photo-slots"
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 2xl:grid-cols-5"
          >
            {activePagePhotoSlots.map((slot, slotIndex) => {
              const isSelected = String(slot.id) === String(selectedSharedPhotoSlotId);
              const slotItem = {
                pi: activePage, slotId: slot.id, slotIndex,
                slotW: slot.width || 400,
                slotH: slot.height || 400,
                border: slot.border ?? false,
                borderW: slot.border_width ?? 8,
                borderRadius: slot.border_radius ?? 0,
                shadowEnabled: slot.shadow_enabled,
                shadowOffsetX: slot.shadow_offset_x,
                shadowOffsetY: slot.shadow_offset_y,
                shadowBlur: slot.shadow_blur,
                shadowOpacity: slot.shadow_opacity,
                transform: { scale: 1, offsetX: 0, offsetY: 0 },
              };
              return (
                <button
                  key={slot.id}
                  type="button"
                  onClick={() => setSelectedSharedPhotoSlotId(slot.id)}
                  aria-pressed={isSelected}
                  className={`group flex aspect-square items-center justify-center rounded-lg border transition-all ${
                    isSelected
                      ? "border-indigo-400 bg-indigo-50/40 ring-2 ring-indigo-300"
                      : "border-gray-200 bg-gray-50 hover:border-indigo-200 hover:bg-indigo-50/30"
                  }`}
                >
                  <PhotoSlotCard it={slotItem} url={null} nat={null} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 py-10 text-sm text-gray-400">
            此頁沒有照片格
          </div>
        )}
      </Surface>

      {/* Step 2：選擇上傳模式 */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">2</span>
          <h2 className="text-sm font-semibold text-gray-800">選擇上傳模式</h2>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {/* 模式 A：所有人同一張（既有共用照片流程） */}
          <Surface data-guide="batch-shared-photo-upload" padding="md" className="flex flex-col">
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-800">所有人同一張</h3>
              <Badge tone="info">共用照片</Badge>
            </div>
            <p className="mb-3 text-xs text-gray-500">
              適用團體照、班級 logo 等所有學生共用的照片格。一張照片套用到全班。
            </p>

            <input
              ref={sharedPhotoInputRef}
              type="file"
              accept="image/*,.heic,.heif,.hif"
              className="hidden"
              onChange={event => setSharedPhotoFile(event.target.files?.[0] || null)}
            />

            <div className="mt-auto space-y-2">
              <Button
                type="button"
                onClick={() => sharedPhotoInputRef.current?.click()}
                variant="neutral"
                fullWidth
              >
                <Upload className="h-4 w-4" />
                選擇照片
              </Button>

              <div className="min-h-9 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                {sharedPhotoFile ? (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{sharedPhotoFile.name}</span>
                    <IconButton label="清除照片檔案" onClick={clearSharedPhotoFile} size="xs">
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ) : (
                  <span className="text-gray-400">未選擇照片</span>
                )}
              </div>

              <Button
                type="button"
                onClick={handleUploadSharedPhoto}
                disabled={
                  !sharedPhotoFile ||
                  !selectedSharedPhotoSlot ||
                  project.students.length === 0 ||
                  isSharedPhotoUploading
                }
                variant="primary"
                fullWidth
              >
                {isSharedPhotoUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
                套用到全班
              </Button>

              {sharedPhotoUploadStatus !== null && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{uploadStatusLabel(sharedPhotoUploadStatus)}</span>
                    <span>{sharedPhotoUploadStatus.percent}%</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-gray-100">
                    <div
                      className="h-full rounded-full bg-sky-500 transition-all duration-200"
                      style={{ width: `${sharedPhotoUploadStatus.percent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </Surface>

          {/* 模式 B：每人不同張（批次分配） */}
          <Surface
            data-guide="batch-photo-wizard-open"
            padding="md"
            className="flex flex-col border-indigo-200 bg-indigo-50/30"
          >
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-800">每人不同張</h3>
              <Badge tone="primary">批次分配</Badge>
            </div>
            <p className="mb-3 text-xs text-gray-600">
              一次上傳多張照片，系統可依檔名自動配對到對的學生（如 <code>小明.jpg</code>）；之後可拖曳調整。
            </p>

            <div className="mt-auto">
              <Button
                type="button"
                variant="primary"
                fullWidth
                onClick={() => setIsBatchWizardOpen(true)}
                disabled={
                  project.students.length === 0 ||
                  !selectedSharedPhotoSlot
                }
              >
                <ImagePlus className="h-4 w-4" />
                開始批次分配
              </Button>
              {!selectedSharedPhotoSlot && (
                <p className="mt-2 text-[11px] text-amber-700">
                  ⚠ 請先在上方選擇一個照片格
                </p>
              )}
            </div>
          </Surface>
        </div>
      </div>
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
      <BatchPhotoWizard
        isOpen={isBatchWizardOpen}
        projectId={projectId}
        template={template}
        students={project.students}
        pageIndex={activePage}
        slotId={selectedSharedPhotoSlotId}
        onClose={() => setIsBatchWizardOpen(false)}
        onUploaded={() => {
          setPreviewTimestamp(Date.now());
          loadProjectData();
        }}
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
          { value: "photos",   label: "照片", icon: ImagePlus },
          { value: "edit",     label: "文字", icon: Type },
          { value: "preview",  label: "預覽", icon: Eye },
        ]}
      />

      {/* 桌面版 Pill 分頁（不含預覽，預覽在側欄常駐） */}
      <SegmentedControl
        value={desktopTab}
        onChange={setDesktopTab}
        options={[
          { value: "students", label: "登記", icon: Users, guideId: "batch-students-tab" },
          { value: "photos", label: "照片", icon: ImagePlus, guideId: "batch-photos-tab" },
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

      {/* Tab 2：全班共用照片 */}
      {desktopTab === "photos" && sharedPhotoPanel}

      {/* Tab 3：對應文字（桌面版：左預覽 | 右編輯；行動版：分頁切換） */}
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
