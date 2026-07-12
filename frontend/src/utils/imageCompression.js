// 上傳前的用戶端壓縮：手機原圖常是 4-12MB / 12-48MP，
// 相本輸出（A4@300dpi）長邊只需要 ~3500px，2560px 已綽綽有餘。
// 校園 WiFi 上行慢，先壓再傳可省 ~80% 傳輸時間，後端壓縮負擔也跟著消失。

const COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;
const MAX_LONG_EDGE = 2560;
const JPEG_QUALITY = 0.85;
// 瀏覽器能解碼的類型才在前端壓；HEIC 交給後端 pillow-heif
const COMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// 同一個 File 物件只壓一次（多次重試/多處引用共用結果）
const compressionCache = new WeakMap();

export function maybeCompressImageFile(file) {
  if (!file || file.size <= COMPRESS_THRESHOLD_BYTES) return Promise.resolve(file);
  if (!COMPRESSIBLE_TYPES.has((file.type || "").toLowerCase())) return Promise.resolve(file);
  if (compressionCache.has(file)) return compressionCache.get(file);

  const promise = (async () => {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const ratio = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
      canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext("2d");
      // PNG 透明區轉 JPEG 會變黑，先鋪白底（與後端 _flatten_to_rgb 同語意）
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();

      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      if (!blob || blob.size >= file.size) return file;

      const stem = (file.name || "photo").replace(/\.[^.]+$/, "");
      return new File([blob], `${stem}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
    } catch {
      // 解碼失敗（罕見格式等）就原檔上傳，後端還有一道壓縮防線
      return file;
    }
  })();
  compressionCache.set(file, promise);
  return promise;
}

/** 批次壓縮（並行 3），供批次分配精靈在選檔時先處理 */
export async function compressImageFiles(files) {
  const results = new Array(files.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const index = cursor++;
      results[index] = await maybeCompressImageFile(files[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  return results;
}
