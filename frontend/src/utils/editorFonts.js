const EDITOR_FONT_REQUESTS = [
  ['400 16px "Album Noto Sans TC"', "相本Aa"],
  ['700 16px "Album Noto Sans TC"', "相本Aa"],
  ['400 16px "Album Noto Serif TC"', "相本Aa"],
];
const EDITOR_FONT_LOAD_TIMEOUT_MS = 45_000;
export const EDITOR_FONT_ERROR_CODES = Object.freeze({
  API_UNAVAILABLE: "editor_font_api_unavailable",
  LOAD_FAILED: "editor_font_load_failed",
  TIMEOUT: "editor_font_timeout",
  UNAVAILABLE: "editor_font_unavailable",
});

function createEditorFontError(code, message, cause = undefined) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

export function shouldRetryEditorFontsInPage(error) {
  return error?.code === EDITOR_FONT_ERROR_CODES.TIMEOUT;
}

function loadRequiredEditorFontFaces({
  fontSet,
  timeoutMs,
  setTimeoutFn,
  clearTimeoutFn,
}) {
  return new Promise((resolve, reject) => {
    let isSettled = false;
    let timeoutId = null;

    const handleLoadingError = () => {
      settle(
        reject,
        createEditorFontError(
          EDITOR_FONT_ERROR_CODES.LOAD_FAILED,
          "Required editor font faces failed to load",
        ),
      );
    };
    const cleanup = () => {
      if (timeoutId !== null) clearTimeoutFn(timeoutId);
      fontSet.removeEventListener?.("loadingerror", handleLoadingError);
    };
    const settle = (callback, value) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      callback(value);
    };

    fontSet.addEventListener?.("loadingerror", handleLoadingError);
    timeoutId = setTimeoutFn(() => {
      settle(
        reject,
        createEditorFontError(
          EDITOR_FONT_ERROR_CODES.TIMEOUT,
          "Editor font loading timed out",
        ),
      );
    }, timeoutMs);

    Promise.all(
      EDITOR_FONT_REQUESTS.map(([font, sample]) => fontSet.load(font, sample)),
    ).then(
      (loadedFontFaces) => {
        if (loadedFontFaces.some(fontFaces => fontFaces.length === 0)) {
          settle(
            reject,
            createEditorFontError(
              EDITOR_FONT_ERROR_CODES.UNAVAILABLE,
              "Required editor font faces are unavailable",
            ),
          );
          return;
        }
        settle(resolve, true);
      },
      error => settle(
        reject,
        createEditorFontError(
          EDITOR_FONT_ERROR_CODES.LOAD_FAILED,
          "Required editor font faces failed to load",
          error,
        ),
      ),
    );
  });
}

/**
 * 模板編輯器在 Konva 首次量字前等待共用字型。失敗 attempt 會保留，
 * 確保 StrictMode／路由重掛仍看到同一錯誤；只有明確 retry 才建立新 attempt。
 */
export function createEditorFontLoader({
  getFontSet = () => globalThis.document?.fonts,
  timeoutMs = EDITOR_FONT_LOAD_TIMEOUT_MS,
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = timeoutId => globalThis.clearTimeout(timeoutId),
} = {}) {
  let editorFontsPromise = null;

  const loadEditorFonts = () => {
    if (editorFontsPromise) return editorFontsPromise;
    const fontSet = getFontSet();
    if (!fontSet?.load) {
      editorFontsPromise = Promise.reject(
        createEditorFontError(
          EDITOR_FONT_ERROR_CODES.API_UNAVAILABLE,
          "FontFaceSet API is unavailable",
        ),
      );
      return editorFontsPromise;
    }

    editorFontsPromise = loadRequiredEditorFontFaces({
      fontSet,
      timeoutMs,
      setTimeoutFn,
      clearTimeoutFn,
    });
    return editorFontsPromise;
  };

  const retryEditorFonts = () => {
    editorFontsPromise = null;
  };

  return { loadEditorFonts, retryEditorFonts };
}

const editorFontLoader = createEditorFontLoader();
export const {
  loadEditorFonts,
  retryEditorFonts,
} = editorFontLoader;
