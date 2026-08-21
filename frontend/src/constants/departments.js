// 部門代碼與顯示名稱。
//
// 跨語言鏡像：正本是 backend/template_periods.py 的 `TEMPLATE_DEPARTMENTS`，
// 一致性由 tests/test_contract_pins.py 釘住。前端另有 `/api/templates/departments`
// 端點；會變動的清單（模板頁、相本工作頁）走那個端點，這裡的常數是它的 fallback，
// 以及那些不值得為兩個固定值發一次請求的地方。
//
// 這裡**只放代碼與名稱**。各頁需要的選單形狀（`{value,label}`、帶「全部部門」的
// 篩選列、「…主管」）在呼叫端由這份清單組出來——把每種形狀都搬進來只是把散落
// 換個地方繼續散落。

export const DEPARTMENTS = [
  { code: "infant", name: "嬰幼部" },
  { code: "academy", name: "學院部" },
];

export const DEPARTMENT_LABELS = Object.fromEntries(
  DEPARTMENTS.map(department => [department.code, department.name]),
);

/** 取部門顯示名稱；未知代碼原樣顯示，不要猜成另一個部門。 */
export function departmentLabel(code) {
  return DEPARTMENT_LABELS[code] ?? code;
}
