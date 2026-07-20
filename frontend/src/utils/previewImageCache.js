// 預覽圖 blob 快取：用 fetch 把預覽 PNG 抓成 object URL 存在記憶體，
// <img> 只吃 blob URL、不碰網路。
//
// 為什麼不直接讓 <img src> 指到 API：正式站前面是 Cloudflare + nginx h2，
// 切頁 abort 的圖片載入會在瀏覽器連線層留下殘影，導致「切回原頁」的同 URL
// 請求 stall 十幾秒；而且 <img> 對被中斷載入有 dedup 怪癖。改走 fetch 後：
//   1. 預覽 URL 是內容定址（帶 t / revision / render_build），bytes 不可變，
//      抓到就能永久快取——切回看過的頁是記憶體命中，零網路、即時。
//   2. fetch 有 AbortController + timeout，只會 resolve / reject / 逾時，
//      不會像 <img> 那樣無聲卡死，不需要 watchdog。
//   3. 切走時不 abort 進行中的 fetch（讓它抓完暖快取），但受 timeout 保護。
//
// 依賴注入（fetchImpl / createObjectURL / revokeObjectURL）讓此模組可用
// Node 單元測試釘住 LRU、in-flight 去重與失敗傳播。

const DEFAULT_MAX_ENTRIES = 48;
const DEFAULT_TIMEOUT_MS = 12000;

export function createPreviewBlobCache({
  fetchImpl = (...args) => fetch(...args),
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  maxEntries = DEFAULT_MAX_ENTRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const cache = new Map(); // url -> blobUrl（插入順序即 LRU）
  const inflight = new Map(); // url -> Promise<blobUrl>

  function touch(url) {
    const blobUrl = cache.get(url);
    cache.delete(url);
    cache.set(url, blobUrl);
  }

  function evictIfNeeded() {
    while (cache.size > maxEntries) {
      const oldestUrl = cache.keys().next().value;
      const oldestBlob = cache.get(oldestUrl);
      cache.delete(oldestUrl);
      revokeObjectURL(oldestBlob);
    }
  }

  function getCached(url) {
    if (!cache.has(url)) return null;
    touch(url);
    return cache.get(url);
  }

  function load(url) {
    const cached = getCached(url);
    if (cached) return Promise.resolve(cached);
    const pending = inflight.get(url);
    if (pending) return pending;

    const promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error(`preview fetch ${response.status}`);
        const blob = await response.blob();
        const blobUrl = createObjectURL(blob);
        cache.set(url, blobUrl);
        evictIfNeeded();
        return blobUrl;
      } finally {
        clearTimeout(timer);
        inflight.delete(url);
      }
    })();
    inflight.set(url, promise);
    return promise;
  }

  return { load, getCached, cache, inflight };
}

export const previewBlobCache = createPreviewBlobCache();
