// IME 組字感知的 textarea
// 組字期間（中文/日文/韓文輸入法）只更新本地顯示狀態，不傳給父層，
// 避免 React re-render 回寫 value prop 干擾瀏覽器 IME。
// compositionEnd 後才一次同步最終值並排程儲存。

import { useState, useEffect, useRef } from "react";

/**
 * @param {string}   value          - 父層控制的值
 * @param {Function} onChange       - 接收 value 字串（非 event），組字結束後呼叫
 * @param {Function} onScheduleSave - 應排程儲存時呼叫
 * @param {object}   ...props       - 其餘 props 直接傳給 <textarea>
 */
export default function CompositionTextarea({ value, onChange, onScheduleSave, ...props }) {
  const [localValue, setLocalValue] = useState(value ?? "");
  const isComposingRef = useRef(false);

  // 父層值更新時（非組字中）同步本地顯示
  useEffect(() => {
    if (!isComposingRef.current) {
      setLocalValue(value ?? "");
    }
  }, [value]);

  return (
    <textarea
      {...props}
      value={localValue}
      onChange={event => {
        const val = event.target.value;
        setLocalValue(val);                   // 永遠更新本地顯示（含組字中間狀態）
        if (!isComposingRef.current) {
          onChange(val);                      // 非組字：立即同步父層
          onScheduleSave();
        }
      }}
      onCompositionStart={() => { isComposingRef.current = true; }}
      onCompositionEnd={event => {
        isComposingRef.current = false;
        const val = event.target.value;
        setLocalValue(val);
        onChange(val);                        // 組字結束：同步最終值到父層
        onScheduleSave();
      }}
    />
  );
}
