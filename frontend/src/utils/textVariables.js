export const NAME_VARIABLE = "{name}";

function clampIndex(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) return max;
  return Math.max(min, Math.min(max, value));
}

export function insertTextToken(value = "", selectionStart, selectionEnd, token = NAME_VARIABLE) {
  const sourceText = String(value ?? "");
  const start = clampIndex(selectionStart, 0, sourceText.length);
  const end = clampIndex(selectionEnd, start, sourceText.length);
  const text = `${sourceText.slice(0, start)}${token}${sourceText.slice(end)}`;
  return { text, caret: start + token.length };
}

export function restoreFallbackWhenEmpty(value = "", fallbackValue = "") {
  return value === "" ? String(fallbackValue ?? "") : value;
}
