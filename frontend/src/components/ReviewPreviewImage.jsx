// 班級總覽的頁面縮圖：進視口才載入（IntersectionObserver）、
// module 層級單例佇列限制同時載入數（預覽圖是後端即時渲染，避免一次打爆），
// 失敗以指數退避自動重試，重試網址加 retry 參數 bust 掉瀏覽器的失敗快取。

import { useEffect, useRef, useState } from "react";
import { ImageOff, Loader2 } from "lucide-react";

const REVIEW_PREVIEW_CONCURRENCY = 3;
const REVIEW_PREVIEW_MAX_RETRIES = 4;
let activeReviewPreviewLoads = 0;
const queuedReviewPreviewLoads = [];

function pumpReviewPreviewQueue() {
  while (activeReviewPreviewLoads < REVIEW_PREVIEW_CONCURRENCY && queuedReviewPreviewLoads.length > 0) {
    const task = queuedReviewPreviewLoads.shift();
    if (!task || task.cancelled) continue;

    task.started = true;
    activeReviewPreviewLoads += 1;
    task.start(() => {
      if (task.released) return;
      task.released = true;
      activeReviewPreviewLoads = Math.max(0, activeReviewPreviewLoads - 1);
      pumpReviewPreviewQueue();
    });
  }
}

function enqueueReviewPreviewLoad(start) {
  const task = {
    cancelled: false,
    released: false,
    started: false,
    start,
  };
  queuedReviewPreviewLoads.push(task);
  pumpReviewPreviewQueue();

  return () => {
    if (task.released || task.cancelled) return;
    task.cancelled = true;

    if (!task.started) {
      const taskIndex = queuedReviewPreviewLoads.indexOf(task);
      if (taskIndex >= 0) queuedReviewPreviewLoads.splice(taskIndex, 1);
      return;
    }

    task.released = true;
    activeReviewPreviewLoads = Math.max(0, activeReviewPreviewLoads - 1);
    pumpReviewPreviewQueue();
  };
}

function withPreviewRetryParam(src, retryIndex) {
  if (retryIndex <= 0) return src;
  const separator = src.includes("?") ? "&" : "?";
  return `${src}${separator}retry=${retryIndex}`;
}

export default function ReviewPreviewImage({ src, alt, className }) {
  const containerRef = useRef(null);
  const releaseLoadSlotRef = useRef(null);
  const retryTimerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loadSrc, setLoadSrc] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [retryIndex, setRetryIndex] = useState(0);
  const [hasLoadError, setHasLoadError] = useState(false);

  useEffect(() => {
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    setLoadSrc("");
    setIsLoaded(false);
    setRetryIndex(0);
    setHasLoadError(false);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  }, [src]);

  useEffect(() => () => {
    window.clearTimeout(retryTimerRef.current);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        setIsVisible(true);
        observer.disconnect();
      },
      { rootMargin: "360px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || isLoaded || hasLoadError) return undefined;
    return enqueueReviewPreviewLoad(release => {
      releaseLoadSlotRef.current = release;
      setLoadSrc(withPreviewRetryParam(src, retryIndex));
    });
  }, [hasLoadError, isLoaded, isVisible, retryIndex, src]);

  const handleLoaded = () => {
    setIsLoaded(true);
    setHasLoadError(false);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;
  };

  const handleLoadFailed = () => {
    setLoadSrc("");
    setIsLoaded(false);
    releaseLoadSlotRef.current?.();
    releaseLoadSlotRef.current = null;

    if (retryIndex >= REVIEW_PREVIEW_MAX_RETRIES) {
      setHasLoadError(true);
      return;
    }

    const retryDelay = Math.min(1000 * (2 ** retryIndex), 5000);
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryIndex(current => current + 1);
    }, retryDelay);
  };

  return (
    <div ref={containerRef} className="relative h-24 w-full bg-gray-100">
      {loadSrc && (
        <img
          src={loadSrc}
          alt={alt}
          className={`${className} ${isLoaded ? "opacity-100" : "opacity-0"}`}
          onLoad={handleLoaded}
          onError={handleLoadFailed}
        />
      )}
      {!isLoaded && !hasLoadError && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        </div>
      )}
      {hasLoadError && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300">
          <ImageOff className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
