// 「最後一個請求才算數」的協調器。
//
// 使用者連續切換選項（學期、期別、頁面）時會連發多個請求，而它們回來的順序不保證。
// 舊請求晚回來就會把新選擇的畫面蓋掉——使用者看到的是他兩秒前選的那一個，而且畫面上
// 沒有任何異常。這種錯只會做錯、不會報錯，所以規則必須寫在一個地方而不是每頁重寫一次。
//
// 抽出來的第二個理由是可測性：在瀏覽器裡要靠攔截網路、人工延遲回應才能重現這種競態，
// 慢又不穩；抽成純模組之後，用可控的 promise 就能精確排出任何交錯順序。

export function createLatestRequestCoordinator(options = {}) {
  const newAbortController = options.createAbortController
    ?? (() => new AbortController());
  let sequence = 0;
  let inFlight = null;

  return {
    get isPending() {
      return inFlight !== null;
    },

    /** 中止目前這一個（例如元件卸載）。之後回來的結果一律不算數。 */
    abort() {
      inFlight?.abort();
      inFlight = null;
      sequence += 1;
    },

    /**
     * 發起一個請求；先前未完成的會被中止。
     * `task(signal)` 之外的四個 callback 只有在「這一個仍是最新」時才會被呼叫。
     */
    async run(task, handlers = {}) {
      inFlight?.abort();
      const controller = newAbortController();
      inFlight = controller;
      sequence += 1;
      const mySequence = sequence;
      const isCurrent = () => mySequence === sequence;

      handlers.onStart?.();
      try {
        const result = await task(controller.signal);
        if (!isCurrent()) return;
        handlers.onResult?.(result);
      } catch (error) {
        // 被自己中止、或已經被更新的請求取代，都不該把錯誤丟到畫面上
        if (controller.signal.aborted || !isCurrent()) return;
        handlers.onError?.(error);
      } finally {
        if (isCurrent()) {
          inFlight = null;
          handlers.onSettled?.();
        }
      }
    },
  };
}
