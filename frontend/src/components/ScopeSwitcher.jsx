// 相本編輯器的「編輯範圍」切換列
// 全班／個別 兩顆按鈕切換 scope；個別模式下才出現學生下拉與上一位/下一位。
// 全班 scope 用紫色（review 色系）標示，防止「以為在改一個人、其實改到全班」的混淆

import { ChevronLeft, ChevronRight, User, Users } from "lucide-react";
import { Link } from "react-router-dom";

import { AutoSaveStatus, Button, fieldControlClass } from "./ui";

export default function ScopeSwitcher({
  students,
  // null＝全班共用 scope；否則為目前學生 id
  currentStudentId,
  onSwitch,
  isBusy = false,
  saveStatus,
  backTo,
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
    <div
      data-guide="scope-switcher"
      className={`mb-4 rounded-lg border p-3 shadow-sm ${
        isClassScope ? "border-violet-200 bg-violet-50/70" : "border-gray-200 bg-white"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span className="font-medium">編輯範圍</span>
        {saveStatus !== undefined && <AutoSaveStatus status={saveStatus} />}
        <span className="ml-auto">
          {isClassScope ? `共 ${students.length} 位學生` : `${currentIndex >= 0 ? currentIndex + 1 : "-"} / ${students.length}`}
        </span>
        {backTo && (
          <Button as={Link} to={backTo} variant="reviewSoft" size="xs" className="flex-shrink-0">
            完成，回班級總覽
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* 全班／個別 切換 */}
        <div className="grid flex-shrink-0 grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 sm:w-64">
          <button
            type="button"
            data-guide="scope-class-pill"
            onClick={() => { if (!isClassScope && !isBusy) onSwitch(null); }}
            disabled={isBusy}
            aria-pressed={isClassScope}
            className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
              isClassScope
                ? "bg-violet-600 text-white"
                : "text-gray-500 hover:text-violet-700"
            }`}
          >
            <Users className="h-4 w-4" />
            全班
          </button>
          <button
            type="button"
            data-guide="scope-student-pill"
            onClick={() => { if (isClassScope && !isBusy && students.length > 0) onSwitch(students[0].id); }}
            disabled={isBusy || (isClassScope && students.length === 0)}
            aria-pressed={!isClassScope}
            className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
              !isClassScope
                ? "bg-indigo-600 text-white"
                : "text-gray-500 hover:text-indigo-700"
            }`}
          >
            <User className="h-4 w-4" />
            個別
          </button>
        </div>
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
