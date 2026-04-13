// 通用防抖自動儲存 Hook
// 封裝「延遲 N 毫秒後自動呼叫儲存函式」的共通邏輯，
// 避免各頁面各自維護 timer ref 和 latest-data ref

import { useRef, useCallback, useEffect, useState } from "react";

/**
 * 通用防抖自動儲存 Hook。
 *
 * @param {*}        currentData   - 目前的資料狀態（每次渲染都應傳入最新值）
 * @param {Function} saveCallback  - 實際執行儲存的非同步函式，接收 currentData 作為參數
 * @param {number}   delayMs       - 觸發儲存前的等待時間（毫秒），預設 500
 *
 * @returns {{
 *   scheduleSave: Function,   // 手動排程一次儲存（觸發防抖計時）
 *   cancelSave:   Function,   // 取消尚未執行的排程儲存
 *   flushSave:    Function,   // 立即執行並等待儲存完成（Promise）
 *   latestDataRef: React.MutableRefObject  // 永遠持有最新 currentData 的 ref
 * }}
 */
export function useAutoSave(currentData, saveCallback, delayMs = 500) {
  // 使用 ref 保存最新資料，避免 setTimeout 閉包內讀取到過時狀態
  const latestDataRef = useRef(currentData);
  useEffect(() => {
    latestDataRef.current = currentData;
  });

  // isSaving：儲存請求進行中時為 true，可用於 UI disable
  const [isSaving, setIsSaving] = useState(false);

  // 使用 ref 保存最新的儲存函式，避免因 callback 變動而重複觸發 useEffect
  const saveCallbackRef = useRef(saveCallback);
  useEffect(() => {
    saveCallbackRef.current = saveCallback;
  });

  // 定時器 ref，用於清除尚未執行的防抖計時
  const timerRef = useRef(null);
  // AbortController ref，用於取消進行中的舊請求
  const abortControllerRef = useRef(null);

  /** 排程一次防抖儲存：重複呼叫只有最後一次會真正執行 */
  const scheduleSave = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      // 取消上一個尚未完成的請求
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;
      setIsSaving(true);
      try {
        await saveCallbackRef.current(latestDataRef.current, signal);
      } finally {
        if (!signal.aborted) setIsSaving(false);
      }
    }, delayMs);
  }, [delayMs]);

  /** 取消尚未執行的排程儲存 */
  const cancelSave = useCallback(() => {
    clearTimeout(timerRef.current);
    abortControllerRef.current?.abort();
  }, []);

  /** 立即執行儲存並等待完成（用於提交前的強制同步） */
  const flushSave = useCallback(async () => {
    clearTimeout(timerRef.current);
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    setIsSaving(true);
    try {
      await saveCallbackRef.current(latestDataRef.current, abortControllerRef.current.signal);
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { scheduleSave, cancelSave, flushSave, latestDataRef, isSaving };
}
