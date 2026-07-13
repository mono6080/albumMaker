import { useEffect, useState } from "react";
import { Button, Surface } from "./ui";
import useDialogA11y from "../hooks/useDialogA11y";

// 自訂確認 Modal，取代原生 window.confirm()
export default function ConfirmModal({
  isOpen,
  message,
  onConfirm,
  onCancel,
  confirmLabel = "確定刪除",
  confirmVariant = "danger",
}) {
  const [isPending, setIsPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const dialogRef = useDialogA11y({ isOpen, onClose: onCancel, closeOnEscape: !isPending });

  useEffect(() => {
    if (!isOpen) {
      setIsPending(false);
      setActionError("");
    }
  }, [isOpen]);

  const handleConfirm = async () => {
    if (isPending) return;
    setIsPending(true);
    setActionError("");
    try {
      await onConfirm();
    } catch (error) {
      const detail = error?.response?.data?.detail;
      setActionError(typeof detail === "string" ? detail : "操作失敗，請稍後再試");
    } finally {
      setIsPending(false);
    }
  };

  if (!isOpen) return null;
  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <Surface
        ref={dialogRef}
        tabIndex={-1}
        variant="dialog"
        padding="lg"
        className="flex w-full max-w-sm flex-col gap-4"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={confirmLabel}
      >
        <p className="text-gray-800 text-sm leading-relaxed">{message}</p>
        {actionError && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="neutral" onClick={onCancel} disabled={isPending}>
            取消
          </Button>
          <Button variant={confirmVariant} onClick={handleConfirm} disabled={isPending}>
            {isPending ? "處理中…" : confirmLabel}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
