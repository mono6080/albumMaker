import { Link } from "react-router-dom";
import { Camera, ChevronRight, Eye, Type } from "lucide-react";

import AlbumPageNav from "./AlbumPageNav";
import PanelSwitcher from "./PanelSwitcher";
import ResponsiveActionGroup, { responsiveActionItemClass } from "./ResponsiveActionGroup";
import GuideButton from "./GuideButton";
import ScopeSwitcher from "./ScopeSwitcher";
import { Badge, Button, PageHeader } from "./ui";

const EDITOR_TABS = [
  { value: "photo", label: "照片", icon: Camera },
  { value: "text", label: "文字", icon: Type },
  { value: "preview", label: "預覽", icon: Eye },
];

export default function AlbumEditorLayout({
  title,
  badgeLabel,
  projectId,
  onStartGuide,
  isProjectCompleted,
  completedTitle,
  completedDescription,
  students,
  currentStudentId,
  onScopeSwitch,
  isScopeBusy,
  saveStatus,
  mobileTab,
  onMobileTabChange,
  activePage,
  pageCount,
  onPageChange,
  pageNavGuide,
  previewGuide,
  photoGuide,
  textGuide,
  previewPanel,
  photoPanel,
  textPanel,
}) {
  return (
    <>
      <PageHeader
        title={title}
        badge={<Badge tone="review">{badgeLabel}</Badge>}
        meta={(
          <Button as={Link} to="/projects" variant="ghost" size="xs" className="text-gray-400">
            <ChevronRight className="inline h-4 w-4 rotate-180 sm:hidden" />
            相本工作
          </Button>
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
            <GuideButton onStart={onStartGuide} />
          </ResponsiveActionGroup>
        )}
      />

      {isProjectCompleted && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <span className="font-medium">{completedTitle}</span>
          <span className="text-emerald-600">{completedDescription}</span>
        </div>
      )}

      <ScopeSwitcher
        students={students}
        currentStudentId={currentStudentId}
        onSwitch={onScopeSwitch}
        isBusy={isScopeBusy}
        saveStatus={saveStatus}
      />

      <PanelSwitcher value={mobileTab} onChange={onMobileTabChange} tabs={EDITOR_TABS} />

      {pageCount > 1 && (
        <div
          className="mb-4 max-lg:sticky max-lg:top-14 max-lg:z-10 max-lg:-mx-4 max-lg:bg-[#f8fafc]/95 max-lg:px-4 max-lg:pb-2 max-lg:backdrop-blur-sm"
          data-guide={pageNavGuide}
        >
          <AlbumPageNav page={activePage} total={pageCount} onChange={onPageChange} />
        </div>
      )}

      <div className="lg:grid lg:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.4fr)] lg:gap-6 lg:items-start xl:grid-cols-[minmax(280px,0.85fr)_minmax(360px,1.15fr)_minmax(320px,0.9fr)]">
        <div
          className={`space-y-3 lg:sticky lg:top-20 lg:col-start-1 lg:row-span-2 xl:row-span-1 ${mobileTab === "preview" ? "block" : "hidden lg:block"}`}
          data-guide={previewGuide}
        >
          {previewPanel}
        </div>
        <div
          className={`lg:col-start-2 lg:row-start-1 lg:min-w-0 xl:col-start-2 ${mobileTab === "photo" ? "block" : "hidden lg:block"}`}
          data-guide={photoGuide}
        >
          {photoPanel}
        </div>
        <div
          className={`lg:col-start-2 lg:row-start-2 lg:min-w-0 xl:sticky xl:top-20 xl:col-start-3 xl:row-start-1 ${mobileTab === "text" ? "block" : "hidden lg:block"}`}
          data-guide={textGuide}
        >
          {textPanel}
        </div>
      </div>
    </>
  );
}
