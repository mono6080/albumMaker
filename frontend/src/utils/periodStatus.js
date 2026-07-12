// 期別狀態對應的 Badge 色調（TemplateList 期別按鈕與 TemplateCard 共用）
export function statusTone(status) {
  if (status === "active") return "success";
  if (status === "archived") return "archive";
  return "warning";
}
