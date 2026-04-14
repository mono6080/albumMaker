// IME 組字感知的 textarea
// 解決三個 iOS 中文輸入問題：
// 1. 組字期間 React re-render 回寫 value prop 干擾 IME → localValue 緩衝層
// 2. 切換分頁 compositionend 回傳損壞值（只剩注音）→ visibilitychange 主動還原
// 3. 防抖存檔觸發 re-render 打斷輸入 → 組字期間不呼叫 onScheduleSave

import { useState, useEffect, useRef } from "react";

export default function CompositionTextarea({ value, onChange, onScheduleSave, ...props }) {
  const [localValue, setLocalValue] = useState(value ?? "");
  const isComposingRef = useRef(false);
  // 記錄組字開始前的值，切換分頁時用來還原
  const preCompositionValueRef = useRef("");
  // 用 ref 持有最新 callback，避免 visibilitychange listener 相依外部函式
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  // 父層值更新時（非組字中）同步本地顯示
  useEffect(() => {
    if (!isComposingRef.current) {
      setLocalValue(value ?? "");
    }
  }, [value]);

  // 切換分頁時若正在組字，主動取消並還原組字前的值，
  // 避免 iOS compositionend 回傳只含注音符號的損壞值
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && isComposingRef.current) {
        isComposingRef.current = false;
        const restored = preCompositionValueRef.current;
        setLocalValue(restored);
        onChangeRef.current(restored);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  return (
    <textarea
      {...props}
      value={localValue}
      onChange={event => {
        const val = event.target.value;
        setLocalValue(val);
        if (!isComposingRef.current) {
          onChange(val);
          onScheduleSave();
        }
      }}
      onCompositionStart={() => {
        isComposingRef.current = true;
        preCompositionValueRef.current = localValue; // 保存組字前的完整文字
      }}
      onCompositionEnd={event => {
        isComposingRef.current = false;
        const val = event.target.value;
        setLocalValue(val);
        onChange(val);
        onScheduleSave();
      }}
    />
  );
}
