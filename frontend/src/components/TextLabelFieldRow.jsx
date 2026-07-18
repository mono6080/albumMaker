// 文字面板共用的單一欄位列：編號 chip＋輸入框＋對齊控制＋字數提示
// 全班（ClassEdit）與個別（StudentTextPanel）共用，確保兩個 scope 樣式一致

import TextAlignControl from "./TextAlignControl";
import TextVariableTextarea from "./TextVariableTextarea";
import { MAX_LABEL_TEXT_LENGTH } from "../constants/textContent.js";

export default function TextLabelFieldRow({
  labelId,
  value,
  placeholder,
  defaultText,
  inheritedValue,
  hasOverride = false,
  align,
  disabled = false,
  onChange,
  onAlignChange,
  onRestoreDefault,
  onScheduleSave,
  buttonGuideId,
  maxLength = MAX_LABEL_TEXT_LENGTH,
}) {
  const len = value.length;
  return (
    <div className="flex gap-3 min-w-0">
      <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0 mt-1">
        <span className="text-xs font-bold text-indigo-400">{labelId}</span>
      </div>
      <div className="flex-1 min-w-0">
        <TextVariableTextarea
          rows={2}
          disabled={disabled}
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50 resize-none disabled:opacity-60"
          placeholder={placeholder}
          value={value}
          defaultText={defaultText}
          inheritedValue={inheritedValue}
          hasOverride={hasOverride}
          onChange={onChange}
          onRestoreDefault={onRestoreDefault}
          onScheduleSave={onScheduleSave}
          buttonGuideId={buttonGuideId}
          maxLength={maxLength}
        />
        {!disabled && (
          <TextAlignControl
            value={align}
            onChange={onAlignChange}
            onScheduleSave={onScheduleSave}
            className="mt-2"
          />
        )}
        {len > 0 && (
          <div className={`text-right text-xs mt-0.5 ${len >= maxLength * 0.9 ? "text-red-500" : "text-gray-300"}`}>
            {len}/{maxLength}
          </div>
        )}
      </div>
    </div>
  );
}
