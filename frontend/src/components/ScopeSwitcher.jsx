// 相本編輯器的「編輯範圍」切換列
// 全班／個別 兩顆按鈕切換 scope；個別模式下才出現學生下拉與上一位/下一位

import { ChevronLeft, ChevronRight, User, Users } from "lucide-react";

import { AutoSaveStatus, Button, SegmentedControl, fieldControlClass } from "./ui";

export default function ScopeSwitcher({
  students,
  // null＝全班共用 scope；否則為目前學生 id
  currentStudentId,
  onSwitch,
  isBusy = false,
  saveStatus,
}) {
  const isClassScope = currentStudentId == null;
  const currentIndex = isClassScope
    ? -1
    : students.findIndex(student => String(student.id) === String(currentStudentId));
  const previousStudent = currentIndex > 0 ? students[currentIndex - 1] : null;
  const nextStudent = currentIndex >= 0 && currentIndex < students.length - 1
    ? students[currentIndex + 1]
    : null;

  return (
    // 兩個 scope 同款容器：目前範圍由 active pill 與右上計數表達，
    // 不再用底色標示（violet 的全站語意是「班級總覽」，不做一色兩義）
    <div
      data-guide="scope-switcher"
      className="mb-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span className="font-medium">編輯範圍</span>
        {saveStatus !== undefined && <AutoSaveStatus status={saveStatus} />}
        <span className="ml-auto">
          {isClassScope ? `共 ${students.length} 位學生` : `${currentIndex >= 0 ? currentIndex + 1 : "-"} / ${students.length}`}
        </span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* 全班／個別 切換：與全站相同的 SegmentedControl token */}
        <SegmentedControl
          value={isClassScope ? "class" : "student"}
          onChange={(nextScope) => {
            if (nextScope === "class" && !isClassScope) onSwitch(null);
            if (nextScope === "student" && isClassScope && students.length > 0) onSwitch(students[0].id);
          }}
          disabled={isBusy}
          className="flex-shrink-0 sm:w-64"
          options={[
            { value: "class", label: "全班", icon: Users, guideId: "scope-class-pill" },
            { value: "student", label: "個別", icon: User, guideId: "scope-student-pill" },
          ]}
        />
        {/* 學生切換：個別模式才出現 */}
        {!isClassScope && (
          <div className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <Button
              type="button"
              aria-label="上一位"
              onClick={() => { if (previousStudent) onSwitch(previousStudent.id); }}
              disabled={isBusy || !previousStudent}
              variant="neutral"
              size="touch"
              className="px-3"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">上一位</span>
            </Button>
            <select
              aria-label="切換學生"
              value={String(currentStudentId)}
              onChange={event => { if (String(event.target.value) !== String(currentStudentId)) onSwitch(event.target.value); }}
              disabled={isBusy}
              className={`${fieldControlClass} min-h-10 bg-white`}
            >
              {students.map((student, index) => (
                <option key={student.id} value={student.id}>
                  {index + 1}. {student.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              aria-label="下一位"
              onClick={() => { if (nextStudent) onSwitch(nextStudent.id); }}
              disabled={isBusy || !nextStudent}
              variant="neutral"
              size="touch"
              className="px-3"
            >
              <span className="hidden sm:inline">下一位</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
