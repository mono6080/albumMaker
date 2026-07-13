import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let openDialogCount = 0;
let originalBodyOverflow = "";

export default function useDialogA11y({ isOpen = true, onClose, closeOnEscape = true } = {}) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    if (openDialogCount === 0) {
      originalBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    openDialogCount += 1;

    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const initial = dialog?.querySelector("[autofocus]") ?? dialog?.querySelector(FOCUSABLE_SELECTOR);
      (initial ?? dialog)?.focus();
    });

    const handleKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape" && closeOnEscape && onCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(element => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown, true);
      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) document.body.style.overflow = originalBodyOverflow;
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        requestAnimationFrame(() => previouslyFocused.focus());
      }
    };
  }, [isOpen, closeOnEscape]);

  return dialogRef;
}
