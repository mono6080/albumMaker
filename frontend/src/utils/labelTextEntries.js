export const TEXT_ALIGN_VALUES = ["left", "center", "right"];

function normalizeTextAlign(value, fallback = "center") {
  return TEXT_ALIGN_VALUES.includes(value) ? value : fallback;
}

function isLabelEntryObject(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry);
}

export function getLabelEntryTextOverride(entry) {
  if (isLabelEntryObject(entry)) {
    return Object.prototype.hasOwnProperty.call(entry, "text") && entry.text != null
      ? String(entry.text)
      : undefined;
  }
  if (entry == null) return undefined;
  return String(entry);
}

export function getLabelEntryText(entry, fallback = "") {
  const textOverride = getLabelEntryTextOverride(entry);
  return textOverride === undefined ? fallback : textOverride;
}

export function hasLabelEntryTextOverride(entry) {
  return getLabelEntryTextOverride(entry) !== undefined;
}

export function getLabelEntryAlign(entry, fallback = "center") {
  if (isLabelEntryObject(entry)) {
    return normalizeTextAlign(entry.text_align, fallback);
  }
  return fallback;
}

export function withLabelEntryText(entry, text, fallbackAlign = "center") {
  const align = getLabelEntryAlign(entry, fallbackAlign);
  if (isLabelEntryObject(entry) || align !== fallbackAlign) {
    return { ...(isLabelEntryObject(entry) ? entry : {}), text, text_align: align };
  }
  return text;
}

export function withLabelEntryAlign(entry, textAlign, fallbackAlign = "center") {
  const nextAlign = normalizeTextAlign(textAlign, fallbackAlign);
  const textOverride = getLabelEntryTextOverride(entry);
  const nextEntry = isLabelEntryObject(entry) ? { ...entry } : {};

  if (textOverride !== undefined) {
    nextEntry.text = textOverride;
  }

  if (nextAlign === fallbackAlign) {
    delete nextEntry.text_align;
  } else {
    nextEntry.text_align = nextAlign;
  }

  if (Object.keys(nextEntry).length === 0) return undefined;
  if (Object.keys(nextEntry).length === 1 && Object.prototype.hasOwnProperty.call(nextEntry, "text")) {
    return nextEntry.text;
  }
  return nextEntry;
}

export function withoutLabelEntryText(entry, fallbackAlign = "center") {
  const align = getLabelEntryAlign(entry, fallbackAlign);
  if (align !== fallbackAlign) return { text_align: align };
  return undefined;
}
