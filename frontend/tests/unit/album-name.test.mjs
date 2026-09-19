import assert from "node:assert/strict";

import {
  ALBUM_NAME_MAX_LENGTH,
  buildDefaultCustomName,
  composeAlbumName,
  customNameMaxLength,
} from "../../src/utils/albumName.js";
import { test } from "./harness.mjs";


test("相本全名以模板名稱當前綴，中間一個空白", () => {
  assert.equal(
    composeAlbumName("2026-06 12階 感官世界", "東區校-十階A"),
    "2026-06 12階 感官世界 東區校-十階A",
  );
});

test("沒填自訂名稱時全名就是模板名稱", () => {
  assert.equal(composeAlbumName("2026-06 12階 感官世界", "   "), "2026-06 12階 感官世界");
});

test("還沒選模板時只剩自訂名稱，不會留下多餘空白", () => {
  assert.equal(composeAlbumName("", "東區校-十階A"), "東區校-十階A");
  assert.equal(composeAlbumName(undefined, " 東區校-十階A "), "東區校-十階A");
});

test("自訂名稱預設就是分校-班級", () => {
  assert.equal(buildDefaultCustomName("東區校", "十階A"), "東區校-十階A");
  assert.equal(buildDefaultCustomName(undefined, "十階A"), "十階A");
});

test("自訂名稱的可填長度扣掉前綴與分隔空白", () => {
  const templateName = "2026-06 12階 感官世界";
  assert.equal(
    customNameMaxLength(templateName),
    ALBUM_NAME_MAX_LENGTH - templateName.length - 1,
  );
  assert.equal(customNameMaxLength(""), ALBUM_NAME_MAX_LENGTH);
  // 前綴本身就吃掉上限時不能給出負數
  assert.equal(customNameMaxLength("模".repeat(ALBUM_NAME_MAX_LENGTH)), 0);
});

test("組出來的全名不會超過後端上限", () => {
  const templateName = "2026-06 12階 感官世界";
  const customName = "校".repeat(customNameMaxLength(templateName));
  assert.equal(composeAlbumName(templateName, customName).length, ALBUM_NAME_MAX_LENGTH);
});
