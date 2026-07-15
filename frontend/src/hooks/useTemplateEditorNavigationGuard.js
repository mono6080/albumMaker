// 模板草稿的站內導覽、瀏覽器返回與關閉頁面防護。

import { useCallback, useEffect, useRef } from "react";

const DISCARD_MESSAGE = "尚有未儲存的模板變更。確定要放棄變更並離開嗎？";

export default function useTemplateEditorNavigationGuard({
  hasUnsavedChanges,
  navigate,
  setConfirmModal,
  setActiveMobilePanel,
}) {
  const hasUnsavedChangesRef = useRef(false);
  const historyGuardRef = useRef({ installed: false, returning: false, allowNextPop: false });

  useEffect(() => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const historyGuard = historyGuardRef.current;
    if (!historyGuard.installed) {
      historyGuard.installed = true;
      const currentRouteState = window.history.state?.usr;
      if (!currentRouteState?.templateEditorGuard) {
        navigate(".", {
          state: { ...(currentRouteState ?? {}), templateEditorGuard: true },
        });
      }
    }
    const handleDocumentLink = (event) => {
      if (!hasUnsavedChangesRef.current
        || event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey) return;
      const anchor = event.target.closest?.("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin
        || destination.href === window.location.href) return;
      event.preventDefault();
      event.stopPropagation();
      setActiveMobilePanel(null);
      setConfirmModal({
        message: DISCARD_MESSAGE,
        confirmLabel: "放棄變更並離開",
        confirmVariant: "danger",
        onConfirm: () => navigate(
          `${destination.pathname}${destination.search}${destination.hash}`,
        ),
      });
    };
    const handleNavigationRequest = (event) => {
      if (!hasUnsavedChangesRef.current) return;
      event.preventDefault();
      setActiveMobilePanel(null);
      setConfirmModal({
        message: DISCARD_MESSAGE,
        confirmLabel: "放棄變更並離開",
        confirmVariant: "danger",
        onConfirm: () => event.detail?.proceed?.(),
      });
    };
    const handleHistoryBack = () => {
      if (historyGuard.returning) {
        historyGuard.returning = false;
        return;
      }
      if (historyGuard.allowNextPop) {
        historyGuard.allowNextPop = false;
        return;
      }
      const shouldLeave = !hasUnsavedChangesRef.current || window.confirm(DISCARD_MESSAGE);
      if (shouldLeave) {
        // 第一個 back 只移到同 URL 的 guard base；再退一次才真正離開 editor。
        historyGuard.allowNextPop = true;
        window.setTimeout(() => window.history.back(), 0);
      } else {
        // 取消時回到 sentinel，route 不曾離開 editor，記憶體草稿會保留。
        historyGuard.returning = true;
        window.setTimeout(() => window.history.forward(), 0);
      }
    };
    document.addEventListener("click", handleDocumentLink, true);
    window.addEventListener("album-maker:navigation-request", handleNavigationRequest);
    window.addEventListener("popstate", handleHistoryBack);
    return () => {
      document.removeEventListener("click", handleDocumentLink, true);
      window.removeEventListener("album-maker:navigation-request", handleNavigationRequest);
      window.removeEventListener("popstate", handleHistoryBack);
    };
  }, [navigate, setActiveMobilePanel, setConfirmModal]);

  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedChanges]);

  return useCallback(() => {
    if (!hasUnsavedChanges) {
      navigate("/templates");
      return;
    }
    setActiveMobilePanel(null);
    setConfirmModal({
      message: "尚有未儲存的模板變更。確定要放棄變更並返回模板列表嗎？",
      confirmLabel: "放棄變更並離開",
      confirmVariant: "danger",
      onConfirm: () => navigate("/templates"),
    });
  }, [hasUnsavedChanges, navigate, setActiveMobilePanel, setConfirmModal]);
}
