// 班級總覽的兩類「完成」判斷式(唯一來源,避免散落各元件重寫)。
// 「內容填齊」= 照片/文字格都填滿,是製作進度;
// 「交件解鎖」= completed_at 標記完成,是流程狀態 — 兩者是不同概念,詞彙不得混用。

// 單一進度(照片或文字)是否填齊;沒有格子視為填齊
export function isProgressComplete(progress) {
  if (!progress) return true;
  return progress.total === 0 || progress.filled === progress.total;
}

// 學生內容是否填齊(照片與文字皆滿)
export function isStudentContentComplete(photoProgress, textProgress) {
  return isProgressComplete(photoProgress) && isProgressComplete(textProgress);
}

// 全班交件(PDF / 圖片 ZIP)解鎖:只看全班標記完成
// 鏡像後端 assert_class_downloadable 的 predicate
export function isProjectDeliverableUnlocked(project) {
  return Boolean(project?.completed_at);
}

// 單生交件解鎖:該生標記完成或全班標記完成任一成立
// 鏡像後端 student_effectively_completed 的 predicate
export function isStudentDeliverableUnlocked(project, student) {
  return Boolean(student?.completed_at) || isProjectDeliverableUnlocked(project);
}
