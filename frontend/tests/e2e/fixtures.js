// 每個 Playwright worker 對到自己那一組 (vite, backend)。
//
// 為什麼需要這個：整套 e2e 原本共用一個後端與一份 SQLite，跑越後面的測試要面對前面
// 所有測試累積下來的資料——同一條測試「單獨跑會過、跑全套會掛」，而且因為怕互相踩，
// `workers` 只能是 1，126 條測試只好序列跑。改成一個 worker 一套之後，資料天然隔離，
// 平行也才安全。
/* eslint-disable no-empty-pattern, react-hooks/rules-of-hooks --
   Playwright 的 fixture 規定第一個參數必須是物件解構（它靠解構的內容判斷相依），
   而這裡不需要任何既有 fixture；`use` 是 Playwright 的 API，不是 React hook。 */
import { test as base, expect } from "@playwright/test";

import { setE2eBaseUrl } from "./helpers.js";

// baseURL 是 Playwright 內建的 test-scope fixture，不能改成 worker-scope，
// 但 testInfo.parallelIndex 就是 worker 編號，一樣拿得到。
export const test = base.extend({
  baseURL: async ({}, use, testInfo) => {
    const url = `http://127.0.0.1:${5173 + testInfo.parallelIndex}`;
    // helpers 裡有些地方要絕對網址（例如寫 cookie），worker 是獨立 process，
    // 模組層的變數天然是 worker-local。
    setE2eBaseUrl(url);
    await use(url);
  },
});

export { expect };
