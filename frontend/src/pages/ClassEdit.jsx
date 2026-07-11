// 相本編輯器 — 全班共用 scope
// 與學生編輯頁（StudentEdit）共用同一套三欄工作台佈局與 ScopeSwitcher，
// 但資料層換成專案層級：共用照片（策略選擇＋批次/共用上傳）與共用文字（防抖 600ms 自動儲存）。
// 全班模式以紫色橫幅與框線標示，防止「以為在改一個人、其實改到全班」

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { fetchProject, updateProjectLabelTexts, uploadSharedProjectPhoto } from "../api/projectApi";
import { fetchTemplate } from "../api/templateApi";
import { buildProjectPagePreviewUrl } from "../api/urls";
import { useAutoSave } from "../hooks/useAutoSave";
import { usePermissions } from "../hooks/usePermissions";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Crop,
  Eye,
  ImagePlus,
  Loader2,
  RefreshCw,
  Type,
  Upload,
  Users,
  X,
} from "lucide-react";
import AlbumPageNav from "../components/AlbumPageNav";
import BatchPhotoWizard from "../components/BatchPhotoWizard";
import FormModal from "../components/FormModal";
import ImageCropModal from "../components/ImageCropModal";
import PanelSwitcher from "../components/PanelSwitcher";
import PhotoSlotCard from "../components/PhotoSlotCard";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import ScopeSwitcher from "../components/ScopeSwitcher";
import TextAlignControl from "../components/TextAlignControl";
import TextVariableTextarea from "../components/TextVariableTextarea";
import { Badge, Button, IconButton, PageHeader, Surface, fieldControlClass } from "../components/ui";
import { getPhotoFrameRect, getPhotoSlotDimensionMode } from "../utils/photoFrameGeometry.js";
import { getPhotoCropBox } from "../utils/photoUtils";
import { handleApiError } from "../utils/apiError";
import { startProductGuide } from "../utils/productGuide";
import {
  getLabelEntryAlign,
  getLabelEntryTextOverride,
  hasLabelEntryTextOverride,
  withLabelEntryAlign,
  withLabelEntryText,
  withoutLabelEntryText,
} from "../utils/labelTextEntries";
import { filterFillableLabelTexts, getFillableTextLabels } from "../utils/textLabelRoles";

function uploadStatusLabel(status) {
  if (!status) return "";
  if (status.phase === "processing") return "處理中";
  return "上傳中";
}

const CLASS_EDIT_GUIDE_STEPS = [
  {
    element: '[data-guide="scope-switcher"]',
    title: "編輯範圍",
    description: "現在是「全班」：改的內容會套用到所有學生。按「個別」切到單一學生微調，同一個編輯器不用換頁。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="class-page-nav"]',
    title: "切換頁面",
    description: "整頁一起換：預覽、照片格與文字都會跟著切到同一頁。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="class-photo-panel"]',
    title: "全班照片",
    description: "點一個照片格，會開視窗選分配方式：「每人不同張」一次上傳多張自動分給學生；「全班同一張」把團體照套用到全班同一格。行政命名好的整批檔案用右上的「依檔名整批匯入」。",
    side: "left",
    align: "start",
  },
  {
    element: '[data-guide="class-text-panel"]',
    title: "全班文字",
    description: "這裡填全班共用文案，{name} 會自動代入各學生姓名；清空會輸出空白，按恢復預設可回到模板文字。",
    side: "left",
    align: "start",
  },
  {
    element: '[data-guide="class-preview-panel"]',
    title: "樣版預覽",
    description: "套用目前共用文字的樣版預覽，確認文字位置與內容。",
    side: "right",
    align: "center",
  },
];

export default function ClassEdit() {
  const { id: projectId } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [activePage, setActivePage] = useState(0);
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"
  const [labelTexts, setLabelTexts] = useState({});  // { [pageIndex]: { [labelId]: text | { text, text_align } } }
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewTimestamp, setPreviewTimestamp] = useState(() => Date.now());

  // 共用照片狀態
  const sharedPhotoInputRef = useRef(null);
  const [selectedSharedPhotoSlotId, setSelectedSharedPhotoSlotId] = useState(null);
  const [sharedPhotoFile, setSharedPhotoFile] = useState(null);
  const [isSharedPhotoUploading, setIsSharedPhotoUploading] = useState(false);
  const [sharedPhotoUploadStatus, setSharedPhotoUploadStatus] = useState(null);
  const [isBatchWizardOpen, setIsBatchWizardOpen] = useState(false);
  const [isFilenameBatchWizardOpen, setIsFilenameBatchWizardOpen] = useState(false);
  // 選格後的後續處理（選分配方式＋上傳）在 Modal 內進行
  const [isSlotPhotoModalOpen, setIsSlotPhotoModalOpen] = useState(false);
  // 照片分配方式：null＝尚未選擇（Modal 開啟時重置）
  const [photoStrategy, setPhotoStrategy] = useState(null);
  // 共用照片的裁切編輯視窗
  const [isSharedCropOpen, setIsSharedCropOpen] = useState(false);
  // 批次分配精靈是否有實際上傳：沒上傳就關閉時要退回放照片 Modal（可回上一步）
  const batchWizardDidUploadRef = useRef(false);
  // 共用照片預覽 URL（objectURL，換檔或清除時釋放）
  const [sharedPhotoPreviewUrl, setSharedPhotoPreviewUrl] = useState(null);
  useEffect(() => {
    if (!sharedPhotoFile) {
      setSharedPhotoPreviewUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(sharedPhotoFile);
    setSharedPhotoPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [sharedPhotoFile]);

  // ── 自動儲存共用文字（防抖 600ms） ────────────────────────────────────────

  const { scheduleSave, flushSave, saveStatus } = useAutoSave(
    labelTexts,
    async (currentLabelTexts, signal) => {
      const payload = {};
      Object.entries(currentLabelTexts).forEach(([pageIndex, labels]) => {
        payload[String(pageIndex)] = labels;
      });
      // 帶 abort signal：新的儲存會取消還在路上的舊請求，避免舊值後到蓋掉新值
      await updateProjectLabelTexts(projectId, payload, signal);
      setPreviewTimestamp(Date.now());
    },
    600
  );

  // SPA 導航離開本頁時，若防抖存檔尚未觸發就立即補送，避免最後一段輸入遺失
  const saveStatusRef = useRef(saveStatus);
  useEffect(() => { saveStatusRef.current = saveStatus; });
  useEffect(() => () => {
    if (saveStatusRef.current === "pending") flushSave().catch(() => {});
  }, [flushSave]);

  // ── 資料載入 ──────────────────────────────────────────────────────────────

  const loadProjectData = useCallback(async () => {
    try {
      const projectResponse = await fetchProject(projectId);
      setProject(projectResponse.data);

      const templateResponse = await fetchTemplate(projectResponse.data.template_id);
      setTemplate(templateResponse.data);

      // 初始化共用文字狀態：只保存專案覆寫；未覆寫時由預覽/渲染使用模板預設。
      // 有未儲存的文字編輯（照片上傳後的重載會經過這裡）時不得用伺服器舊值蓋掉
      if (!["pending", "saving"].includes(saveStatusRef.current)) {
        const savedProjectLabelTexts = projectResponse.data.label_texts || {};
        const initialLabelTexts = {};
        templateResponse.data.pages.forEach((templatePage, pageIndex) => {
          initialLabelTexts[pageIndex] = filterFillableLabelTexts(
            templatePage.layout?.text_labels || [],
            savedProjectLabelTexts[String(pageIndex)] || {}
          );
        });
        setLabelTexts(initialLabelTexts);
      }
    } catch {
      setLoadError("找不到專案，請確認連結是否正確");
    }
  }, [projectId]);

  useEffect(() => { loadProjectData(); }, [loadProjectData]);

  // 路由守衛只擋角色、擋不了擁有權：非 owner（如別班主管）直接輸入網址
  // 會看到可編輯 UI 但每次寫入都被後端 403，這裡直接轉去唯讀的班級總覽
  const { canEditProject } = usePermissions();
  useEffect(() => {
    if (!project) return;
    if (!canEditProject(project.owner_id)) {
      toast.error("你沒有此專案的編輯權限，已切到班級總覽");
      navigate(`/projects/${projectId}/review`, { replace: true });
    }
  }, [project, canEditProject, navigate, projectId]);

  // 專案已標記全班完成：照片/文字鎖定（主管或 admin 退回後恢復）
  const isProjectCompleted = Boolean(project?.completed_at);

  useEffect(() => {
    if (!template) return;
    const pagePhotoSlots = template.pages[activePage]?.layout?.photo_slots || [];
    setSelectedSharedPhotoSlotId(previousSlotId =>
      pagePhotoSlots.some(slot => String(slot.id) === String(previousSlotId))
        ? previousSlotId
        : pagePhotoSlots[0]?.id ?? null
    );
  }, [template, activePage]);

  // ── 共用照片上傳 ──────────────────────────────────────────────────────────

  const clearSharedPhotoFile = () => {
    setSharedPhotoFile(null);
    if (sharedPhotoInputRef.current) sharedPhotoInputRef.current.value = "";
  };

  // 點照片格 → 開 Modal（每次都從「選分配方式」開始，並清掉上次殘留的檔案）
  const openSlotPhotoModal = (slotId) => {
    setSelectedSharedPhotoSlotId(slotId);
    setPhotoStrategy(null);
    clearSharedPhotoFile();
    setIsSlotPhotoModalOpen(true);
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
      setIsSlotPhotoModalOpen(false);
      setPreviewTimestamp(Date.now());
      await loadProjectData();
    } catch (error) {
      handleApiError(error, "共用照片上傳失敗");
    } finally {
      setIsSharedPhotoUploading(false);
      setSharedPhotoUploadStatus(null);
    }
  };

  // ── 共用文字操作 ──────────────────────────────────────────────────────────

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

  // ── 切換範圍（全班 → 學生） ──────────────────────────────────────────────

  const handleScopeSwitch = async (targetStudentId) => {
    if (targetStudentId == null) return; // 已在全班 scope
    try {
      await flushSave();
      navigate(`/projects/${projectId}/students/${targetStudentId}/edit`);
    } catch {
      toast.error("切換前儲存失敗");
    }
  };

  const startGuide = () => {
    startProductGuide(CLASS_EDIT_GUIDE_STEPS);
  };

  // ── 載入中 / 錯誤狀態 ─────────────────────────────────────────────────────

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
  const pageCount = templatePages.length;
  const activePageLayout = templatePages[activePage]?.layout;
  const activePageTextLabels = getFillableTextLabels(activePageLayout);
  const activePagePhotoSlots = activePageLayout?.photo_slots || [];
  const selectedSharedPhotoSlot = activePagePhotoSlots.find(
    slot => String(slot.id) === String(selectedSharedPhotoSlotId)
  );

  // ── 預覽面板（專案層級樣版預覽） ─────────────────────────────────────────

  const previewPanel = (
    <div className="space-y-3 lg:sticky lg:top-20" data-guide="class-preview-panel">
      <Surface padding="none" className="overflow-hidden border-violet-200">
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

  // ── 照片面板（策略選擇 → 選格 → 上傳） ──────────────────────────────────

  // 照片卡固定 110px 高、寬依格位長寬比（見 PhotoSlotCard），
  // 取最寬者決定格線欄寬，避免寬格位在窄欄溢出（作法同 PhotoManager）
  const slotItems = activePagePhotoSlots.map((slot, slotIndex) => {
    const frameRect = getPhotoFrameRect(slot, { dimensionMode: getPhotoSlotDimensionMode(activePageLayout) });
    return {
      pi: activePage, slotId: slot.id, slotIndex,
      slotW: frameRect.width || 400,
      slotH: frameRect.height || 400,
      border: slot.border !== false,
      borderW: slot.border_width ?? 8,
      borderRadius: slot.border_radius ?? 0,
      shadowEnabled: slot.shadow_enabled,
      shadowOffsetX: slot.shadow_offset_x,
      shadowOffsetY: slot.shadow_offset_y,
      shadowBlur: slot.shadow_blur,
      shadowOpacity: slot.shadow_opacity,
      transform: { scale: 1, offsetX: 0, offsetY: 0 },
    };
  });
  const maxSlotCardWidth = slotItems.length
    ? Math.max(...slotItems.map(item => Math.round(110 * item.slotW / item.slotH)))
    : 110;

  const slotPickerSection = (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-gray-800">
          點一個照片格開始放照片
        </h3>
        <Badge tone="neutral">{project.students.length} 位</Badge>
      </div>
      {slotItems.length > 0 ? (
        <div
          data-guide="class-shared-photo-slots"
          className="grid gap-3"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(min(${maxSlotCardWidth + 24}px, 100%), 1fr))`,
          }}
        >
          {slotItems.map(slotItem => {
            const isSelected = String(slotItem.slotId) === String(selectedSharedPhotoSlotId);
            return (
              <button
                key={slotItem.slotId}
                type="button"
                onClick={() => openSlotPhotoModal(slotItem.slotId)}
                aria-pressed={isSelected}
                className={`group flex items-center justify-center rounded-lg border p-3 transition-all ${
                  isSelected
                    ? "border-violet-400 bg-violet-50/40 ring-2 ring-violet-300"
                    : "border-gray-200 bg-gray-50 hover:border-violet-200 hover:bg-violet-50/30"
                }`}
              >
                <PhotoSlotCard it={slotItem} url={null} nat={null} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 py-10 text-sm text-gray-400">
          此頁沒有照片格，請用上方頁碼切到有照片格的頁面
        </div>
      )}
    </div>
  );

  const photoPanel = (
    <div data-guide="class-photo-panel">
      {isProjectCompleted ? (
        <Surface className="border-emerald-200 bg-emerald-50 text-sm text-emerald-800">
          此專案已標記全班完成，照片上傳已鎖定；仍可預覽與下載，需主管或管理員退回才能修改。
        </Surface>
      ) : project.students.length === 0 ? (
        <Surface className="border-violet-200">
          <div className="py-8 text-center text-gray-400">
            <Users className="mx-auto mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">尚未新增任何學生</p>
            <p className="mt-1 text-xs">先在班級總覽新增學生名單，再回來放全班照片。</p>
            <Button as={Link} to={`/projects/${projectId}/review`} variant="primary" className="mt-4">
              <Users className="h-4 w-4" />
              回班級總覽新增名單
            </Button>
          </div>
        </Surface>
      ) : (
        <Surface className="space-y-4 border-violet-200">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-gray-900">全班照片 — 第 {activePage + 1} 頁</h2>
            {/* 進階入口：檔名已含頁碼與格位的整批檔案，獨立於選格流程之外 */}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              title="檔名需含姓名與格位，例如 小明1-2.jpg＝第 1 頁第 2 格"
              onClick={() => setIsFilenameBatchWizardOpen(true)}
            >
              <ImagePlus className="h-3.5 w-3.5" />
              依檔名整批匯入
            </Button>
          </div>

          {slotPickerSection}
        </Surface>
      )}
    </div>
  );

  // 選格後的後續處理：選分配方式＋上傳，集中在 Modal 內互動
  const selectedSlotIndex = slotItems.findIndex(
    item => String(item.slotId) === String(selectedSharedPhotoSlotId)
  );
  const selectedSlotItem = selectedSlotIndex >= 0 ? slotItems[selectedSlotIndex] : null;
  // 預覽與裁切都用「照片內容框」而非外框：外框含邊框寬，
  // 比例不同時後端會再做一次 cover 裁切導致構圖偏移
  const selectedSlotCropBox = selectedSlotItem ? getPhotoCropBox(selectedSlotItem) : null;
  const slotPhotoModal = (
    <FormModal
      isOpen={isSlotPhotoModalOpen}
      title={`放照片：第 ${activePage + 1} 頁・格 ${selectedSlotIndex >= 0 ? selectedSlotIndex + 1 : "-"}`}
      onClose={() => {
        // 裁切視窗疊在上面時 Esc 會先打到這層；上傳中也不可關閉（檔案與進度會憑空消失）
        if (isSharedCropOpen || isSharedPhotoUploading) return;
        setIsSlotPhotoModalOpen(false);
      }}
    >
      <div data-guide="class-slot-photo-modal" className="space-y-4">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">1</span>
              <h3 className="text-sm font-semibold text-gray-800">選擇分配方式</h3>
            </div>
            <div data-guide="class-photo-strategies" className="grid gap-2 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setPhotoStrategy("individual")}
                aria-pressed={photoStrategy === "individual"}
                className={`rounded-xl border p-3 text-left transition-all ${
                  photoStrategy === "individual"
                    ? "border-violet-400 bg-violet-50/50 ring-2 ring-violet-300"
                    : "border-gray-200 bg-white hover:border-violet-200 hover:bg-violet-50/30"
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <h4 className="text-sm font-bold text-gray-900">每人不同張</h4>
                  <Badge tone="primary">最常用</Badge>
                </div>
                <p className="text-xs leading-relaxed text-gray-600">
                  每位學生這一格放自己的照片，一次上傳多張自動分配。
                </p>
              </button>
              <button
                type="button"
                onClick={() => setPhotoStrategy("shared")}
                aria-pressed={photoStrategy === "shared"}
                className={`rounded-xl border p-3 text-left transition-all ${
                  photoStrategy === "shared"
                    ? "border-violet-400 bg-violet-50/50 ring-2 ring-violet-300"
                    : "border-gray-200 bg-white hover:border-violet-200 hover:bg-violet-50/30"
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <h4 className="text-sm font-bold text-gray-900">全班同一張</h4>
                </div>
                <p className="text-xs leading-relaxed text-gray-600">
                  團體照等共用照片，一張套用到全班這一格。
                </p>
              </button>
            </div>
          </div>

          {/* 上傳（選了方式才出現） */}
          {photoStrategy !== null && (
          <div>
            <div className="mb-3 flex items-center gap-2">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">2</span>
              <h3 className="text-sm font-semibold text-gray-800">
                {photoStrategy === "shared" ? "選擇照片並套用到全班" : "上傳並分配照片"}
              </h3>
            </div>

            {photoStrategy === "shared" ? (
              <div className="space-y-2">
                <input
                  ref={sharedPhotoInputRef}
                  type="file"
                  accept="image/*,.heic,.heif,.hif"
                  className="hidden"
                  onChange={event => setSharedPhotoFile(event.target.files?.[0] || null)}
                />
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
                {/* 預覽（照片格比例）＋裁切編輯 */}
                {sharedPhotoFile && sharedPhotoPreviewUrl && selectedSlotItem && (
                  <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-2">
                    <div
                      className="relative flex-shrink-0 overflow-hidden rounded-md border border-gray-200 bg-white"
                      style={{
                        width: 132,
                        aspectRatio: `${Math.max(1, Math.round(selectedSlotCropBox?.width ?? selectedSlotItem.slotW))} / ${Math.max(1, Math.round(selectedSlotCropBox?.height ?? selectedSlotItem.slotH))}`,
                      }}
                    >
                      <img
                        src={sharedPhotoPreviewUrl}
                        alt="共用照片預覽"
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="text-xs leading-relaxed text-gray-500">
                        預覽為照片格比例，超出範圍會置中裁切；要調整位置與縮放按下方編輯。
                      </p>
                      <Button type="button" variant="neutral" size="sm" onClick={() => setIsSharedCropOpen(true)}>
                        <Crop className="h-4 w-4" />
                        編輯裁切
                      </Button>
                    </div>
                  </div>
                )}
                <Button
                  type="button"
                  onClick={handleUploadSharedPhoto}
                  disabled={!sharedPhotoFile || !selectedSharedPhotoSlot || isSharedPhotoUploading}
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
            ) : (
              <div>
                <p className="mb-3 text-xs leading-relaxed text-gray-600">
                  一次上傳多張照片，依檔名或名單順序配給不同學生，全部放到這個照片格。
                </p>
                <Button
                  type="button"
                  variant="primary"
                  fullWidth
                  onClick={() => {
                    batchWizardDidUploadRef.current = false;
                    setIsSlotPhotoModalOpen(false);
                    setIsBatchWizardOpen(true);
                  }}
                  disabled={!selectedSharedPhotoSlot}
                >
                  <ImagePlus className="h-4 w-4" />
                  選擇照片並開始分配
                </Button>
              </div>
            )}
          </div>
          )}
      </div>
    </FormModal>
  );

  // ── 文字面板（全班共用文字） ─────────────────────────────────────────────

  const textPanel = (
    <div data-guide="class-text-panel">
      {activePageTextLabels.length > 0 ? (
        <Surface className="border-violet-200">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <Type className="w-4 h-4 text-violet-500" />
            <h3 className="font-semibold text-gray-800 text-sm">
              全班文字 — 第 {activePage + 1} 頁
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
                  <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center flex-shrink-0 mt-1">
                    <span className="text-xs font-bold text-violet-400">{label.id}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <TextVariableTextarea
                      rows={2}
                      disabled={isProjectCompleted}
                      className={`${fieldControlClass} resize-none disabled:opacity-60`}
                      placeholder={templateDefaultText}
                      value={currentValue}
                      defaultText={templateDefaultText}
                      inheritedValue={templateDefaultText}
                      hasOverride={hasOverride}
                      onChange={value => setLabelText(activePage, label.id, value, defaultAlign)}
                      onRestoreDefault={() => restoreDefaultLabelText(activePage, label.id, defaultAlign)}
                      onScheduleSave={scheduleSave}
                      buttonGuideId="class-text-insert-name"
                      maxLength={200}
                    />
                    {!isProjectCompleted && (
                      <TextAlignControl
                        value={currentAlign}
                        onChange={value => setLabelAlign(activePage, label.id, value, defaultAlign)}
                        onScheduleSave={scheduleSave}
                        className="mt-2"
                      />
                    )}
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
        <Surface className="flex items-center justify-center border-violet-200 py-10 text-sm text-gray-400">
          此頁沒有可填文字
        </Surface>
      )}
    </div>
  );

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      <BatchPhotoWizard
        isOpen={isBatchWizardOpen}
        projectId={projectId}
        template={template}
        students={project.students}
        scope="slot"
        pageIndex={activePage}
        slotId={selectedSharedPhotoSlotId}
        onClose={() => {
          setIsBatchWizardOpen(false);
          // 沒有實際上傳就關閉＝想回上一步，退回放照片 Modal
          if (!batchWizardDidUploadRef.current) setIsSlotPhotoModalOpen(true);
        }}
        onUploaded={() => {
          batchWizardDidUploadRef.current = true;
          setPreviewTimestamp(Date.now());
          loadProjectData();
        }}
      />
      <BatchPhotoWizard
        isOpen={isFilenameBatchWizardOpen}
        projectId={projectId}
        template={template}
        students={project.students}
        scope="filename"
        pageIndex={activePage}
        slotId={null}
        onClose={() => setIsFilenameBatchWizardOpen(false)}
        onUploaded={() => {
          setPreviewTimestamp(Date.now());
          loadProjectData();
        }}
      />
      {slotPhotoModal}
      {/* 共用照片裁切：輸出即照片格比例（後續預覽與渲染即所見即所得） */}
      {isSharedCropOpen && sharedPhotoFile && selectedSlotItem && (
        <ImageCropModal
          file={sharedPhotoFile}
          // 內容框比例 ×3 解析度：794 版面像素直出對列印（300dpi）太低會糊
          targetWidth={Math.max(1, Math.round((selectedSlotCropBox?.width ?? selectedSlotItem.slotW) * 3))}
          targetHeight={Math.max(1, Math.round((selectedSlotCropBox?.height ?? selectedSlotItem.slotH) * 3))}
          title="編輯共用照片"
          hint="拖曳移動 · 滾輪縮放，裁切範圍即照片格比例"
          onConfirm={(croppedFile) => {
            setSharedPhotoFile(croppedFile);
            setIsSharedCropOpen(false);
          }}
          onCancel={() => setIsSharedCropOpen(false)}
        />
      )}

      <PageHeader
        title={project.name}
        badge={<Badge tone="review">編輯相本</Badge>}
        meta={(
          <>
            <span className="hidden sm:inline-flex">
              <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
                相本專案
              </Button>
            </span>
            <ChevronRight className="hidden h-3.5 w-3.5 flex-shrink-0 text-gray-300 sm:block" />
            <Button
              as={Link}
              to={`/projects/${projectId}/review`}
              variant="ghost"
              size="xs"
              className="min-w-0 text-gray-400"
            >
              <ChevronLeft className="inline h-3.5 w-3.5 sm:hidden" />
              <span className="inline-block max-w-[14rem] truncate align-bottom sm:max-w-none">班級總覽</span>
            </Button>
          </>
        )}
        actions={(
          <ResponsiveActionGroup mobileColumns={1}>
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

      {isProjectCompleted ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span className="font-medium">此專案已標記全班完成，內容已鎖定</span>
          <span className="text-emerald-600">仍可預覽；需主管或管理員退回才能修改</span>
        </div>
      ) : (
        /* 全班 scope 常駐提醒：防止「以為在改一個人、其實改到全班」 */
        <div
          data-guide="class-scope-banner"
          className="mb-4 flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900"
        >
          <Users className="h-4 w-4 flex-shrink-0 text-violet-500" />
          <span>
            正在編輯<span className="font-semibold">全班共用</span>內容：這裡的變更會套用到所有學生
            <span className="hidden text-violet-600 sm:inline">（已個別調整過的學生不受影響）</span>
          </span>
        </div>
      )}

      <ScopeSwitcher
        students={project.students || []}
        currentStudentId={null}
        onSwitch={handleScopeSwitch}
        isBusy={isSharedPhotoUploading}
        saveStatus={saveStatus}
        backTo={`/projects/${projectId}/review`}
      />

      {/* 行動裝置分頁切換 */}
      <PanelSwitcher
        value={mobileTab}
        onChange={setMobileTab}
        tabs={[
          { value: "photo",   label: "照片", icon: Camera },
          { value: "text",    label: "文字", icon: Type },
          { value: "preview", label: "預覽", icon: Eye },
        ]}
      />

      {/* 全域頁碼導航：預覽、照片、文字三個面板同步跟著同一頁；
          行動版跟著分頁列一起 sticky，往下捲仍看得到目前頁碼 */}
      {pageCount > 1 && (
        <div
          className="mb-4 max-lg:sticky max-lg:top-14 max-lg:z-10 max-lg:-mx-4 max-lg:bg-[#f8fafc]/95 max-lg:px-4 max-lg:pb-2 max-lg:backdrop-blur-sm"
          data-guide="class-page-nav"
        >
          <AlbumPageNav page={activePage} total={pageCount} onChange={setActivePage} />
        </div>
      )}

      {/* 桌面版：預覽 / 照片 / 文字工作台；行動版：單頁面板切換 */}
      <div className="lg:grid lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)] lg:gap-6 lg:items-start xl:grid-cols-[minmax(280px,0.85fr)_minmax(360px,1.15fr)_minmax(320px,0.9fr)]">
        <div className={`lg:col-start-1 lg:row-span-2 xl:row-span-1 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`}>
          {previewPanel}
        </div>
        <div className={`lg:col-start-2 lg:row-start-1 lg:min-w-0 xl:col-start-2 ${mobileTab === "photo" ? "block" : "hidden lg:block"}`}>
          {photoPanel}
        </div>
        <div className={`lg:col-start-2 lg:row-start-2 lg:min-w-0 xl:sticky xl:top-20 xl:col-start-3 xl:row-start-1 ${mobileTab === "text" ? "block" : "hidden lg:block"}`}>
          {textPanel}
        </div>
      </div>
    </div>
  );
}
