import { useRef } from "react";
import CompositionTextarea from "./CompositionTextarea";
import { NAME_VARIABLE, insertTextToken, restoreFallbackWhenEmpty } from "../utils/textVariables";

export default function TextVariableTextarea({
  value,
  fallbackValue = "",
  defaultText,
  onChange,
  onScheduleSave,
  buttonGuideId,
  ...textareaProps
}) {
  const textareaRef = useRef(null);

  const updateText = (nextValue) => {
    onChange(restoreFallbackWhenEmpty(nextValue, fallbackValue));
  };

  const handleInsertName = () => {
    const textarea = textareaRef.current;
    const next = insertTextToken(
      textarea?.value ?? value ?? "",
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
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        {defaultText ? (
          <div className="text-xs text-gray-400 truncate">
            預設：{defaultText.substring(0, 25)}
          </div>
        ) : <span />}
        <button
          type="button"
          onClick={handleInsertName}
          data-guide={buttonGuideId}
          className="flex-shrink-0 px-2 py-1 text-xs rounded-lg border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors"
        >
          插入 {NAME_VARIABLE}
        </button>
      </div>
      <CompositionTextarea
        {...textareaProps}
        ref={textareaRef}
        value={value}
        onChange={updateText}
        onScheduleSave={onScheduleSave}
      />
    </div>
  );
}
