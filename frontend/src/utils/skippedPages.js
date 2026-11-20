// 學期匯出的缺頁資料（entry.skipped_pages = [{ page, reason }]）格式化
// 與後端匯出說明.txt 的寫法一致：同一原因的頁碼併在一起

export function groupSkippedPagesByReason(skippedPages = []) {
  const pagesByReason = new Map();
  skippedPages.forEach(({ page, reason }) => {
    const label = reason || "未填原因";
    if (!pagesByReason.has(label)) pagesByReason.set(label, []);
    pagesByReason.get(label).push(page);
  });
  return [...pagesByReason.entries()].map(([reason, pages]) => ({ reason, pages }));
}

export function formatSkippedPages(skippedPages = []) {
  return groupSkippedPagesByReason(skippedPages)
    .map(({ reason, pages }) => `第 ${pages.join("、")} 頁（${reason}）`)
    .join("；");
}

// 攤平學期預覽的 classroom_groups，列出有缺頁的相本（依期別順序）
export function collectSkippedPageRows(classroomGroups, periods) {
  const periodNames = new Map(periods.map(period => [
    period.template_period_id ?? period.id,
    period.period_name ?? period.name ?? "未命名期別",
  ]));
  const periodOrder = new Map(periods.map((period, index) => [period.template_period_id ?? period.id, index]));
  const rows = [];
  classroomGroups.forEach(group => {
    (group.children ?? []).forEach(child => {
      [...(child.cells ?? [])]
        .sort((first, second) => (
          (periodOrder.get(first.template_period_id) ?? 0) - (periodOrder.get(second.template_period_id) ?? 0)
        ))
        .forEach(cell => {
          (cell.entries ?? []).forEach(entry => {
            if (!(entry.skipped_pages ?? []).length) return;
            rows.push({
              key: `${child.roster_child_id}:${entry.student_id}`,
              childName: child.name,
              periodName: periodNames.get(cell.template_period_id) ?? "未命名期別",
              entry,
            });
          });
        });
    });
  });
  return rows;
}
