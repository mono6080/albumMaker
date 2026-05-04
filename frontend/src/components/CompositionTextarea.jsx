// IME 組字感知的 textarea
// 解決 iOS 中文（注音）輸入三個問題：
// 1. 組字期間 React re-render 回寫 value → localValue 緩衝層，組字中不更新父層
// 2. compositionend / visibilitychange 觸發順序不確定 → 雙重防護：
//    a. visibilitychange 設旗標（頁面隱藏時是否在組字）
//    b. compositionend 驗證值的合理性（新值比組字前短且不以組字前文字開頭）
//    任一條件成立即還原組字前的值
// 3. 防抖存檔觸發 re-render 打斷輸入 → 組字中不呼叫 onScheduleSave

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const CompositionTextarea = forwardRef(function CompositionTextarea({ value, onChange, onScheduleSave, ...props }, forwardedRef) {
  const [localValue, setLocalValue] = useState(value ?? "");
  const textareaRef = useRef(null);
  const isComposingRef = useRef(false);
  const preCompositionValueRef = useRef("");   // 組字開始前的完整文字
  const pageHiddenWhileComposingRef = useRef(false); // 組字中是否發生過頁面隱藏

  useImperativeHandle(forwardedRef, () => textareaRef.current);

  // 父層值更新時（非組字中）同步本地顯示
  useEffect(() => {
    if (!isComposingRef.current) {
      setLocalValue(value ?? "");
    }
  }, [value]);

  // visibilitychange：頁面隱藏時若正在組字，設旗標
  // （不在此直接還原，因為 compositionend 的觸發順序不確定）
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isComposingRef.current) {
        pageHiddenWhileComposingRef.current = true;
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={localValue}
      onChange={event => {
        const val = event.target.value;
        setLocalValue(val);
        if (!isComposingRef.current) {
          onChange(val);
          onScheduleSave?.();
        }
      }}
      onCompositionStart={() => {
        isComposingRef.current = true;
        pageHiddenWhileComposingRef.current = false;
        preCompositionValueRef.current = localValue;
      }}
      onCompositionEnd={event => {
        isComposingRef.current = false;
        let val = event.target.value;
        const preVal = preCompositionValueRef.current;
        const pageWasHidden = pageHiddenWhileComposingRef.current;
        pageHiddenWhileComposingRef.current = false;

        // iOS 切換分頁 bug 偵測（雙重條件任一成立即視為損壞值）：
        // 條件 A：visibilitychange 旗標（頁面隱藏發生在組字期間）
        // 條件 B：值比組字前短，且不以組字前文字開頭（如只剩注音符號 ㄓㄨㄥ）
        const isValueCorrupted = pageWasHidden || (
          preVal.length > 0
          && val.length < preVal.length
          && !val.startsWith(preVal.slice(0, val.length))
        );

        if (isValueCorrupted) val = preVal; // 還原組字前的完整文字

        setLocalValue(val);
        onChange(val);
        if (!isValueCorrupted) onScheduleSave?.(); // 損壞 = 組字被取消，值未真正變更
      }}
    />
  );
});

export default CompositionTextarea;
