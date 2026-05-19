import { useRef } from "react";
import CompositionTextarea from "./CompositionTextarea";
import ResponsiveActionGroup, { responsiveActionItemClass } from "./ResponsiveActionGroup";
import { NAME_VARIABLE, insertTextToken } from "../utils/textVariables";

export default function TextVariableTextarea({
  value,
  defaultText,
  inheritedValue,
  hasOverride = false,
  onChange,
  onRestoreDefault,
  onScheduleSave,
  buttonGuideId,
  ...textareaProps
}) {
  const textareaRef = useRef(null);
  const { placeholder, ...textareaRestProps } = textareaProps;
  const visibleValue = hasOverride ? value : inheritedValue ?? defaultText ?? "";
  const statusText = hasOverride
    ? value === "" ? "空白輸出" : "自訂文字"
    : "使用預設文字";

  const updateText = (nextValue) => {
    onChange(nextValue);
  };

  const handleRestoreDefault = () => {
    onRestoreDefault?.();
    onScheduleSave?.();
  };

  const handleSetBlank = () => {
    onChange("");
    onScheduleSave?.();
  };

  const handleInsertName = () => {
    const textarea = textareaRef.current;
    const next = insertTextToken(
      textarea?.value ?? visibleValue ?? "",
      textarea?.selectionStart,
      textarea?.selectionEnd,
      NAME_VARIABLE,
    );
    onChange(next.text);
    onScheduleSave?.();
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="space-y-1 min-w-0">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        {defaultText ? (
          <div className="min-w-0 text-xs text-gray-400 truncate">
            {statusText} · 預設：{defaultText.substring(0, 25)}
          </div>
        ) : (
          <div className="min-w-0 text-xs text-gray-400">{statusText}</div>
        )}
        <ResponsiveActionGroup mobileColumns={2} className="gap-1.5 sm:flex-shrink-0">
          {hasOverride ? (
            <button
              type="button"
              onClick={handleRestoreDefault}
              className={`${responsiveActionItemClass} px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap`}
            >
              恢復預設
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSetBlank}
              className={`${responsiveActionItemClass} px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap`}
            >
              設為空白
            </button>
          )}
          <button
            type="button"
            onClick={handleInsertName}
            data-guide={buttonGuideId}
            className={`${responsiveActionItemClass} px-2 py-1 text-xs rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors whitespace-nowrap`}
          >
            插入 {NAME_VARIABLE}
          </button>
        </ResponsiveActionGroup>
      </div>
      <CompositionTextarea
        {...textareaRestProps}
        ref={textareaRef}
        placeholder={hasOverride ? "" : placeholder}
        value={visibleValue}
        onChange={updateText}
        onScheduleSave={onScheduleSave}
      />
    </div>
  );
}
