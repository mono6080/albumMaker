// 學生照片填滿進度（前端版）
// 與後端 roster_service._summarize_student_progress 同一規則：
// 略過 skip 頁；一格有照片紀錄即算已填

/**
 * @param {Array}  pagesData     學生 pages_data（每項含 page_index / photos / skip）
 * @param {Array}  templatePages 模板頁陣列（每頁含 layout.photo_slots）
 * @returns {{ filled: number, total: number }}
 */
export function computeStudentPhotoProgress(pagesData, templatePages) {
  const pageDataByIndex = new Map(
    (pagesData || []).map(pageData => [pageData.page_index, pageData])
  );
  let filled = 0;
  let total = 0;
  (templatePages || []).forEach((templatePage, pageIndex) => {
    const pageData = pageDataByIndex.get(pageIndex);
    if (pageData?.skip) return;
    const photoSlots = templatePage.layout?.photo_slots || [];
    total += photoSlots.length;
    const photos = pageData?.photos || {};
    photoSlots.forEach(photoSlot => {
      if (photos[String(photoSlot.id)]) filled += 1;
    });
  });
  return { filled, total };
}
