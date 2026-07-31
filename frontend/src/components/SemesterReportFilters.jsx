// 正式學期報表共用篩選列：學期 → 部門 → 校別 → 班級。
// 校別與班級選項只使用後端已套用主管 scope 的報表資料。

import { FormField, SegmentedControl, Surface, fieldControlClass } from "./ui";

const DEPARTMENT_LABELS = {
  infant: "嬰幼部",
  academy: "學院部",
};

export default function SemesterReportFilters({
  terms,
  semesterId,
  onSemesterChange,
  departments,
  department,
  onDepartmentChange,
  classrooms,
  campusId,
  onCampusChange,
  classroomId,
  onClassroomChange,
  disabled = false,
  actions,
}) {
  const campusesById = new Map();
  for (const classroom of classrooms) {
    if (!classroom.campus_id || campusesById.has(classroom.campus_id)) continue;
    campusesById.set(classroom.campus_id, {
      id: classroom.campus_id,
      name: classroom.campus_name,
    });
  }
  const campuses = [...campusesById.values()].sort((firstCampus, secondCampus) => (
    firstCampus.name.localeCompare(secondCampus.name, "zh-TW")
  ));
  const campusClassrooms = classrooms
    .filter(classroom => !campusId || String(classroom.campus_id) === String(campusId))
    .sort((firstClassroom, secondClassroom) => (
      firstClassroom.campus_name.localeCompare(secondClassroom.campus_name, "zh-TW")
      || firstClassroom.classroom_name.localeCompare(secondClassroom.classroom_name, "zh-TW")
    ));

  return (
    <Surface padding="sm" className="mb-4 shrink-0">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(10rem,1.1fr)_minmax(12rem,1fr)_minmax(10rem,1fr)_minmax(10rem,1fr)_auto] xl:items-end">
        <FormField label="學期">
          <select
            aria-label="選擇學期"
            value={semesterId ?? ""}
            disabled={disabled || terms.length === 0}
            onChange={event => onSemesterChange(event.target.value)}
            className={fieldControlClass}
          >
            {terms.length === 0 && <option value="">尚無正式學期</option>}
            {terms.map(term => (
              <option key={term.id} value={term.id}>
                {term.label}{term.is_current || ["active", "imported"].includes(term.status) ? "（目前）" : ""}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="部門">
          <SegmentedControl
            value={department}
            onChange={onDepartmentChange}
            options={departments.map(departmentCode => ({
              value: departmentCode,
              label: DEPARTMENT_LABELS[departmentCode] ?? departmentCode,
            }))}
            size="sm"
            disabled={disabled || departments.length === 0}
            ariaLabel="選擇部門"
          />
        </FormField>

        <FormField label="校別">
          <select
            aria-label="篩選校別"
            value={campusId}
            disabled={disabled || campuses.length === 0}
            onChange={event => onCampusChange(event.target.value)}
            className={fieldControlClass}
          >
            <option value="">全部校別</option>
            {campuses.map(campus => (
              <option key={campus.id} value={campus.id}>{campus.name}</option>
            ))}
          </select>
        </FormField>

        <FormField label="班級">
          <select
            aria-label="篩選班級"
            value={classroomId}
            disabled={disabled || campusClassrooms.length === 0}
            onChange={event => onClassroomChange(event.target.value)}
            className={fieldControlClass}
          >
            <option value="">全部班級</option>
            {campusClassrooms.map(classroom => (
              <option key={classroom.classroom_id} value={classroom.classroom_id}>
                {!campusId ? `${classroom.campus_name}／` : ""}{classroom.classroom_name}
              </option>
            ))}
          </select>
        </FormField>

        {actions && <div className="sm:col-span-2 xl:col-span-1">{actions}</div>}
      </div>
    </Surface>
  );
}

export { DEPARTMENT_LABELS };
