import { useId } from "react";
import { X } from "lucide-react";

import useDialogA11y from "../hooks/useDialogA11y";

const PRESENTATION_CLASS = {
  "bottom-sheet": {
    root: "items-end justify-center",
    panel: "max-h-[82dvh] w-full max-w-2xl rounded-t-2xl border-x border-t border-gray-200 pb-[env(safe-area-inset-bottom)]",
  },
  "side-drawer": {
    root: "items-stretch justify-end",
    panel: "h-dvh max-h-dvh w-[min(88vw,25rem)] border-l border-gray-200 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]",
  },
};

export default function EditorSheet({
  isOpen,
  onClose,
  presentation = "bottom-sheet",
  title,
  description,
  ariaLabel,
  id,
  children,
  footer,
  showHeader = true,
  panelClassName = "",
  bodyClassName = "",
  dataGuide,
}) {
  const generatedId = useId().replaceAll(":", "");
  const sheetId = id ?? `editor-sheet-${generatedId}`;
  const titleId = `${sheetId}-title`;
  const descriptionId = `${sheetId}-description`;
  const sheetRef = useDialogA11y({ isOpen, onClose });
  const presentationClass = PRESENTATION_CLASS[presentation] ?? PRESENTATION_CLASS["bottom-sheet"];

  if (!isOpen) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] ${presentationClass.root}`}
      data-editor-sheet-root={presentation}
    >
      <div
        className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
        aria-hidden="true"
        onClick={onClose}
      />
      <section
        ref={sheetRef}
        id={sheetId}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={showHeader && title ? titleId : undefined}
        aria-describedby={showHeader && description ? descriptionId : undefined}
        aria-label={!showHeader || !title ? ariaLabel : undefined}
        className={`relative z-10 flex min-h-0 flex-col overflow-hidden bg-white shadow-2xl ${presentationClass.panel} ${panelClassName}`}
        data-guide={dataGuide ?? "editor-sheet"}
      >
        {showHeader && (
          <div className="flex min-h-14 flex-shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="truncate text-base font-semibold text-gray-900">
                {title}
              </h2>
              {description && <p id={descriptionId} className="mt-0.5 truncate text-xs text-gray-500">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={`關閉${title || ariaLabel || "面板"}`}
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${bodyClassName}`}>
          {children}
        </div>
        {footer && <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3">{footer}</div>}
      </section>
    </div>
  );
}
