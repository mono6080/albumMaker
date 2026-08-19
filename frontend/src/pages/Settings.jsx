import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { RotateCcw, Save, Type } from "lucide-react";

import { updateMySettings } from "../api/authApi";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../utils/apiError";
import {
  DEFAULT_UI_FONT_SCALE,
  UI_FONT_SCALE_MAX,
  UI_FONT_SCALE_MIN,
  UI_FONT_SCALE_STEP,
  normalizeUiFontScale,
} from "../utils/uiPreferences";

const FONT_SCALE_OPTIONS = [
  { label: "小", value: 0.9 },
  { label: "標準", value: 1 },
  { label: "大", value: 1.1 },
  { label: "較大", value: 1.15 },
  { label: "最大", value: 1.25 },
];

function toPercent(scale) {
  return Math.round(normalizeUiFontScale(scale) * 100);
}

export default function Settings() {
  const { currentUser, updateCurrentUser } = useAuth();
  const savedScale = normalizeUiFontScale(currentUser?.ui_font_scale);
  const [fontScale, setFontScale] = useState(savedScale);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setFontScale(savedScale);
  }, [savedScale]);

  const fontScalePercent = toPercent(fontScale);
  const hasChanges = useMemo(
    () => Math.abs(normalizeUiFontScale(fontScale) - savedScale) > 0.001,
    [fontScale, savedScale],
  );

  const handleSave = async () => {
    const nextScale = normalizeUiFontScale(fontScale);
    setIsSaving(true);
    try {
      const response = await updateMySettings({ ui_font_scale: nextScale });
      updateCurrentUser(response.data);
      toast.success("設定已儲存");
    } catch (error) {
      toast.error(getApiErrorMessage(error, "設定儲存失敗"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center border border-indigo-100">
          <Type className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900">設定</h1>
          <p className="text-sm text-gray-500 truncate">{currentUser?.display_name}</p>
        </div>
      </div>

      <section className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 sm:p-6 space-y-5">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-gray-900">UI 字體大小</h2>
          <p className="text-sm text-gray-500">目前設定：{toPercent(savedScale)}%</p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {FONT_SCALE_OPTIONS.map((option) => {
            const isSelected = Math.abs(option.value - normalizeUiFontScale(fontScale)) < 0.001;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setFontScale(option.value)}
                className={`min-w-0 px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors ${
                  isSelected
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
                }`}
              >
                <span className="block truncate">{option.label}</span>
                <span className={`block text-xs ${isSelected ? "text-indigo-100" : "text-gray-400"}`}>
                  {toPercent(option.value)}%
                </span>
              </button>
            );
          })}
        </div>

        <label className="block space-y-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-gray-700">自訂大小</span>
            <span className="text-gray-500">{fontScalePercent}%</span>
          </div>
          <input
            type="range"
            min={UI_FONT_SCALE_MIN}
            max={UI_FONT_SCALE_MAX}
            step={UI_FONT_SCALE_STEP}
            value={fontScale}
            onChange={(event) => setFontScale(normalizeUiFontScale(event.target.value))}
            className="w-full accent-indigo-600"
          />
        </label>

        <div
          className="rounded-xl border border-gray-200 bg-gray-50 p-4"
          style={{ fontSize: `${15 * normalizeUiFontScale(fontScale)}px` }}
        >
          <div className="font-semibold text-gray-900">預覽文字</div>
          <div className="mt-1 text-gray-600">張小明 · 審閱完成 · 今天的照片都很清楚</div>
          <button
            type="button"
            className="mt-3 px-3 py-2 rounded-lg bg-indigo-600 text-white font-medium"
          >
            按鈕預覽
          </button>
        </div>

        <div className="grid grid-cols-2 sm:flex sm:justify-end gap-2">
          <button
            type="button"
            onClick={() => setFontScale(DEFAULT_UI_FONT_SCALE)}
            className="min-w-0 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            預設
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving || !hasChanges}
            className="min-w-0 flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            <Save className="w-4 h-4" />
            {isSaving ? "儲存中" : "儲存設定"}
          </button>
        </div>
      </section>
    </div>
  );
}
