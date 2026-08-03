import assert from "node:assert/strict";

import {
  describeSerialConflicts,
  parseRosterMemberInput,
} from "../../src/utils/rosterMemberInput.js";
import { test } from "./harness.mjs";


test("一行一位，只有姓名時不帶學號", () => {
  const { members, invalid } = parseRosterMemberInput("王小明\n李小華\n");
  assert.deepEqual(members, [{ name: "王小明" }, { name: "李小華" }]);
  assert.deepEqual(invalid, []);
});

test("姓名後面接學號（空白或 tab 分隔）", () => {
  // 從行政系統的表格複製過來就是 tab 分隔
  const { members } = parseRosterMemberInput("王小明\tDN0037024\n李小華 DN0037025");
  assert.deepEqual(members, [
    { name: "王小明", student_serial: "DN0037024" },
    { name: "李小華", student_serial: "DN0037025" },
  ]);
});

test("同一行用頓號逗號分隔多位仍然可用（原本的貼法不能壞）", () => {
  const { members } = parseRosterMemberInput("王小明、李小華，陳小美,林小安");
  assert.deepEqual(members.map(row => row.name), ["王小明", "李小華", "陳小美", "林小安"]);
  assert.ok(members.every(row => row.student_serial === undefined));
});

test("有學號與沒學號可以混在一起", () => {
  const { members } = parseRosterMemberInput("王小明 DN0001\n李小華");
  assert.deepEqual(members, [
    { name: "王小明", student_serial: "DN0001" },
    { name: "李小華" },
  ]);
});

test("超過兩欄不猜，退回讓人看", () => {
  const { members, invalid } = parseRosterMemberInput("王小明 DN0001 多打的\n李小華");
  assert.deepEqual(members, [{ name: "李小華" }]);
  assert.deepEqual(invalid, ["王小明 DN0001 多打的"]);
});

test("空行與多餘空白不會產生空的孩子", () => {
  const { members } = parseRosterMemberInput("\n  \n王小明  \n、\n");
  assert.deepEqual(members, [{ name: "王小明" }]);
});

test("學號衝突整理成看得懂的一句話", () => {
  assert.equal(describeSerialConflicts([]), "");
  assert.equal(
    describeSerialConflicts([
      { name: "陳小美", student_serial: "DN0001", message: "學號已屬於名冊中的「王小明」" },
    ]),
    "陳小美（DN0001）：學號已屬於名冊中的「王小明」",
  );
});
