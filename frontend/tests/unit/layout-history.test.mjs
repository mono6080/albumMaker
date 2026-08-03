import assert from "node:assert/strict";

import { createLayoutHistoryStore } from "../../src/utils/layoutHistoryModel.js";
import { test } from "./harness.mjs";


const page = (id, text) => ({ id, page_number: id - 1, layout: { texts: [text] } });
const withText = text => layout => ({ ...layout, texts: [...layout.texts, text] });
const keyOf = id => `page:${id}`;


test("上傳結果寫回發起的那一頁，不是使用者切過去的那一頁", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "第一頁");
  const second = page(2, "第二頁");
  store.beginPageSession(first);
  store.beginPageSession(second);

  // 上傳從第 1 頁發起，回來時使用者已經在第 2 頁
  const result = store.commitForPage(first, withText("貼圖"), { activePageKey: keyOf(2) });

  assert.equal(result.committed, true);
  assert.equal(result.isActive, false, "不是目前頁，畫布不該換掉");
  assert.deepEqual(store.drafts[keyOf(1)].texts, ["第一頁", "貼圖"]);
  assert.equal(store.drafts[keyOf(2)], undefined, "第 2 頁不該被碰到");
});


test("上傳期間在原頁存過的文字不會被上傳結果蓋掉", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "第一頁");
  store.beginPageSession(first);
  // 上傳還在飛的時候，使用者又在同一頁加了文字
  store.commit(keyOf(1), first.layout, withText("上傳期間打的字"));
  // 上傳才回來
  store.commitForPage(first, withText("貼圖"), { activePageKey: keyOf(1) });

  assert.deepEqual(
    store.drafts[keyOf(1)].texts,
    ["第一頁", "上傳期間打的字", "貼圖"],
    "上傳結果要疊在最新草稿上，不是覆蓋回舊的基準版本",
  );
});


test("同一個 historyGroup 的連續編輯只留一次 undo", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "起點");
  store.beginPageSession(first);

  let layout = first.layout;
  for (const chunk of ["一", "二", "三"]) {
    layout = store.commit(keyOf(1), layout, withText(chunk), { historyGroup: "typing" }).layout;
  }
  assert.equal(store.availability(keyOf(1)).canUndo, true);

  const undone = store.undo(keyOf(1), layout);
  assert.deepEqual(undone.layout.texts, ["起點"], "連續打字要一次復原到起點");
  assert.equal(store.availability(keyOf(1)).canUndo, false);
});


test("結束群組之後的編輯是新的一次 undo", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "起點");
  store.beginPageSession(first);
  let layout = store.commit(keyOf(1), first.layout, withText("一"), { historyGroup: "typing" }).layout;
  store.endGroup("typing");
  layout = store.commit(keyOf(1), layout, withText("二"), { historyGroup: "typing" }).layout;

  const undone = store.undo(keyOf(1), layout);
  assert.deepEqual(undone.layout.texts, ["起點", "一"], "只該退回上一段");
});


test("非目前頁的上傳結果不會併進目前頁的打字群組", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "第一頁");
  const second = page(2, "第二頁");
  store.beginPageSession(first);
  const secondLayout = store.beginPageSession(second).layout;
  store.commit(keyOf(2), secondLayout, withText("正在打字"), { historyGroup: "typing" });

  store.commitForPage(first, withText("貼圖"), { activePageKey: keyOf(2) });

  // 第 1 頁的那一筆自己是一次完整的 undo，且不影響第 2 頁的群組
  const undoneFirst = store.undo(keyOf(1), store.drafts[keyOf(1)]);
  assert.deepEqual(undoneFirst.layout.texts, ["第一頁"]);
});


test("儲存期間又編輯過的草稿要保留並搬到正式 page id", () => {
  const store = createLayoutHistoryStore();
  const temp = { id: null, editorKey: "draft-1", layout: { texts: ["新頁"] } };
  store.beginPageSession(temp);
  const sent = store.commit("draft-1", temp.layout, withText("送出前")).layout;
  // 請求還在飛的時候又打了字：草稿換成另一個物件
  const afterSend = store.commit("draft-1", sent, withText("送出後又打的")).layout;

  store.reconcileSavedPages([{
    sourcePageId: "draft-1",
    savedPageId: "page:77",
    savedDraftReference: sent,
    savedLayout: sent,
  }]);

  assert.equal(store.drafts["draft-1"], undefined, "臨時 id 底下不該再有草稿");
  assert.deepEqual(
    store.drafts["page:77"].texts,
    afterSend.texts,
    "儲存期間打的字必須保留，而且要跟到正式 id",
  );
});


test("送出去的那一版存完就清掉，不會留下假的未儲存狀態", () => {
  const store = createLayoutHistoryStore();
  const existing = page(5, "既有頁");
  store.beginPageSession(existing);
  const sent = store.commit(keyOf(5), existing.layout, withText("改一筆")).layout;

  store.reconcileSavedPages([{
    sourcePageId: keyOf(5),
    savedPageId: keyOf(5),
    savedDraftReference: sent,
    savedLayout: sent,
  }]);

  assert.equal(store.drafts[keyOf(5)], undefined, "存的就是這一版，草稿要清掉");
  assert.deepEqual(store.baselines[keyOf(5)].texts, ["既有頁", "改一筆"]);
});


test("刪頁會一併丟掉該頁的草稿與歷史", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "要被刪的頁");
  store.beginPageSession(first);
  store.commit(keyOf(1), first.layout, withText("改過"));
  assert.equal(store.availability(keyOf(1)).canUndo, true);

  store.dropPage(keyOf(1));
  assert.equal(store.drafts[keyOf(1)], undefined);
  assert.equal(store.availability(keyOf(1)).canUndo, false);
});


test("沒有實際變化的 commit 不會污染 undo 歷史", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "原樣");
  store.beginPageSession(first);
  const result = store.commit(keyOf(1), first.layout, layout => ({ ...layout }));

  assert.equal(result.committed, false);
  assert.equal(store.availability(keyOf(1)).canUndo, false, "沒改就不該產生一步 undo");
});


test("切回有草稿的頁面時看到的是草稿，不是伺服器版本", () => {
  const store = createLayoutHistoryStore();
  const first = page(1, "伺服器版本");
  store.beginPageSession(first);
  store.commit(keyOf(1), first.layout, withText("本地改的"));

  const reopened = store.beginPageSession(first);
  assert.deepEqual(reopened.layout.texts, ["伺服器版本", "本地改的"]);
  assert.deepEqual(store.baselines[keyOf(1)].texts, ["伺服器版本"], "基準版本仍是伺服器那份");
});
