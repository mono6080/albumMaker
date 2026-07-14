import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_PREFIX = "album-maker:editor-style-preferences:v1";
const MAX_FAVORITES = 12;
const MAX_RECENT_COLORS = 8;
const MAX_RECENT_FONTS = 6;

const STYLE_FIELDS = {
  text: [
    "font_family",
    "font_size",
    "font_color",
    "text_align",
    "line_height",
    "letter_spacing",
    "text_shadow_enabled",
    "text_shadow_color",
    "text_shadow_offset_x",
    "text_shadow_offset_y",
    "text_shadow_blur",
    "text_shadow_opacity",
  ],
  photo: [
    "border",
    "border_width",
    "border_radius",
    "shadow_enabled",
    "shadow_offset_x",
    "shadow_offset_y",
    "shadow_blur",
    "shadow_opacity",
  ],
};

const EMPTY_PREFERENCES = {
  favorites: [],
  recentColors: [],
  recentFonts: [],
};

function readPreferences(storageKey) {
  if (typeof window === "undefined") return EMPTY_PREFERENCES;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    return {
      favorites: Array.isArray(parsed?.favorites) ? parsed.favorites.slice(0, MAX_FAVORITES) : [],
      recentColors: Array.isArray(parsed?.recentColors) ? parsed.recentColors.slice(0, MAX_RECENT_COLORS) : [],
      recentFonts: Array.isArray(parsed?.recentFonts) ? parsed.recentFonts.slice(0, MAX_RECENT_FONTS) : [],
    };
  } catch {
    return EMPTY_PREFERENCES;
  }
}

function persistPreferences(storageKey, preferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // 瀏覽器停用儲存空間時，編輯器本次操作仍維持可用。
  }
}

function pushRecent(values, nextValue, limit) {
  const normalized = String(nextValue ?? "").trim();
  if (!normalized) return values;
  return [normalized, ...values.filter(value => value !== normalized)].slice(0, limit);
}

export function pickEditorStyle(elementType, elementData) {
  const fields = STYLE_FIELDS[elementType] || [];
  return Object.fromEntries(fields.flatMap(field => (
    elementData?.[field] === undefined ? [] : [[field, elementData[field]]]
  )));
}

export default function useEditorStylePreferences(userId) {
  const storageKey = `${STORAGE_PREFIX}:${userId ?? "anonymous"}`;
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey));

  useEffect(() => {
    setPreferences(readPreferences(storageKey));
  }, [storageKey]);

  const updatePreferences = useCallback((updater) => {
    setPreferences(current => {
      const next = updater(current);
      persistPreferences(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const rememberStyleUpdates = useCallback((elementType, updates) => {
    if (!STYLE_FIELDS[elementType]) return;
    const nextColor = updates?.font_color ?? updates?.text_shadow_color;
    const nextFont = updates?.font_family;
    if (nextColor == null && nextFont == null) return;
    updatePreferences(current => ({
      ...current,
      recentColors: nextColor == null
        ? current.recentColors
        : pushRecent(current.recentColors, nextColor, MAX_RECENT_COLORS),
      recentFonts: nextFont == null
        ? current.recentFonts
        : pushRecent(current.recentFonts, nextFont, MAX_RECENT_FONTS),
    }));
  }, [updatePreferences]);

  const saveFavoriteStyle = useCallback((elementType, elementData, label) => {
    const style = pickEditorStyle(elementType, elementData);
    if (!STYLE_FIELDS[elementType] || Object.keys(style).length === 0) return;
    const defaultLabel = elementType === "text" ? "文字樣式" : "照片樣式";
    const id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    updatePreferences(current => ({
      ...current,
      favorites: [{
        id,
        type: elementType,
        label: String(label || `${defaultLabel} ${current.favorites.filter(item => item.type === elementType).length + 1}`),
        style,
      }, ...current.favorites].slice(0, MAX_FAVORITES),
    }));
  }, [updatePreferences]);

  const removeFavoriteStyle = useCallback((favoriteId) => {
    updatePreferences(current => ({
      ...current,
      favorites: current.favorites.filter(item => item.id !== favoriteId),
    }));
  }, [updatePreferences]);

  return useMemo(() => ({
    favoriteStyles: preferences.favorites,
    recentColors: preferences.recentColors,
    recentFonts: preferences.recentFonts,
    rememberStyleUpdates,
    saveFavoriteStyle,
    removeFavoriteStyle,
  }), [preferences, rememberStyleUpdates, removeFavoriteStyle, saveFavoriteStyle]);
}
