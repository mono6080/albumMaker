// 學生個人編輯頁面
// 提供單一學生的照片上傳、對應文字編輯與即時預覽，
// 文字變更後自動防抖儲存（500ms）

import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";

import { fetchProject, renderStudent, batchUpdateStudentTexts, setStudentPageSkip } from "../api/projectApi";
import { fetchTemplate } from "../api/templateApi";
import { buildDownloadImagesZipUrl, buildDownloadPdfUrl, buildStudentPagePreviewUrl } from "../api/urls";
import { apiClient } from "../api/authApi";
import { useAutoSave } from "../hooks/useAutoSave";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Download,
  Eye,
  ImageDown,
  Loader2,
  Type,
} from "lucide-react";
import PhotoManager from "../components/PhotoManager";
import PanelSwitcher from "../components/PanelSwitcher";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import StudentPreviewPanel from "../components/StudentPreviewPanel";
import StudentTextPanel from "../components/StudentTextPanel";
import { Badge, Button, PageHeader } from "../components/ui";
import { startProductGuide } from "../utils/productGuide";
import { filterFillableLabelTexts } from "../utils/textLabelRoles";
import {
  createFileFromBlob,
  downloadApiBlob,
  fetchApiBlob,
  getShareFailureMessage,
  isMobileDevice,
  shareFiles,
} from "../utils/browserFiles";

const STUDENT_EDIT_GUIDE_STEPS = [
  {
    element: '[data-guide="student-preview-panel"]',
    title: "預覽與頁面",
    description: "左側會顯示目前學生的頁面預覽，可切頁、刪除此頁或還原。",
    side: "right",
    align: "center",
  },
  {
    element: '[data-guide="student-photo-manager"]',
    title: "照片管理",
    description: "在每個照片格上傳照片。已有照片時可調整位移縮放、更換或刪除。",
    side: "left",
    align: "start",
  },
  {
    element: '[data-guide="student-multi-upload"]',
    title: "多選上傳",
    description: "可以一次選多張照片，系統會依照片格順序放入空格。",
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
    element: '[data-guide="student-download-button"]',
    title: "產出並下載",
    description: "照片和文字確認後，按這裡產生 PDF；圖片按鈕在電腦下載 ZIP，手機開啟分享。",
    side: "bottom",
    align: "end",
  },
];

// ── 主頁面元件 ────────────────────────────────────────────────────────────────

export default function StudentEdit() {
  const { projectId, studentId } = useParams();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [student, setStudent] = useState(null);
  const [projectLabelTexts, setProjectLabelTexts] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [activePage, setActivePage] = useState(0);
  const [labelTexts, setLabelTexts] = useState({});  // { [pageIndex]: { [labelId]: text } }
  const [isRendering, setIsRendering] = useState(false);
  const [isImageRendering, setIsImageRendering] = useState(false);
  const [imageShareDraft, setImageShareDraft] = useState(null);
  // per-page 預覽時間戳：只有該頁資料變動時才更新，避免切頁重新渲染
  const [pageTimestamps, setPageTimestamps] = useState({});
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"
  const [skippedPages, setSkippedPages] = useState(new Set()); // 被刪除（跳過）的頁面索引

  // ── 自動儲存對應文字（防抖 500ms） ────────────────────────────────────────

  const { scheduleSave, flushSave } = useAutoSave(
    labelTexts,
    async (currentLabelTexts) => {
      const payload = {};
      Object.entries(currentLabelTexts).forEach(([pageIndex, labels]) => {
        payload[pageIndex] = labels;
      });
      try {
        await batchUpdateStudentTexts(projectId, { students: { [studentId]: payload } });
        // 更新所有有文字資料的頁面時間戳
        const now = Date.now();
        setPageTimestamps(prev => ({
          ...prev,
          ...Object.fromEntries(Object.keys(payload).map(pi => [pi, now])),
        }));
      } catch { /* 靜默失敗，不打擾使用者 */ }
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

  const getLabelText = (pageIndex, labelId) =>
    labelTexts[pageIndex]?.[String(labelId)] ?? "";

  const hasLabelTextOverride = (pageIndex, labelId) =>
    Object.prototype.hasOwnProperty.call(labelTexts[pageIndex] || {}, String(labelId));

  const setLabelText = (pageIndex, labelId, textValue) => {
    setImageShareDraft(null);
    setLabelTexts(prevTexts => ({
      ...prevTexts,
      [pageIndex]: { ...(prevTexts[pageIndex] || {}), [String(labelId)]: textValue },
    }));
  };

  const restoreDefaultLabelText = (pageIndex, labelId) => {
    setImageShareDraft(null);
    setLabelTexts(prevTexts => {
      const nextPageTexts = { ...(prevTexts[pageIndex] || {}) };
      delete nextPageTexts[String(labelId)];
      return { ...prevTexts, [pageIndex]: nextPageTexts };
    });
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
      await downloadApiBlob(apiClient, buildDownloadPdfUrl(projectId, studentId), `${student.name}.pdf`);
      toast.success("PDF 已下載");
    } catch {
      toast.error("產生失敗");
    }
    setIsRendering(false);
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
      if (isMobileDevice()) {
        const visiblePageIndexes = Array.from(
          { length: template?.pages.length ?? 0 },
          (_, pageIndex) => pageIndex,
        ).filter(pageIndex => !skippedPages.has(pageIndex));

        if (!visiblePageIndexes.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        const requestTs = Date.now();
        const files = [];
        for (const [visibleIndex, pageIndex] of visiblePageIndexes.entries()) {
          const { blob } = await fetchApiBlob(
            apiClient,
            `${buildStudentPagePreviewUrl(projectId, studentId, pageIndex)}?t=${requestTs}`,
          );
          const file = createFileFromBlob(blob, `${student.name}_page${visibleIndex + 1}.jpg`, "image/jpeg");
          if (file) files.push(file);
        }

        setImageShareDraft({ files, title: `${student.name} 相冊圖片` });
        toast.success("圖片已準備好，請再按一次開始分享");
        return;
      }

      await renderStudent(projectId, studentId);
      await loadStudentData();
      refreshAllPreviews();
      await downloadApiBlob(
        apiClient,
        buildDownloadImagesZipUrl(projectId, studentId),
        `${student.name}_images.zip`,
      );
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

      {/* 桌面版：左側預覽 | 右側照片 + 文字；行動版：單頁面板切換 */}
      <div className="lg:flex lg:gap-6 lg:items-start">
        {/* 預覽面板 */}
        <div className={`lg:block lg:flex-shrink-0 lg:w-1/3 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`} data-guide="student-preview-panel">
          <StudentPreviewPanel
            activePage={activePage}
            pageCount={pageCount}
            onPageChange={setActivePage}
            projectId={projectId}
            studentId={studentId}
            pageTimestamps={pageTimestamps}
            isCurrentPageSkipped={isCurrentPageSkipped}
            onPageSkip={handlePageSkip}
            onRefresh={refreshPreview}
          />
        </div>

        {/* 照片面板 + 桌面版文字面板 */}
        <div className={`lg:block lg:flex-1 lg:min-w-0 ${mobileTab === "photo" ? "block" : "hidden lg:block"} lg:space-y-6`}>
          <PhotoManager
            projectId={projectId}
            studentId={studentId}
            pages={templatePages}
            student={student}
            skippedPages={skippedPages}
            onPhotoSaved={() => { setImageShareDraft(null); refreshAllPreviews(); }}
            onSaved={() => { setImageShareDraft(null); loadStudentData(); refreshAllPreviews(); }}
          />
          <div className="hidden lg:block" data-guide="student-text-panel">
            <StudentTextPanel
              activePage={activePage}
              pageCount={pageCount}
              onPageChange={setActivePage}
              activePageLayout={activePageLayout}
              projectLabelTexts={projectLabelTexts}
              student={student}
              getLabelText={getLabelText}
              hasLabelTextOverride={hasLabelTextOverride}
              onLabelChange={setLabelText}
              onRestoreDefault={restoreDefaultLabelText}
              onScheduleSave={() => { if (student) scheduleSave(); }}
            />
          </div>
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
            hasLabelTextOverride={hasLabelTextOverride}
            onLabelChange={setLabelText}
            onRestoreDefault={restoreDefaultLabelText}
            onScheduleSave={() => { if (student) scheduleSave(); }}
          />
        </div>
      </div>
    </div>
  );
}
