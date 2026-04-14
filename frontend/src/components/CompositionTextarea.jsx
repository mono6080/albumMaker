// IME 組字感知的 textarea
// 組字期間（中文/日文/韓文輸入法）不排程儲存，compositionEnd 後才排程，
// 避免防抖存檔觸發 re-render 打斷中文輸入

import { useRef } from "react";

/**
 * @param {Function} onChange        - 接收 value 字串（非 event）
 * @param {Function} onScheduleSave  - 應排程儲存時呼叫
 * @param {object}   ...props        - 其餘 props 直接傳給 <textarea>
 */
export default function CompositionTextarea({ onChange, onScheduleSave, ...props }) {
  const isComposingRef = useRef(false);

  return (
    <textarea
      {...props}
      onChange={event => {
        onChange(event.target.value);
        if (!isComposingRef.current) onScheduleSave();
      }}
      onCompositionStart={() => { isComposingRef.current = true; }}
      onCompositionEnd={event => {
        isComposingRef.current = false;
        onChange(event.target.value);
        onScheduleSave();
      }}
    />
  );
}
