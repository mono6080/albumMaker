import { useRef } from "react";
import CompositionTextarea from "./CompositionTextarea";
import ResponsiveActionGroup, { responsiveActionItemClass } from "./ResponsiveActionGroup";
import {
  NAME_VARIABLE,
  STUDENT_NAME_VARIABLES,
  insertTextToken,
} from "../utils/textVariables";

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
  // disabled 同時作用於 textarea 與三顆操作鈕（專案完成鎖定時整組唯讀）
  const { placeholder, disabled = false, ...textareaRestProps } = textareaProps;
  const visibleValue = hasOverride ? value : inheritedValue ?? defaultText ?? "";
  const statusText = hasOverride
    ? value === "" ? "空白輸出" : "自訂文字"
    : "使用預設文字";
  const maxLength = Number(textareaProps.maxLength);
  const clampText = nextValue => (
    Number.isFinite(maxLength) && maxLength >= 0
      ? nextValue.slice(0, maxLength)
      : nextValue
  );

  const updateText = (nextValue) => {
    onChange(clampText(nextValue));
  };

  const handleRestoreDefault = () => {
    onRestoreDefault?.();
    onScheduleSave?.();
  };

  const handleSetBlank = () => {
    onChange("");
    onScheduleSave?.();
  };

  const handleInsertVariable = (token) => {
    const textarea = textareaRef.current;
    const next = insertTextToken(
      textarea?.value ?? visibleValue ?? "",
      textarea?.selectionStart,
      textarea?.selectionEnd,
      token,
    );
    const boundedText = clampText(next.text);
    onChange(boundedText);
    onScheduleSave?.();
    requestAnimationFrame(() => {
      textarea?.focus();
      const caret = Math.min(next.caret, boundedText.length);
      textarea?.setSelectionRange(caret, caret);
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
              disabled={disabled}
              className={`${responsiveActionItemClass} px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap disabled:pointer-events-none disabled:opacity-40`}
            >
              恢復預設
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSetBlank}
              disabled={disabled}
              className={`${responsiveActionItemClass} px-2 py-1 text-xs rounded-lg border border-gray-200 text-gray-600 bg-white hover:bg-gray-50 transition-colors whitespace-nowrap disabled:pointer-events-none disabled:opacity-40`}
            >
              設為空白
            </button>
          )}
          {STUDENT_NAME_VARIABLES.map(variable => (
            <button
              key={variable.token}
              type="button"
              onClick={() => handleInsertVariable(variable.token)}
              data-guide={variable.token === NAME_VARIABLE
                ? buttonGuideId
                : buttonGuideId ? `${buttonGuideId}-full-name` : undefined}
              title={variable.description}
              disabled={disabled}
              className={`${responsiveActionItemClass} px-2 py-1 text-xs rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors whitespace-nowrap disabled:pointer-events-none disabled:opacity-40`}
            >
              {variable.label} {variable.token}
            </button>
          ))}
        </ResponsiveActionGroup>
      </div>
      <CompositionTextarea
        {...textareaRestProps}
        ref={textareaRef}
        disabled={disabled}
        placeholder={hasOverride ? "" : placeholder}
        value={visibleValue}
        onChange={updateText}
        onScheduleSave={onScheduleSave}
      />
    </div>
  );
}
