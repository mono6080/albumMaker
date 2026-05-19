import { Button, Surface } from "./ui";

// 自訂確認 Modal，取代原生 window.confirm()
export default function ConfirmModal({
  isOpen,
  message,
  onConfirm,
  onCancel,
  confirmLabel = "確定刪除",
  confirmVariant = "danger",
}) {
  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <Surface
        variant="dialog"
        padding="lg"
        className="flex w-full max-w-sm flex-col gap-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={confirmLabel}
      >
        <p className="text-gray-800 text-sm leading-relaxed">{message}</p>
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onCancel}>
            取消
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
