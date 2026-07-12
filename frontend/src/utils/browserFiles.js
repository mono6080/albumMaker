export const getApiPath = (url) => (url.startsWith("/api") ? url.slice(4) : url);

export const getFilenameFromDisposition = (disposition = "", fallbackFilename) => {
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1]);

  const asciiMatch = disposition.match(/filename="([^"]+)"/i);
  return asciiMatch ? asciiMatch[1] : fallbackFilename;
};

export const downloadBlob = (blob, filename) => {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
};

export const fetchApiBlob = async (apiClient, url) => {
  const response = await apiClient.get(getApiPath(url), { responseType: "blob" });
  return {
    blob: response.data,
    disposition: response.headers["content-disposition"] ?? "",
  };
};

export const downloadApiBlob = async (apiClient, url, fallbackFilename) => {
  const { blob, disposition } = await fetchApiBlob(apiClient, url);
  const filename = getFilenameFromDisposition(disposition, fallbackFilename);
  downloadBlob(blob, filename);
  return filename;
};

// 大 ZIP 走瀏覽器原生下載（cookie 認證照常帶）：
// 不經 axios blob — 避免 timeout 與整包塞進記憶體
export const triggerNativeDownload = (url) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

export const createFileFromBlob = (blob, filename, fallbackType = "application/octet-stream") => {
  if (typeof File === "undefined") return null;
  return new File([blob], filename, { type: blob.type || fallbackType });
};

export const isMobileDevice = () => {
  if (typeof window === "undefined") return false;

  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent ?? "";
  const platform = typeof navigator === "undefined" ? "" : navigator.platform ?? "";
  const maxTouchPoints = typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints ?? 0;
  const hasCoarsePointerOnly = (
    window.matchMedia?.("(pointer: coarse)")?.matches &&
    !window.matchMedia?.("(pointer: fine)")?.matches
  );

  return (
    /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1) ||
    hasCoarsePointerOnly
  );
};

export const shareFiles = async (files, title) => {
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "insecure";
  }

  if (!files.length || typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return "unsupported";
  }

  const shareData = title ? { files, title } : { files };
  if (typeof navigator.canShare === "function" && !navigator.canShare(shareData)) {
    return "cannot-share";
  }

  try {
    await navigator.share(shareData);
    return "shared";
  } catch (error) {
    return error?.name === "AbortError" ? "cancelled" : "failed";
  }
};

export const getShareFailureMessage = (result) => {
  if (result === "insecure") return "分享圖片需要 HTTPS，請改用正式網址或 HTTPS 測試網址";
  if (result === "cannot-share") return "此瀏覽器不支援分享這些圖片，請改用單張預覽或下載圖片";
  if (result === "unsupported") return "此瀏覽器不支援分享圖片，請改按下載圖片";
  return "分享圖片失敗，請改按下載圖片";
};
