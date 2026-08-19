// 後端錯誤形狀的唯一解讀器。
//
// 2026-08 盤點時，這支一條測試都沒有，而各頁另外自寫了 8 套弱化版：有的只認字串、
// 有的只認字串＋message、有的只認字串＋驗證陣列、還有兩處直接把可能是物件的 detail
// 丟給 toast。收斂成一支之後，四種形狀由這裡釘住——少接住任何一種，使用者就只會
// 看到 fallback，而後端其實已經說明了原因。

import assert from "node:assert/strict";

import { test } from "./harness.mjs";
import { getApiErrorMessage, isProjectTemplateRevisionError } from "../../src/utils/apiError.js";

const FALLBACK = "操作失敗，請稍後再試";

function errorWith(detail) {
  return { response: { data: { detail } } };
}

test("字串 detail 直接顯示", () => {
  assert.equal(getApiErrorMessage(errorWith("帳號或密碼錯誤")), "帳號或密碼錯誤");
});

test("結構化 detail 顯示 message 欄位", () => {
  assert.equal(
    getApiErrorMessage(errorWith({ code: "student_serial_too_long", message: "學號不可超過 64 個字" })),
    "學號不可超過 64 個字",
  );
});

test("完成鎖代碼組成專用句子，不是顯示原始 code", () => {
  const message = getApiErrorMessage(errorWith({
    code: "student_content_incomplete",
    photo_filled: 3, photo_total: 5, text_filled: 1, text_total: 4,
  }));
  assert.match(message, /照片 3\/5/);
  assert.match(message, /文字 1\/4/);
});

test("FastAPI 驗證錯誤陣列要攤成訊息，不能落到 fallback", () => {
  // 這是 admin 用短密碼建帳號時後端實際回的形狀（loc/type/input 省略無妨）
  const message = getApiErrorMessage(errorWith([
    { type: "string_too_short", loc: ["body", "password"], msg: "String should have at least 8 characters" },
  ]));
  assert.equal(message, "String should have at least 8 characters");
  assert.notEqual(message, FALLBACK);
});

test("多筆驗證錯誤全部列出", () => {
  const message = getApiErrorMessage(errorWith([
    { msg: "String should have at least 1 character" },
    { msg: "Field required" },
  ]));
  assert.equal(message, "String should have at least 1 character；Field required");
});

test("空陣列不算訊息，退回 fallback", () => {
  assert.equal(getApiErrorMessage(errorWith([])), FALLBACK);
});

test("物件 detail 沒有 message 也沒有已知 code 時退回 fallback，不得回傳物件", () => {
  const message = getApiErrorMessage(errorWith({ code: "some_unmapped_code" }));
  assert.equal(typeof message, "string");
  assert.equal(message, FALLBACK);
});

test("完全沒有 response 時退回 fallback", () => {
  assert.equal(getApiErrorMessage(new Error("Network Error")), FALLBACK);
  assert.equal(getApiErrorMessage(undefined), FALLBACK);
});

test("呼叫端可以指定自己的 fallback", () => {
  assert.equal(getApiErrorMessage(errorWith(undefined), "建立期別失敗"), "建立期別失敗");
});

test("回傳值永遠是字串——各頁會直接餵給 toast 與 setState", () => {
  for (const detail of [
    "字串", { message: "物件" }, [{ msg: "陣列" }], {}, [], null, undefined, 42,
  ]) {
    assert.equal(typeof getApiErrorMessage(errorWith(detail)), "string", JSON.stringify(detail));
  }
});

test("限流 429 給的是「太頻繁」而不是呼叫端的 fallback", () => {
  // slowapi 回 {"error": ...} 沒有 detail；登入頁的 fallback 是「請確認帳號與密碼」，
  // 對一個被限流的人來說那是錯的指示。
  const rateLimited = { response: { status: 429, data: { error: "Rate limit exceeded: 10 per 1 minute" } } };
  assert.equal(getApiErrorMessage(rateLimited, "登入失敗，請確認帳號與密碼"), "操作過於頻繁，請稍後再試");
});

test("429 若帶了可用的 detail，仍以 detail 為準", () => {
  const withDetail = { response: { status: 429, data: { detail: "這個班的匯出正在排隊" } } };
  assert.equal(getApiErrorMessage(withDetail), "這個班的匯出正在排隊");
});

test("模板 revision 衝突只認 409 加上該 code", () => {
  const conflict = { response: { status: 409, data: { detail: { code: "project_template_revision_changed" } } } };
  assert.equal(isProjectTemplateRevisionError(conflict), true);
  const otherStatus = { response: { status: 400, data: { detail: { code: "project_template_revision_changed" } } } };
  assert.equal(isProjectTemplateRevisionError(otherStatus), false);
  assert.equal(isProjectTemplateRevisionError(errorWith("字串")), false);
});
