export const DEFAULT_UI_FONT_SCALE = 1;
export const UI_FONT_SCALE_MIN = 0.9;
export const UI_FONT_SCALE_MAX = 1.25;
export const UI_FONT_SCALE_STEP = 0.05;

const BASE_FONT_SIZE_PX = 16;
const STORAGE_KEY = "albumMaker.uiFontScale";

export function normalizeUiFontScale(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return DEFAULT_UI_FONT_SCALE;
  const rounded = Math.round(numberValue * 100) / 100;
  return Math.min(UI_FONT_SCALE_MAX, Math.max(UI_FONT_SCALE_MIN, rounded));
}

function applyUiFontScale(value) {
  const scale = normalizeUiFontScale(value);
  if (typeof document !== "undefined") {
    document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * scale}px`;
    document.documentElement.style.setProperty("--ui-font-scale", String(scale));
  }
  return scale;
}

function storeUiFontScale(value) {
  const scale = normalizeUiFontScale(value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(scale));
    } catch {
      // 儲存失敗不影響伺服器端個人設定。
    }
  }
  return scale;
}

export function applyAndStoreUiFontScale(value) {
  const scale = applyUiFontScale(value);
  storeUiFontScale(scale);
  return scale;
}

export function applyStoredUiFontScale() {
  if (typeof window === "undefined") return DEFAULT_UI_FONT_SCALE;
  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);
    if (storedValue !== null) {
      return applyUiFontScale(storedValue);
    }
  } catch {
    // 無法讀取 localStorage 時維持預設字級。
  }
  return applyUiFontScale(DEFAULT_UI_FONT_SCALE);
}

export function resetStoredUiFontScale() {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 無法清除 localStorage 時仍套用預設字級。
    }
  }
  return applyUiFontScale(DEFAULT_UI_FONT_SCALE);
}
