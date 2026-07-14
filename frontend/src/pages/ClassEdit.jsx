// 相本編輯器 — 全班共用 scope
// 與學生編輯頁（StudentEdit）共用同一套三欄工作台佈局與 ScopeSwitcher，
// 但資料層換成專案層級：共用照片（選格→分配方式 Modal）與共用文字（防抖 600ms 自動儲存）

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { fetchProject, updateProjectLabelTexts, uploadSharedProjectPhoto } from "../api/projectApi";
import { fetchProjectTemplatePair } from "../api/templateApi";
import { appendPreviewCacheVersion, buildProjectPagePreviewUrl } from "../api/urls";
import { useAutoSave } from "../hooks/useAutoSave";
import { useLabelTextsEditor } from "../hooks/useLabelTextsEditor";
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
  X,
} from "lucide-react";
import AlbumPageNav from "../components/AlbumPageNav";
import BatchPhotoWizard from "../components/BatchPhotoWizard";
import ClassPhotoPanel from "../components/ClassPhotoPanel";
import ClassPhotoStrategyPicker from "../components/ClassPhotoStrategyPicker";
import ClassTextPanel from "../components/ClassTextPanel";
import FormModal from "../components/FormModal";
import ImageCropModal from "../components/ImageCropModal";
import PanelSwitcher from "../components/PanelSwitcher";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import ScopeSwitcher from "../components/ScopeSwitcher";
import PagePreview from "../components/PagePreview";
import { Badge, Button, IconButton, PageHeader } from "../components/ui";
import { getPhotoFrameRect, getPhotoSlotDimensionMode } from "../utils/photoFrameGeometry.js";
import { getPhotoCropBox } from "../utils/photoUtils";
import { handleApiError, isProjectTemplateRevisionError } from "../utils/apiError";
import { getVisibleLayoutElements } from "../utils/layoutLayerState.js";
import { startProductGuide } from "../utils/productGuide";
import { filterFillableLabelTexts, getFillableTextLabels } from "../utils/textLabelRoles";

function uploadStatusLabel(status) {
  if (!status) return "";
  if (status.phase === "processing") return "處理中";
  return "上傳中";
}


export default function ClassEdit() {
  const { id: projectId } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [activePage, setActivePage] = useState(0);
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"
  // 共用文字（label_texts）state 與讀寫操作，抽至共用 Hook 與 StudentEdit 同步維護
  const {
    labelTexts, setLabelTexts,
    getLabelText, getLabelAlign, hasLabelTextOverride,
    setLabelText, setLabelAlign, restoreDefaultLabelText,
  } = useLabelTextsEditor();
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
      try {
        await updateProjectLabelTexts(projectId, project?.template_revision, payload, signal);
      } catch (error) {
        if (isProjectTemplateRevisionError(error)) handleApiError(error);
        throw error;
      }
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
      const { projectData, templateResponse } = await fetchProjectTemplatePair(
        () => fetchProject(projectId),
      );
      setProject(projectData);
      // 預覽 URL 版本戳跟著 updated_at 走，內容沒變時瀏覽器快取可命中
      if (projectData.updated_at) {
        setPreviewTimestamp(new Date(projectData.updated_at).getTime() || Date.now());
      }

      // 全班↔個別編輯互切時模板走 revision cache；若兩次 GET 間剛好
      // 同步升版，共用 loader 會重抓到一致的 project/template pair。
      setTemplate(templateResponse.data);

      // 初始化共用文字狀態：只保存專案覆寫；未覆寫時由預覽/渲染使用模板預設。
      // 有未儲存的文字編輯（照片上傳後的重載會經過這裡）時不得用伺服器舊值蓋掉
      if (!["pending", "saving"].includes(saveStatusRef.current)) {
        const savedProjectLabelTexts = projectData.label_texts || {};
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
    // setLabelTexts 來自 useLabelTextsEditor（底層是 useState setter，恆穩定），列入只為滿足 lint
  }, [projectId, setLabelTexts]);

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
    const pagePhotoSlots = getVisibleLayoutElements(template.pages[activePage]?.layout, "photo");
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
        project.template_revision,
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

  // ── 切換範圍（全班 → 學生） ──────────────────────────────────────────────

  const handleScopeSwitch = async (targetStudentId) => {
    if (targetStudentId == null) return; // 已在全班 scope
    try {
      await flushSave();
      navigate(`/projects/${projectId}/students/${targetStudentId}/edit`);
    } catch (error) {
      if (!isProjectTemplateRevisionError(error)) toast.error("切換前儲存失敗");
    }
  };

  const startGuide = () => {
    // 動態步驟：教學會實際打開「放照片」Modal 示範選分配方式與上傳，
    // 結束（或中途關閉）時自動把 Modal 收掉
    const firstSlot = getVisibleLayoutElements(template?.pages[activePage]?.layout, "photo")[0];
    const canDemoSlotModal = Boolean(firstSlot) && !isProjectCompleted;

    const steps = [
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
        title: "照片管理（全班）",
        description: "點一個照片格就會開「放照片」視窗——接下來直接開給你看。行政命名好的整批檔案用右上的「依檔名整批匯入」。",
        side: "left",
        align: "start",
        // 行動版面板是分頁制：導覽自己切到對的分頁（桌機三欄常駐、不受影響）
        onBeforeStep: () => { setIsSlotPhotoModalOpen(false); setMobileTab("photo"); },
      },
      ...(canDemoSlotModal ? [
        {
          element: '[data-guide="class-slot-photo-modal"]',
          title: "放照片視窗",
          description: "選格後在這個視窗完成所有事：先選分配方式，再上傳。",
          side: "top",
          align: "center",
          onBeforeStep: () => { openSlotPhotoModal(firstSlot.id); },
        },
        {
          element: '[data-guide="class-photo-strategies"]',
          title: "選擇分配方式",
          description: "「每人不同張」一次上傳多張、自動分給每位學生（最常用）；「全班同一張」把團體照套用到全班同一格。",
          side: "bottom",
          align: "center",
          onBeforeStep: () => { openSlotPhotoModal(firstSlot.id); },
        },
        {
          element: '[data-guide="class-slot-photo-upload"]',
          title: "上傳照片",
          description: "選了方式後在這裡上傳：「每人不同張」會開批次分配精靈，可依檔名自動配對；「全班同一張」可先預覽、裁切再套用到全班。",
          side: "top",
          align: "center",
          onBeforeStep: () => {
            openSlotPhotoModal(firstSlot.id);
            setPhotoStrategy("individual");
          },
        },
      ] : []),
      {
        element: '[data-guide="class-text-panel"]',
        title: "全班文字",
        description: "這裡填全班共用文案，{name} 會自動代入各學生姓名；清空會輸出空白，按恢復預設可回到模板文字。",
        side: "left",
        align: "start",
        onBeforeStep: () => { setIsSlotPhotoModalOpen(false); setMobileTab("text"); },
      },
      {
        element: '[data-guide="class-preview-panel"]',
        title: "頁面預覽",
        description: "套用目前共用文字的樣版預覽，確認文字位置與內容；可按重新整理預覽。",
        side: "right",
        align: "center",
        onBeforeStep: () => { setMobileTab("preview"); },
      },
    ];

    startProductGuide(steps, { onFinish: () => setIsSlotPhotoModalOpen(false) });
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
  const activePagePhotoSlots = getVisibleLayoutElements(activePageLayout, "photo");
  const selectedSharedPhotoSlot = activePagePhotoSlots.find(
    slot => String(slot.id) === String(selectedSharedPhotoSlotId)
  );

  // ── 預覽面板（專案層級樣版預覽） ─────────────────────────────────────────

  // 與個別編輯的預覽面板同款（PagePreview＋頁尾動作列），
  // 只差來源是專案層級樣版、且沒有「刪除此頁」（頁面刪除是個別學生的事）
  const previewPanel = (
    <div className="space-y-3 lg:sticky lg:top-20" data-guide="class-preview-panel">
      <PagePreview
        pageIndex={activePage}
        timestamp={previewTimestamp}
        src={appendPreviewCacheVersion(
          buildProjectPagePreviewUrl(projectId, activePage),
          previewTimestamp,
          project.template_revision,
        )}
      />
      <div className="flex items-center justify-center gap-2">
        <Button
          onClick={() => setPreviewTimestamp(Date.now())}
          variant="ghost"
          size="xs"
          className="whitespace-nowrap"
        >
          <RefreshCw className="w-3 h-3" />重新整理預覽
        </Button>
      </div>
    </div>
  );

  // ── 照片面板（策略選擇 → 選格 → 上傳） ──────────────────────────────────

  // 格位幾何資料留在頁面計算：照片面板（選格格線）與「放照片」Modal（預覽比例、裁切框）共用
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
  // 頁首與選格格線抽至 ClassPhotoPanel；點格後的 Modal 流程仍在本頁
  const photoPanel = (
    <ClassPhotoPanel
      isProjectCompleted={isProjectCompleted}
      projectId={projectId}
      studentCount={project.students.length}
      activePage={activePage}
      slotItems={slotItems}
      selectedSlotId={selectedSharedPhotoSlotId}
      onPickSlot={openSlotPhotoModal}
      onOpenFilenameWizard={() => setIsFilenameBatchWizardOpen(true)}
    />
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
          <ClassPhotoStrategyPicker value={photoStrategy} onSelect={setPhotoStrategy} />

          {/* 上傳（選了方式才出現） */}
          {photoStrategy !== null && (
          <div data-guide="class-slot-photo-upload">
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

  // 抽至 ClassTextPanel；label_texts 讀寫操作由本頁的 useLabelTextsEditor 傳入
  const textPanel = (
    <ClassTextPanel
      activePage={activePage}
      textLabels={activePageTextLabels}
      saveStatus={saveStatus}
      disabled={isProjectCompleted}
      getLabelText={getLabelText}
      getLabelAlign={getLabelAlign}
      hasLabelTextOverride={hasLabelTextOverride}
      setLabelText={setLabelText}
      setLabelAlign={setLabelAlign}
      restoreDefaultLabelText={restoreDefaultLabelText}
      onScheduleSave={scheduleSave}
    />
  );

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      <BatchPhotoWizard
        isOpen={isBatchWizardOpen}
        projectId={projectId}
        templateRevision={project.template_revision}
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
        templateRevision={project.template_revision}
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
          // 編輯相本與班級總覽是同層兄弟頁：麵包屑一律只到「相本專案」，互切走右上按鈕
          <>
            <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
              <ChevronRight className="inline h-4 w-4 rotate-180 sm:hidden" />
              相本專案
            </Button>
          </>
        )}
        actions={(
          <ResponsiveActionGroup mobileColumns={2}>
            <Button
              as={Link}
              to={`/projects/${projectId}/review`}
              data-guide="editor-review-link"
              variant="review"
              size="touch"
              className={responsiveActionItemClass}
            >
              <Eye className="w-4 h-4" />
              <span className="hidden sm:inline">班級總覽</span>
              <span className="sm:hidden">總覽</span>
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

      {isProjectCompleted && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span className="font-medium">此專案已標記全班完成，內容已鎖定</span>
          <span className="text-emerald-600">仍可預覽；需主管或管理員退回才能修改</span>
        </div>
      )}

      <ScopeSwitcher
        students={project.students || []}
        currentStudentId={null}
        onSwitch={handleScopeSwitch}
        isBusy={isSharedPhotoUploading}
        saveStatus={saveStatus}
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
