// 學生個人編輯頁面
// 提供單一學生的照片上傳、對應文字編輯與即時預覽，
// 文字變更後自動防抖儲存（500ms）

import { useCallback, useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";

import { fetchStudentEditor, batchUpdateStudentTexts, setStudentPageSkip } from "../api/projectApi";
import { fetchProjectTemplatePair } from "../api/templateApi";
import { useAutoSave } from "../hooks/useAutoSave";
import { useLabelTextsEditor } from "../hooks/useLabelTextsEditor";
import { usePermissions } from "../hooks/usePermissions";
import {
  Camera,
  ChevronRight,
  CircleHelp,
  Eye,
  Type,
} from "lucide-react";
import AlbumPageNav from "../components/AlbumPageNav";
import PhotoManager from "../components/PhotoManager";
import PanelSwitcher from "../components/PanelSwitcher";
import ResponsiveActionGroup, { responsiveActionItemClass } from "../components/ResponsiveActionGroup";
import ScopeSwitcher from "../components/ScopeSwitcher";
import StudentPreviewPanel from "../components/StudentPreviewPanel";
import StudentTextPanel from "../components/StudentTextPanel";
import { Badge, Button, PageHeader } from "../components/ui";
import { startProductGuide } from "../utils/productGuide";
import { filterFillableLabelTexts } from "../utils/textLabelRoles";
import { handleApiError, isProjectTemplateRevisionError } from "../utils/apiError";


// ── 主頁面元件 ────────────────────────────────────────────────────────────────

export default function StudentEdit() {
  const { projectId, studentId } = useParams();
  const navigate = useNavigate();

  const [project, setProject] = useState(null);
  const [template, setTemplate] = useState(null);
  const [student, setStudent] = useState(null);
  const [projectLabelTexts, setProjectLabelTexts] = useState({});
  const [loadError, setLoadError] = useState(null);
  const [activePage, setActivePage] = useState(0);
  // 對應文字（label_texts）state 與讀寫操作，抽至共用 Hook 與 ClassEdit 同步維護
  const {
    labelTexts, setLabelTexts,
    getLabelText, getLabelAlign, hasLabelTextOverride,
    setLabelText, setLabelAlign, restoreDefaultLabelText,
  } = useLabelTextsEditor();
  const [isSwitchingStudent, setIsSwitchingStudent] = useState(false);
  const [isPhotoSaving, setIsPhotoSaving] = useState(false);
  const [previewTimestampSeed, setPreviewTimestampSeed] = useState(() => Date.now());
  // per-page 預覽時間戳：只有該頁資料變動時才更新，避免切頁重新渲染
  const [pageTimestamps, setPageTimestamps] = useState({});
  const [mobileTab, setMobileTab] = useState("photo"); // "photo" | "text" | "preview"
  const [skippedPages, setSkippedPages] = useState(new Set()); // 被刪除（跳過）的頁面索引

  // ── 自動儲存對應文字（防抖 500ms） ────────────────────────────────────────

  const { scheduleSave, flushSave, saveStatus } = useAutoSave(
    labelTexts,
    async (currentLabelTexts, signal) => {
      const payload = {};
      Object.entries(currentLabelTexts).forEach(([pageIndex, labels]) => {
        payload[pageIndex] = labels;
      });
      // 帶 abort signal：新的儲存會取消還在路上的舊請求，避免舊值後到蓋掉新值
      try {
        await batchUpdateStudentTexts(
          projectId,
          project?.template_revision,
          { students: { [studentId]: payload } },
          signal,
        );
      } catch (error) {
        if (isProjectTemplateRevisionError(error)) handleApiError(error);
        throw error;
      }
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
      const { projectResponse: editorResponse, projectData, templateResponse } =
        await fetchProjectTemplatePair(
          () => fetchStudentEditor(projectId, studentId),
          (responseData) => responseData.project,
        );
      const { student: foundStudent } = editorResponse.data;
      setProject(projectData);
      setStudent(foundStudent);
      // 預覽 URL 版本戳跟著 updated_at 走，內容沒變時瀏覽器快取可命中
      if (foundStudent.updated_at) {
        setPreviewTimestampSeed(new Date(foundStudent.updated_at).getTime() || Date.now());
      }

      // 切學生時模板走 revision cache；若兩次 GET 間剛好同步升版，
      // 共用 loader 會重抓到一致的 project/template pair。
      setTemplate(templateResponse.data);
      setProjectLabelTexts(projectData.label_texts || {});

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
    // setLabelTexts 來自 useLabelTextsEditor（底層是 useState setter，恆穩定），列入只為滿足 lint
  }, [projectId, studentId, setLabelTexts]);

  useEffect(() => { loadStudentData(); }, [loadStudentData]);

  // 路由守衛只擋角色、擋不了擁有權：非 owner 直接輸入網址會看到可編輯 UI
  // 但每次寫入都被後端 403，直接轉去唯讀的班級總覽
  const { canEditProject } = usePermissions();
  useEffect(() => {
    if (!project) return;
    if (!canEditProject(project.owner_id)) {
      toast.error("你沒有此專案的編輯權限，已切到班級總覽");
      navigate(`/projects/${projectId}/review`, { replace: true });
    }
  }, [project, canEditProject, navigate, projectId]);

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
      await setStudentPageSkip(projectId, project.template_revision, studentId, pageIndex, skip);
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
    } catch (error) {
      handleApiError(error, "操作失敗");
    }
  };

  const startGuide = () => {
    // 動態步驟（同全班編輯的教學）：行動版面板是分頁制，
    // 導覽自己切到對的分頁（桌機三欄常駐、不受影響）
    const steps = [
      {
        element: '[data-guide="student-page-nav"]',
        title: "切換頁面",
        description: "整頁一起換：預覽、照片格與文字都會跟著切到同一頁，一頁做完換下一頁。",
        side: "bottom",
        align: "center",
      },
      {
        element: '[data-guide="student-preview-panel"]',
        title: "頁面預覽",
        description: "顯示目前頁面的合成預覽，可重新整理；頁尾可刪除此頁或還原。",
        side: "right",
        align: "center",
        onBeforeStep: () => { setMobileTab("preview"); },
      },
      {
        element: '[data-guide="scope-switcher"]',
        title: "切換編輯範圍",
        description: "用上一位、下一位或下拉切換學生；按「全班」可改全班一起套用的照片與文字。切換前會先儲存目前文字。",
        side: "bottom",
        align: "center",
      },
      {
        element: '[data-guide="student-photo-manager"]',
        title: "照片管理",
        description: "這裡是目前頁面的照片格。點空格上傳；已有照片時可調整裁切位置與縮放、更換、刪除或交換格子。",
        side: "left",
        align: "start",
        onBeforeStep: () => { setMobileTab("photo"); },
      },
      {
        element: '[data-guide="student-photo-scope"]',
        title: "本頁／整本",
        description: "切到「整本」會顯示所有頁的照片格：可以一次上傳全書照片、跨頁拖曳調換；點某格時預覽也會跳到那一頁。",
        side: "left",
        align: "center",
        onBeforeStep: () => { setMobileTab("photo"); },
      },
      {
        element: '[data-guide="student-multi-upload"]',
        title: "多選上傳",
        description: "可以一次選多張照片，填入目前檢視（本頁或整本）的剩餘空格；過大的照片會先壓縮再上傳。",
        side: "left",
        align: "center",
        onBeforeStep: () => { setMobileTab("photo"); },
      },
      {
        // 桌面與行動版是兩個實例（student-text-panel / student-text-panel-mobile），
        // 用前綴比對讓兩邊都吃得到
        element: '[data-guide^="student-text-panel"]',
        title: "個別文字",
        description: "需要為單一學生覆寫文字時，在這裡輸入。清空會輸出空白；按恢復預設可回到共用文字或模板文字。",
        side: "left",
        align: "start",
        onBeforeStep: () => { setMobileTab("text"); },
      },
      {
        element: '[data-guide="student-text-insert-name"]',
        title: "插入 {name}",
        description: "點一下就能在游標位置加入姓名變數，輸出時會替換成這位學生姓名。",
        side: "top",
        align: "end",
        onBeforeStep: () => { setMobileTab("text"); },
      },
    ];

    startProductGuide(steps);
  };

  // target 為 null 時切到全班共用 scope（ClassEdit）
  const handleScopeSwitch = async (target) => {
    if (isSwitchingStudent || isPhotoSaving) {
      if (isPhotoSaving) toast("照片正在儲存，完成後即可切換");
      return;
    }
    if (target != null && String(target) === String(studentId)) return;

    setIsSwitchingStudent(true);
    try {
      await flushSave();
      navigate(target == null
        ? `/projects/${projectId}/edit`
        : `/projects/${projectId}/students/${target}/edit`);
    } catch (error) {
      if (!isProjectTemplateRevisionError(error)) toast.error("切換前儲存失敗");
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
  // 專案已標記全班完成：內容鎖定（照片/文字/頁面），預覽照常
  const isProjectCompleted = Boolean(project.completed_at);
  const students = project.students || [];

  // ── 主佈局渲染 ────────────────────────────────────────────────────────────

  return (
    <div className="w-full">
      <PageHeader
        title={student.name}
        badge={<Badge tone="review">編輯學生</Badge>}
        meta={(
          // 與全班編輯完全一致的麵包屑：只到「相本專案」，互切走右上按鈕
          <>
            <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
              <ChevronRight className="inline h-4 w-4 rotate-180 sm:hidden" />
              相本專案
            </Button>
          </>
        )}
        actions={(
        // 下載集中在班級總覽；右上與班級總覽的「編輯相本」互為對稱切換按鈕
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
          <span className="text-emerald-600">仍可預覽，下載請到班級總覽；需主管或管理員退回才能修改</span>
        </div>
      )}

      {/* 編輯範圍切換：全班/個別＋學生切換；存檔狀態常駐於此 */}
      <ScopeSwitcher
        students={students}
        currentStudentId={studentId}
        onSwitch={handleScopeSwitch}
        isBusy={isSwitchingStudent || isPhotoSaving}
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
          data-guide="student-page-nav"
        >
          <AlbumPageNav page={activePage} total={pageCount} onChange={setActivePage} />
        </div>
      )}

      {/* 桌面版：預覽 / 照片 / 文字工作台；行動版：單頁面板切換 */}
      <div className="lg:grid lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)] lg:gap-6 lg:items-start xl:grid-cols-[minmax(280px,0.85fr)_minmax(360px,1.15fr)_minmax(320px,0.9fr)]">
        {/* 預覽面板 */}
        <div
          className={`lg:sticky lg:top-20 lg:col-start-1 lg:row-span-2 xl:row-span-1 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`}
          data-guide="student-preview-panel"
        >
          <StudentPreviewPanel
            activePage={activePage}
            projectId={projectId}
            studentId={studentId}
            pageTimestamps={pageTimestamps}
            timestampSeed={previewTimestampSeed}
            templateRevision={project.template_revision}
            isCurrentPageSkipped={isCurrentPageSkipped}
            onPageSkip={handlePageSkip}
            onRefresh={refreshPreview}
            isLocked={isProjectCompleted}
          />
        </div>

        {/* 照片面板 */}
        <div className={`lg:block lg:col-start-2 lg:row-start-1 lg:min-w-0 xl:col-start-2 ${mobileTab === "photo" ? "block" : "hidden lg:block"}`}>
          <PhotoManager
            projectId={projectId}
            templateRevision={project.template_revision}
            studentId={studentId}
            pages={templatePages}
            student={student}
            skippedPages={skippedPages}
            disabled={isProjectCompleted}
            activePage={activePage}
            onPageFocus={setActivePage}
            onSaveStateChange={setIsPhotoSaving}
            onTemplateRevisionChanged={loadStudentData}
            onPhotoSaved={() => { refreshAllPreviews(); }}
          />
        </div>

        {/* 桌面版文字面板 */}
        <div
          className="hidden lg:block lg:col-start-2 lg:row-start-2 lg:min-w-0 xl:sticky xl:top-20 xl:col-start-3 xl:row-start-1"
          data-guide="student-text-panel"
        >
          <StudentTextPanel
            activePage={activePage}
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
            isLocked={isProjectCompleted}
          />
        </div>

        {/* 行動版文字面板（獨立顯示） */}
        <div className={`lg:hidden ${mobileTab === "text" ? "block" : "hidden"} w-full`} data-guide="student-text-panel-mobile">
          <StudentTextPanel
            activePage={activePage}
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
            isLocked={isProjectCompleted}
          />
        </div>
      </div>
    </div>
  );
}
