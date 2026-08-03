// 把「一次貼一整批孩子」的文字，解析成 members/batch 的請求內容。
//
// 為什麼要有學號：學號是名冊與行政系統之間唯一穩定的對應鍵。沒有它，手動編進來的
// 孩子在名冊同步裡永遠對不到上游，還會被誤判成「上游有、相本沒有」而重複建檔。
//
// 格式：一行一位，也可以用 、，, 在同一行分隔多位（沿用原本的貼法）；
// 每一位是「姓名」或「姓名<空白>學號」——從行政系統的表格複製過來會是 tab 分隔，
// 剛好落在這個規則裡。姓名本身不會有空白（後端的名冊身分姓名會去掉所有空白）。

const ENTRY_SEPARATORS = /[、，,]/;

/**
 * @param {string} text
 * @returns {{ members: {name: string, student_serial?: string}[], invalid: string[] }}
 */
export function parseRosterMemberInput(text) {
  const members = [];
  const invalid = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    for (const rawEntry of line.split(ENTRY_SEPARATORS)) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const tokens = entry.split(/\s+/);
      if (tokens.length === 1) {
        members.push({ name: tokens[0] });
      } else if (tokens.length === 2) {
        members.push({ name: tokens[0], student_serial: tokens[1] });
      } else {
        // 超過兩欄無法判斷哪個是姓名哪個是學號，寧可退回讓人看，不要猜
        invalid.push(entry);
      }
    }
  }
  return { members, invalid };
}

/** 把後端回報的學號衝突整理成一句可以直接顯示的話。 */
export function describeSerialConflicts(conflicts) {
  if (!conflicts?.length) return "";
  return conflicts
    .map(row => `${row.name}（${row.student_serial}）：${row.message}`)
    .join("；");
}
