// 表單用 Modal：背板＋Esc 關閉、標題列含關閉鈕
// 呼叫端自行保留表單 state（關閉不清空，誤觸不會遺失輸入）

import { X } from "lucide-react";
import { IconButton, Surface } from "./ui";
import useDialogA11y from "../hooks/useDialogA11y";

export default function FormModal({
  isOpen,
  title,
  onClose,
  children,
  maxWidthClass = "max-w-2xl",
}) {
  const dialogRef = useDialogA11y({ isOpen, onClose });

  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <Surface
        ref={dialogRef}
        tabIndex={-1}
        variant="dialog"
        padding="lg"
        className={`flex max-h-[90vh] w-full ${maxWidthClass} flex-col overflow-y-auto`}
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-start justify-between gap-2">
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
          <IconButton label="關閉" onClick={onClose} size="xs">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        {children}
      </Surface>
    </div>
  );
}
