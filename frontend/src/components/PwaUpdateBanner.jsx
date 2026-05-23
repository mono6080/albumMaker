// PWA 更新提示橫幅
// 主動檢查 Service Worker 更新，避免手機 PWA 只靠瀏覽器背景檢查而漏掉新版。

import { useState, useEffect, useRef } from "react";
import { RefreshCw, X } from "lucide-react";

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_CHECK_DEBOUNCE_MS = 5000;

export default function PwaUpdateBanner() {
  const [showBanner, setShowBanner] = useState(false);
  const dismissedRef = useRef(false);
  const registrationRef = useRef(null);

  const reloadForUpdate = () => {
    const waitingWorker = registrationRef.current?.waiting;
    if (!waitingWorker) {
      window.location.reload();
      return;
    }

    let didReload = false;
    const reloadOnce = () => {
      if (didReload) return;
      didReload = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true });
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    window.setTimeout(reloadOnce, 1500);
  };

  useEffect(() => {
    if (import.meta.env.DEV || !("serviceWorker" in navigator)) return undefined;

    let disposed = false;
    let activeRegistration = null;
    let isChecking = false;
    let lastCheckAt = 0;
    let hadController = Boolean(navigator.serviceWorker.controller);
    const cleanupCallbacks = [];

    const showUpdate = () => {
      if (disposed || !hadController || dismissedRef.current) return;
      setShowBanner(true);
    };

    const trackWorker = (worker) => {
      if (!worker) return;

      const handleStateChange = () => {
        if (worker.state === "installed" || worker.state === "activated") {
          showUpdate();
        }
      };

      worker.addEventListener("statechange", handleStateChange);
      cleanupCallbacks.push(() => worker.removeEventListener("statechange", handleStateChange));
      handleStateChange();
    };

    const attachRegistration = (registration) => {
      if (!registration || activeRegistration === registration) return;
      activeRegistration = registration;
      registrationRef.current = registration;

      trackWorker(registration.installing);
      trackWorker(registration.waiting);

      const handleUpdateFound = () => {
        trackWorker(registration.installing);
      };
      registration.addEventListener("updatefound", handleUpdateFound);
      cleanupCallbacks.push(() => registration.removeEventListener("updatefound", handleUpdateFound));

      if (registration.waiting) {
        showUpdate();
      }
    };

    const getRegistration = async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      registrationRef.current = registration;
      return registration;
    };

    const checkForUpdate = async (force = false) => {
      if (disposed || isChecking || !navigator.onLine) return;
      const now = Date.now();
      if (!force && now - lastCheckAt < UPDATE_CHECK_DEBOUNCE_MS) return;

      isChecking = true;
      lastCheckAt = now;
      try {
        const registration = activeRegistration ?? await getRegistration();
        attachRegistration(registration);
        await registration.update();
        if (registration.waiting) {
          showUpdate();
        }
      } catch {
        // 更新檢查失敗時維持目前版本，下次切回前景或 interval 會再試。
      } finally {
        isChecking = false;
      }
    };

    const handleControllerChange = () => {
      if (hadController) {
        showUpdate();
      }
      hadController = true;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkForUpdate(true);
      }
    };

    const handleFocus = () => checkForUpdate(true);
    const handleOnline = () => checkForUpdate(true);

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    cleanupCallbacks.push(
      () => navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange),
      () => document.removeEventListener("visibilitychange", handleVisibilityChange),
      () => window.removeEventListener("focus", handleFocus),
      () => window.removeEventListener("online", handleOnline),
    );

    getRegistration()
      .then((registration) => {
        attachRegistration(registration);
        checkForUpdate(true);
      })
      .catch(() => {});

    const intervalId = window.setInterval(() => checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
    const firstCheckId = window.setTimeout(() => checkForUpdate(true), 3000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.clearTimeout(firstCheckId);
      cleanupCallbacks.forEach((cleanup) => cleanup());
    };
  }, []);

  if (!showBanner) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 flex-wrap items-center gap-2 sm:gap-3 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
      <RefreshCw className="w-4 h-4 flex-shrink-0 text-indigo-400" />
      <span className="min-w-0 flex-1">已更新到新版本</span>
      <button
        onClick={reloadForUpdate}
        className="flex-shrink-0 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
      >
        立即重新載入
      </button>
      <button
        onClick={() => {
          dismissedRef.current = true;
          setShowBanner(false);
        }}
        className="flex-shrink-0 text-gray-400 hover:text-white transition-colors"
        title="稍後再說"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
