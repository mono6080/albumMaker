// 回傳「停止變動後」的值：抑制快速連續變動（切頁、切學生）觸發的網路請求
//
// 語意是 leading + trailing debounce：距上次變動已超過 delayMs 時立即跟上
// （單次切換不加延遲），連續快速變動時只在停下來後套用最後一個值——
// 中間路過的頁面／學生不會發出預覽與縮圖請求。

import { useEffect, useRef, useState } from "react";

export const SWITCH_SETTLE_MS = 300;

export function useSettledValue(value, delayMs = SWITCH_SETTLE_MS) {
  const [settled, setSettled] = useState(value);
  const lastChangeAtRef = useRef(Number.NEGATIVE_INFINITY);

  useEffect(() => {
    const now = Date.now();
    const isBurst = now - lastChangeAtRef.current < delayMs;
    lastChangeAtRef.current = now;
    if (!isBurst) {
      setSettled(value);
      return undefined;
    }
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
