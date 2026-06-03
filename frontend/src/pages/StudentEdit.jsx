// 學生個人編輯頁面
// 提供單一學生的照片上傳、對應文字編輯與即時預覽，
// 文字變更後自動防抖儲存（500ms）

import { useCallback, useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { fetchProject, renderStudent, batchUpdateStudentTexts, setStudentPageSkip } from "../api/projectApi";
import { fetchTemplate } from "../api/templateApi";
import {
  buildDownloadImageUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildStudentPagePreviewUrl,
} from "../api/urls";
import { renderClient } from "../api/authApi";
import { useAutoSave } from "../hooks/useAutoSave";
import { usePermissions } from "../hooks/usePermissions";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  ImageDown,
  Loader2,
  Monitor,
  Printer,
  Type,
} from "lucide-react";
import PhotoManager from "../components/PhotoManager";
import PanelSwitcher from "../components/PanelSwitcher";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import StudentPreviewPanel from "../components/StudentPreviewPanel";
import StudentTextPanel from "../components/StudentTextPanel";
import { Badge, Button, PageHeader, SegmentedControl, fieldControlClass } from "../components/ui";
import { startProductGuide } from "../utils/productGuide";
import {
  getLabelEntryAlign,
  getLabelEntryTextOverride,
  hasLabelEntryTextOverride,
  withLabelEntryAlign,
  withLabelEntryText,
  withoutLabelEntryText,
} from "../utils/labelTextEntries";
import { filterFillableLabelTexts } from "../utils/textLabelRoles";
import {
  createFileFromBlob,
  downloadApiBlob,
  fetchApiBlob,
  getFilenameFromDisposition,
  getShareFailureMessage,
  isMobileDevice,
  shareFiles,
} from "../utils/browserFiles";

const STUDENT_EDIT_GUIDE_STEPS = [
  {
    element: '[data-guide="student-preview-panel"]',
    title: "預覽與頁面",
    description: "左側會顯示目前學生的頁面預覽，可切頁、重新整理預覽，也可刪除此頁或還原。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="student-switcher"]',
    title: "切換學生",
    description: "不用回到上一頁，可直接用上一位、下一位或下拉選單切換學生；切換前會先儲存目前文字。",
    side: "bottom",
    align: "center",
  },
  {
    element: '[data-guide="student-photo-manager"]',
    title: "照片管理",
    description: "在每個照片格上傳照片。已有照片時可調整裁切位置與縮放、更換、刪除或交換格子。",
    side: "left",
    align: "start",
  },
  {
    element: '[data-guide="student-multi-upload"]',
    title: "多選上傳",
    description: "可以一次選多張照片，系統只會填入剩餘空格；過大的照片會先壓縮再上傳。",
    side: "left",
    align: "center",
  },
  {
    element: '[data-guide="student-text-panel"]',
    title: "個別文字",
    description: "需要為單一學生覆寫文字時，在這裡輸入。清空會輸出空白；按恢復預設可回到共用文字或模板文字。",
    side: "left",
    align: "start",
  },
  {
    element: '[data-guide="student-text-insert-name"]',
    title: "插入 {name}",
    description: "點一下就能在游標位置加入姓名變數，輸出時會替換成這位學生姓名。",
    side: "top",
    align: "end",
  },
  {
    element: '[data-guide="student-output-mode"]',
    title: "輸出畫質",
    description: "管理員可選完整畫質或壓縮版；下載 PDF、圖片 ZIP 和手機分享圖片都會套用這個設定。",
    side: "bottom",
    align: "end",
  },
  {
    element: '[data-guide="student-download-button"]',
    title: "產出並下載",
    description: "照片和文字確認後，按這裡產生 PDF；圖片按鈕在電腦下載 ZIP，手機會先準備圖片再開啟分享。",
    side: "bottom",
    align: "end",
  },
];

// ── 主頁面元件 ────────────────────────────────────────────────────────────────

export default function StudentEdit() {
  const { projectId, studentId } = useParams();
  const navigate = useNavigate();
  const { canDownloadPrint } = usePermissions();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [student, setStudent] = useState(null);
  const [projectLabelTexts, setProjectLabelTexts] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [activePage, setActivePage] = useState(0);
  const [labelTexts, setLabelTexts] = useState({});  // { [pageIndex]: { [labelId]: text | { text, text_align } } }
  const [isRendering, setIsRendering] = useState(false);
  const [isImageRendering, setIsImageRendering] = useState(false);
  const [isSwitchingStudent, setIsSwitchingStudent] = useState(false);
  const [imageShareDraft, setImageShareDraft] = useState(null);
  const [outputMode, setOutputMode] = useState("print");
  const [previewTimestampSeed] = useState(() => Date.now());
  // per-page 預覽時間戳：只有該頁資料變動時才更新，避免切頁重新渲染
  const [pageTimestamps, setPageTimestamps] = useState({});
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"
  const [skippedPages, setSkippedPages] = useState(new Set()); // 被刪除（跳過）的頁面索引

  // ── 自動儲存對應文字（防抖 500ms） ────────────────────────────────────────

  const { scheduleSave, flushSave, saveStatus } = useAutoSave(
    labelTexts,
    async (currentLabelTexts) => {
      const payload = {};
      Object.entries(currentLabelTexts).forEach(([pageIndex, labels]) => {
        payload[pageIndex] = labels;
      });
      await batchUpdateStudentTexts(projectId, { students: { [studentId]: payload } });
      // 更新所有有文字資料的頁面時間戳
      const now = Date.now();
      setPageTimestamps(prev => ({
        ...prev,
        ...Object.fromEntries(Object.keys(payload).map(pi => [pi, now])),
      }));
    },
    500
  );

  // 排程自動儲存由 StudentTextPanel 在 onChange / compositionEnd 時呼叫，
  // 避免組字期間（中文 IME）觸發儲存打斷輸入

  // ── 資料載入 ──────────────────────────────────────────────────────────────

  const loadStudentData = useCallback(async () => {
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

      const templateResponse = await fetchTemplate(projectResponse.data.template_id);
      setTemplate(templateResponse.data);
      setProjectLabelTexts(projectResponse.data.label_texts || {});

      // 初始化對應文字狀態：只保留可填文字，固定文字永遠使用模板內容。
      const initialTexts = {};
      const initialSkipped = new Set();
      (foundStudent?.pages_data || []).forEach(pageData => {
        const pageLayout = templateResponse.data.pages[pageData.page_index]?.layout;
        initialTexts[pageData.page_index] = filterFillableLabelTexts(
          pageLayout?.text_labels || [],
          pageData.label_texts || {}
        );
        if (pageData.skip) initialSkipped.add(pageData.page_index);
      });
      setLabelTexts(initialTexts);
      setSkippedPages(initialSkipped);
    } catch {
      setLoadError("找不到專案或學生");
    }
  }, [projectId, studentId]);

  useEffect(() => { loadStudentData(); }, [loadStudentData]);

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
    setImageShareDraft(null);
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withLabelEntryText(currentEntry, textValue, fallbackAlign)
    );
  };

  const setLabelAlign = (pageIndex, labelId, textAlign, fallbackAlign = "center") => {
    setImageShareDraft(null);
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withLabelEntryAlign(currentEntry, textAlign, fallbackAlign)
    );
  };

  const restoreDefaultLabelText = (pageIndex, labelId, fallbackAlign = "center") => {
    setImageShareDraft(null);
    updateLabelEntry(pageIndex, labelId, currentEntry =>
      withoutLabelEntryText(currentEntry, fallbackAlign)
    );
  };

  const refreshPreview = (pageIdx = activePage) =>
    setPageTimestamps(prev => ({ ...prev, [pageIdx]: Date.now() }));

  const refreshAllPreviews = () => {
    const now = Date.now();
    const count = template?.pages.length ?? 0;
    setPageTimestamps(prev => ({
      ...prev,
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [i, now])),
    }));
  };

  // ── 頁面刪除 / 還原 ───────────────────────────────────────────────────────

  const handlePageSkip = async (pageIndex, skip) => {
    try {
      await setStudentPageSkip(projectId, studentId, pageIndex, skip);
      setImageShareDraft(null);
      setSkippedPages(prev => {
        const next = new Set(prev);
        if (skip) next.add(pageIndex); else next.delete(pageIndex);
        return next;
      });
      if (skip && activePage === pageIndex) {
        // 跳到下一個未刪除頁；若沒有則往前找
        const templatePageCount = template?.pages.length ?? 0;
        for (let i = pageIndex + 1; i < templatePageCount; i++) {
          if (!skippedPages.has(i) && i !== pageIndex) { setActivePage(i); return; }
        }
        for (let i = pageIndex - 1; i >= 0; i--) {
          if (!skippedPages.has(i)) { setActivePage(i); return; }
        }
      }
    } catch {
      toast.error("操作失敗");
    }
  };

  // ── 渲染（含前置強制儲存） ────────────────────────────────────────────────

  const handleRenderPdf = async () => {
    // 先強制同步儲存，確保渲染使用最新文字
    await flushSave();

    setIsRendering(true);
    try {
      setImageShareDraft(null);
      await renderStudent(projectId, studentId);
      await loadStudentData();
      refreshAllPreviews();
      // 渲染完成後自動下載
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
      await downloadApiBlob(renderClient, buildDownloadPdfUrl(projectId, studentId, effectiveMode), `${student.name}.pdf`);
      toast.success("PDF 已下載");
    } catch {
      toast.error("產生失敗");
    }
    setIsRendering(false);
  };

  const getVisiblePageIndexes = useCallback(() => (
    Array.from(
      { length: template?.pages.length ?? 0 },
      (_, pageIndex) => pageIndex,
    ).filter(pageIndex => !skippedPages.has(pageIndex))
  ), [skippedPages, template]);

  const buildShareImageFilesFromPreview = async (visiblePageIndexes, requestTs) => {
    const files = [];
    for (const [visibleIndex, pageIndex] of visiblePageIndexes.entries()) {
      const { blob } = await fetchApiBlob(
        renderClient,
        `${buildStudentPagePreviewUrl(projectId, studentId, pageIndex)}?t=${requestTs}`,
      );
      const file = createFileFromBlob(blob, `${student.name}_page${visibleIndex + 1}.jpg`, "image/jpeg");
      if (file) files.push(file);
    }
    return files;
  };

  const buildShareImageFilesFromRenderedOutput = async (visiblePageIndexes, effectiveMode) => {
    const files = [];
    for (const visibleIndex of visiblePageIndexes.keys()) {
      const { blob, disposition } = await fetchApiBlob(
        renderClient,
        buildDownloadImageUrl(projectId, studentId, visibleIndex + 1, effectiveMode),
      );
      const filename = getFilenameFromDisposition(disposition, `${student.name}_page${visibleIndex + 1}.jpg`);
      const file = createFileFromBlob(
        blob,
        filename,
        "image/jpeg",
      );
      if (file) files.push(file);
    }
    return files;
  };

  const handleRenderImages = async () => {
    if (isMobileDevice() && imageShareDraft?.files?.length) {
      setIsImageRendering(true);
      try {
        const shareResult = await shareFiles(imageShareDraft.files, imageShareDraft.title);
        if (shareResult === "shared") {
          setImageShareDraft(null);
          toast.success("已開啟分享");
        } else if (shareResult !== "cancelled") {
          toast.error(getShareFailureMessage(shareResult));
        }
      } catch {
        toast.error("分享圖片失敗");
      } finally {
        setIsImageRendering(false);
      }
      return;
    }

    await flushSave();

    setIsImageRendering(true);
    try {
      const effectiveMode = canDownloadPrint ? outputMode : "screen";
      if (isMobileDevice()) {
        const visiblePageIndexes = getVisiblePageIndexes();

        if (!visiblePageIndexes.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        const files = canDownloadPrint
          ? await (async () => {
              await renderStudent(projectId, studentId);
              await loadStudentData();
              refreshAllPreviews();
              return buildShareImageFilesFromRenderedOutput(visiblePageIndexes, effectiveMode);
            })()
          : await buildShareImageFilesFromPreview(visiblePageIndexes, Date.now());

        setImageShareDraft({ files, title: `${student.name} 相冊圖片` });
        toast.success("圖片已準備好，請再按一次開始分享");
        return;
      }

      await renderStudent(projectId, studentId);
      await loadStudentData();
      refreshAllPreviews();
      await downloadApiBlob(renderClient, buildDownloadImagesZipUrl(projectId, studentId, effectiveMode), `${student.name}_images.zip`);
      toast.success("圖片 ZIP 已下載");
    } catch {
      toast.error(isMobileDevice() ? "分享圖片失敗" : "產生圖片失敗");
    } finally {
      setIsImageRendering(false);
    }
  };

  const startGuide = () => {
    startProductGuide(STUDENT_EDIT_GUIDE_STEPS);
  };

  const handleStudentSwitch = async (nextStudentId) => {
    if (!nextStudentId || String(nextStudentId) === String(studentId) || isSwitchingStudent) return;

    setIsSwitchingStudent(true);
    try {
      await flushSave();
      setImageShareDraft(null);
      navigate(`/projects/${projectId}/students/${nextStudentId}/edit`);
    } catch {
      toast.error("切換學生前儲存失敗");
    } finally {
      setIsSwitchingStudent(false);
    }
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

  const isCurrentPageSkipped = skippedPages.has(activePage);
  const isOutputBusy = isRendering || isImageRendering;
  const isImageShareReady = isMobileDevice() && imageShareDraft?.files?.length > 0;
  const students = project.students || [];
  const currentStudentIndex = students.findIndex(item => item.id === Number(studentId));
  const previousStudent = currentStudentIndex > 0 ? students[currentStudentIndex - 1] : null;
  const nextStudent = currentStudentIndex >= 0 && currentStudentIndex < students.length - 1
    ? students[currentStudentIndex + 1]
    : null;
  const canSwitchStudent = !isOutputBusy && !isSwitchingStudent && students.length > 1;

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      <PageHeader
        title={student.name}
        badge={<Badge tone="review">個別編輯</Badge>}
        meta={(
          <>
            <Button as={Link} to="/projects" variant="ghost" size="xs" className="hidden text-gray-400 sm:inline-flex">
              相本專案
            </Button>
            <ChevronRight className="hidden h-3.5 w-3.5 flex-shrink-0 text-gray-300 sm:block" />
            <Button
              as={Link}
              to={`/projects/${projectId}/review`}
              variant="ghost"
              size="xs"
              className="min-w-0 text-gray-400"
            >
              <ChevronLeft className="inline h-3.5 w-3.5 sm:hidden" />
              <span className="inline-block max-w-[14rem] truncate align-bottom sm:max-w-none">{project.name}</span>
            </Button>
          </>
        )}
        actions={(
        <ResponsiveActionGroup mobileColumns={3}>
          {canDownloadPrint && (
            <div data-guide="student-output-mode" className="col-span-3 sm:w-auto">
              <SegmentedControl
                value={outputMode}
                onChange={(value) => {
                  setOutputMode(value);
                  setImageShareDraft(null);
                }}
                size="sm"
                className="w-full"
                options={[
                  { value: "print", label: "完整畫質", icon: Printer },
                  { value: "screen", label: "壓縮版", icon: Monitor },
                ]}
              />
            </div>
          )}
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
          <Button
            onClick={handleRenderPdf}
            disabled={isOutputBusy}
            data-guide="student-download-button"
            variant="success"
            size="touch"
            className={responsiveActionItemClass}
          >
            {isRendering
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Download className="w-4 h-4" />}
            <span className="hidden sm:inline">{isRendering ? "產生中..." : "下載 PDF"}</span>
            <span className="sm:hidden">{isRendering ? "..." : "PDF"}</span>
          </Button>
          <Button
            onClick={handleRenderImages}
            disabled={isOutputBusy}
            variant="info"
            size="touch"
            className={responsiveActionItemClass}
          >
            {isImageRendering
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <ImageDown className="w-4 h-4" />}
            <span className="hidden sm:inline">{isImageRendering ? "準備中..." : isImageShareReady ? "開始分享" : "下載圖片"}</span>
            <span className="sm:hidden">{isImageRendering ? "..." : isImageShareReady ? "分享" : "圖片"}</span>
          </Button>
        </ResponsiveActionGroup>
        )}
      />

      <div
        data-guide="student-switcher"
        className="mb-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
      >
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-gray-500">
          <span className="font-medium">切換學生</span>
          <span>
            {currentStudentIndex >= 0 ? currentStudentIndex + 1 : "-"} / {students.length}
          </span>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
          <Button
            type="button"
            onClick={() => handleStudentSwitch(previousStudent?.id)}
            disabled={!canSwitchStudent || !previousStudent}
            variant="neutral"
            size="touch"
            className="px-3"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="hidden sm:inline">上一位</span>
          </Button>
          <select
            aria-label="切換學生"
            value={studentId}
            onChange={event => handleStudentSwitch(event.target.value)}
            disabled={!canSwitchStudent}
            className={`${fieldControlClass} min-h-12 bg-white`}
          >
            {students.map((studentRecord, index) => (
              <option key={studentRecord.id} value={studentRecord.id}>
                {index + 1}. {studentRecord.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            onClick={() => handleStudentSwitch(nextStudent?.id)}
            disabled={!canSwitchStudent || !nextStudent}
            variant="neutral"
            size="touch"
            className="px-3"
          >
            <span className="hidden sm:inline">下一位</span>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

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

      {/* 桌面版：預覽 / 照片 / 文字工作台；行動版：單頁面板切換 */}
      <div className="lg:grid lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)] lg:gap-6 lg:items-start xl:grid-cols-[minmax(280px,0.85fr)_minmax(360px,1.15fr)_minmax(320px,0.9fr)]">
        {/* 預覽面板 */}
        <div
          className={`lg:sticky lg:top-20 lg:col-start-1 lg:row-span-2 xl:row-span-1 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`}
          data-guide="student-preview-panel"
        >
          <StudentPreviewPanel
            activePage={activePage}
            pageCount={pageCount}
            onPageChange={setActivePage}
            projectId={projectId}
            studentId={studentId}
            pageTimestamps={pageTimestamps}
            timestampSeed={previewTimestampSeed}
            isCurrentPageSkipped={isCurrentPageSkipped}
            onPageSkip={handlePageSkip}
            onRefresh={refreshPreview}
          />
        </div>

        {/* 照片面板 */}
        <div className={`lg:block lg:col-start-2 lg:row-start-1 lg:min-w-0 xl:col-start-2 ${mobileTab === "photo" ? "block" : "hidden lg:block"}`}>
          <PhotoManager
            projectId={projectId}
            studentId={studentId}
            pages={templatePages}
            student={student}
            skippedPages={skippedPages}
            onPhotoSaved={() => { setImageShareDraft(null); refreshAllPreviews(); }}
            onSaved={() => { setImageShareDraft(null); loadStudentData(); refreshAllPreviews(); }}
          />
        </div>

        {/* 桌面版文字面板 */}
        <div
          className="hidden lg:block lg:col-start-2 lg:row-start-2 lg:min-w-0 xl:sticky xl:top-20 xl:col-start-3 xl:row-start-1"
          data-guide="student-text-panel"
        >
          <StudentTextPanel
            activePage={activePage}
            pageCount={pageCount}
            onPageChange={setActivePage}
            activePageLayout={activePageLayout}
            projectLabelTexts={projectLabelTexts}
            student={student}
            getLabelText={getLabelText}
            getLabelAlign={getLabelAlign}
            hasLabelTextOverride={hasLabelTextOverride}
            onLabelChange={setLabelText}
            onLabelAlignChange={setLabelAlign}
            onRestoreDefault={restoreDefaultLabelText}
            onScheduleSave={() => { if (student) scheduleSave(); }}
            saveStatus={saveStatus}
          />
        </div>

        {/* 行動版文字面板（獨立顯示） */}
        <div className={`lg:hidden ${mobileTab === "text" ? "block" : "hidden"} w-full`} data-guide="student-text-panel-mobile">
          <StudentTextPanel
            activePage={activePage}
            pageCount={pageCount}
            onPageChange={setActivePage}
            activePageLayout={activePageLayout}
            projectLabelTexts={projectLabelTexts}
            student={student}
            getLabelText={getLabelText}
            getLabelAlign={getLabelAlign}
            hasLabelTextOverride={hasLabelTextOverride}
            onLabelChange={setLabelText}
            onLabelAlignChange={setLabelAlign}
            onRestoreDefault={restoreDefaultLabelText}
            onScheduleSave={() => { if (student) scheduleSave(); }}
            saveStatus={saveStatus}
          />
        </div>
      </div>
    </div>
  );
}
