// 新學期編班看板：一欄一個班級，班級的所有操作都在這裡完成。
//   學生卡片拖曳改班、× 標記離園；老師標籤拖曳換班；欄位標題可改名、移除、拖曳調順序。
//   觸控與鍵盤走「先點起、再點目標」的同一套流程，不依賴拖曳。
//   對外只透過 props 溝通，不自己打 API。

import { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, pointerWithin, useDraggable, useDroppable } from "@dnd-kit/core";
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Pencil,
  Plus,
  UserRound,
  X,
} from "lucide-react";

import { useDndPhotoSensors } from "../hooks/useDndPhotoSensors";

export const DEPARTED_COLUMN_ID = "departed";

// 拖曳放開後緊接著送出的那個 click 要忽略掉的時間窗
const CLICK_AFTER_DRAG_MS = 250;

const DEPARTED_COLUMN = {
  id: DEPARTED_COLUMN_ID,
  name: "離園",
  campusName: "",
  label: "離園",
  canRemove: false,
};

const isPlacementChanged = placement => (
  placement.outcome === "departed"
  || placement.target_classroom_id !== placement.stay_classroom_id
);

const columnIdOf = placement => (
  placement.outcome === "departed" ? DEPARTED_COLUMN_ID : placement.target_classroom_id
);

function StudentCard({ placement, isPicked, onPick, onDepart }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `student-${placement.source_member_id}`,
    data: { type: "student", sourceMemberId: placement.source_member_id },
  });
  const changed = isPlacementChanged(placement);
  const departed = placement.outcome === "departed";
  return (
    <div
      ref={setNodeRef}
      id={`term-student-${placement.source_member_id}`}
      className={[
        "flex items-center gap-1 rounded border pl-2 pr-1 transition",
        isDragging ? "opacity-30" : "",
        isPicked ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-300" : "",
        !isPicked && changed ? "border-amber-300 bg-amber-50" : "",
        !isPicked && !changed ? "border-gray-200 bg-white" : "",
      ].join(" ")}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        onClick={() => onPick(placement.source_member_id)}
        aria-pressed={isPicked}
        title={`原班：${placement.source_campus_name}／${placement.source_classroom_name}`}
        className="min-w-0 flex-1 truncate py-1 text-left text-sm text-gray-700"
      >
        {placement.student_name}
      </button>
      {!departed && (
        <button
          type="button"
          aria-label={`把 ${placement.student_name} 標記為離園`}
          title="標記離園"
          onClick={() => onDepart(placement.source_member_id)}
          className="shrink-0 rounded p-0.5 text-gray-300 hover:bg-rose-50 hover:text-rose-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function TeacherChip({ teacher, classroomId, label, isPicked, onPick, onPromote }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `teacher-${classroomId}-${teacher.teacher_id}`,
    data: { type: "teacher", teacherId: teacher.teacher_id, fromClassroomId: classroomId },
  });
  const isLead = teacher.duty === "lead";
  return (
    <div
      ref={setNodeRef}
      className={[
        "flex w-full items-center gap-1 rounded pl-1.5 pr-0.5 transition",
        isDragging ? "opacity-30" : "",
        isPicked ? "bg-indigo-100 ring-2 ring-indigo-300" : "",
        !isPicked && isLead ? "bg-emerald-50" : "",
        !isPicked && !isLead ? "bg-gray-100" : "",
      ].join(" ")}
    >
      <button
        type="button"
        {...listeners}
        {...attributes}
        onClick={() => onPick(teacher.teacher_id, classroomId)}
        aria-pressed={isPicked}
        title={`${label}（${isLead ? "主教" : "協同"}）`}
        className={[
          "flex min-w-0 flex-1 items-center gap-1 truncate py-0.5 text-left text-xs",
          isLead ? "text-emerald-800" : "text-gray-600",
        ].join(" ")}
      >
        <UserRound className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {/* 一個班只能有一位主教（DB 唯一鍵擋著），所以切換是「換人當」而不是各自開關：
          點協同者的「協」把他升為主教，原本的主教同時降為協同。 */}
      <button
        type="button"
        disabled={isLead}
        onClick={() => onPromote(teacher.teacher_id, classroomId)}
        aria-label={isLead ? `${label} 目前是主教` : `把 ${label} 設為主教`}
        title={isLead ? "主教" : "點一下設為主教（原主教改為協同）"}
        className={[
          "shrink-0 rounded px-1 py-0.5 text-xs font-medium",
          isLead
            ? "bg-emerald-200 text-emerald-900"
            : "text-gray-400 hover:bg-emerald-100 hover:text-emerald-700",
        ].join(" ")}
      >
        {isLead ? "主" : "協"}
      </button>
    </div>
  );
}

function BoardColumn({
  column,
  placements,
  newStudents,
  teachers,
  teacherLabelOf,
  hasSelection,
  isStudentSelected,
  isTeacherSelected,
  onPickStudent,
  onPickTeacher,
  onPromoteTeacher,
  onDropInto,
  onDepart,
  onRename,
  onRemove,
  onMoveColumn,
  onEditTeachers,
  onAddNewStudents,
  onRemoveNewStudent,
  draggingType,
  isFirst,
  isLast,
  isSubmitting,
}) {
  const [renameDraft, setRenameDraft] = useState(null);
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${column.id}`,
    data: { type: "column", columnId: column.id },
  });
  // 老師與學生分開放置：拖老師時該亮的是老師區，不是別班的學生欄
  const {
    setNodeRef: setTeacherZoneRef,
    isOver: isTeacherZoneOver,
  } = useDroppable({
    id: `teacherzone-${column.id}`,
    data: { type: "column", columnId: column.id },
  });
  const {
    attributes: handleAttributes,
    listeners: handleListeners,
    setNodeRef: setHandleRef,
    isDragging: isColumnDragging,
  } = useDraggable({
    id: `columnhandle-${column.id}`,
    data: { type: "column-handle", columnId: column.id },
    disabled: column.id === DEPARTED_COLUMN_ID,
  });
  // 拖整欄時的落點：亮在標題上，不是別班的學生欄
  const {
    setNodeRef: setHeaderDropRef,
    isOver: isHeaderOver,
  } = useDroppable({
    id: `columnheader-${column.id}`,
    data: { type: "column", columnId: column.id },
  });
  const isColumnDrag = draggingType === "column-handle";
  const isDeparted = column.id === DEPARTED_COLUMN_ID;
  const changedCount = placements.filter(isPlacementChanged).length;

  return (
    <div
      // 驗證錯誤的「前往修正」用這個 id 捲到出問題的班
      id={column.id === DEPARTED_COLUMN_ID ? undefined : `term-classroom-${column.id}`}
      tabIndex={-1}
      className={[
      "flex w-44 shrink-0 flex-col outline-none focus:ring-2 focus:ring-amber-300",
      isColumnDragging ? "opacity-40" : "",
      // 拖整欄時，被指到的那一欄左緣長出插入線
      isColumnDrag && isHeaderOver && !isDeparted
        ? "rounded border-l-4 border-l-indigo-500"
        : "",
    ].join(" ")}
    >
      <div
        ref={setHeaderDropRef}
        className={[
          "rounded-t border-x border-t px-1.5 py-1",
          isDeparted
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : "border-indigo-200 bg-indigo-50 text-indigo-800",
        ].join(" ")}
      >
        {/* 班名獨佔一行：38 欄都叫「安平校／…」的話等於沒有標題 */}
        <div className="flex items-center gap-0.5">
          {!isDeparted && (
            <span
              ref={setHandleRef}
              {...handleListeners}
              {...handleAttributes}
              title="拖曳整個班級調整順序"
              className="shrink-0 cursor-grab text-indigo-400 hover:text-indigo-600"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
          )}
          {renameDraft === null ? (
            <button
              type="button"
              // 有東西被拿起時，整個標題就是「放到這裡」的入口
              onClick={() => (hasSelection ? onDropInto(column.id) : (!isDeparted && setRenameDraft(column.name)))}
              aria-label={hasSelection ? `放進 ${column.label}` : `重新命名 ${column.label}`}
              title={hasSelection ? `放進 ${column.label}` : `${column.label}（點一下改名）`}
              className="min-w-0 flex-1 truncate text-center text-sm font-semibold"
            >
              {column.name}
            </button>
          ) : (
            <input
              // 掛載當下就對焦並全選：改名幾乎都是整個換掉，不選起來會變成接在原名後面。
              // 用 ref 而不是 autoFocus + onFocus——後者的 focus 發生在 React 綁上
              // 事件之前，選取範圍不會生效。
              ref={(node) => { if (node && document.activeElement !== node) { node.focus(); node.select(); } }}
              value={renameDraft}
              disabled={isSubmitting}
              onChange={event => setRenameDraft(event.target.value)}
              onBlur={() => setRenameDraft(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setRenameDraft(null);
                if (event.key !== "Enter") return;
                const next = renameDraft.trim();
                setRenameDraft(null);
                if (next && next !== column.name) onRename(column.id, next);
              }}
              aria-label={`班級名稱 ${column.name}`}
              className="min-w-0 flex-1 rounded border border-indigo-300 px-1 py-0.5 text-center text-sm"
            />
          )}
          {!isDeparted && (
            <button
              type="button"
              aria-label={`移除班級 ${column.label}`}
              title={column.canRemove ? "移除這個班" : "還有學生或老師在這個班，先把他們移走"}
              disabled={!column.canRemove || isSubmitting}
              onClick={() => onRemove(column.id)}
              className="shrink-0 rounded p-0.5 text-indigo-300 enabled:hover:bg-rose-100 enabled:hover:text-rose-600 disabled:opacity-30"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-0.5 text-xs font-normal opacity-80">
          {!isDeparted ? (
            // 隔壁的班用拖的，遠一點的用左右鍵一格一格移比較好對
            <button
              type="button"
              aria-label={`把 ${column.label} 往前移一格`}
              title="往前移一格"
              disabled={isSubmitting || isFirst}
              onClick={() => onMoveColumn(column.id, -1)}
              className="shrink-0 rounded enabled:hover:bg-indigo-100 disabled:opacity-25"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          ) : <span className="w-3.5" />}
          <span className="min-w-0 truncate">
            {isDeparted ? "" : `${column.campusName}・`}
            {placements.length} 位{changedCount > 0 ? `・異動 ${changedCount}` : ""}
          </span>
          {!isDeparted ? (
            <button
              type="button"
              aria-label={`把 ${column.label} 往後移一格`}
              title="往後移一格"
              disabled={isSubmitting || isLast}
              onClick={() => onMoveColumn(column.id, 1)}
              className="shrink-0 rounded enabled:hover:bg-indigo-100 disabled:opacity-25"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          ) : <span className="w-3.5" />}
        </div>
        {!isDeparted && (
          <div
            ref={setTeacherZoneRef}
            className={[
              "mt-1 space-y-0.5 rounded border border-dashed p-0.5 transition",
              draggingType === "teacher" && isTeacherZoneOver
                ? "border-indigo-400 bg-indigo-100/70"
                : "",
              draggingType === "teacher" && !isTeacherZoneOver ? "border-indigo-300" : "",
              draggingType !== "teacher" ? "border-transparent" : "",
            ].join(" ")}
          >
            {teachers.map(teacher => (
              <TeacherChip
                key={`${column.id}-${teacher.teacher_id}`}
                teacher={teacher}
                classroomId={column.id}
                label={teacherLabelOf(teacher)}
                isPicked={isTeacherSelected(teacher.teacher_id, column.id)}
                onPick={onPickTeacher}
                onPromote={onPromoteTeacher}
              />
            ))}
            {teachers.length === 0 && (
              <p className="px-1 text-xs text-amber-600">尚無老師</p>
            )}
            <button
              type="button"
              onClick={() => onEditTeachers(column.id)}
              aria-label={`調整 ${column.label} 的老師`}
              className="flex w-full items-center justify-center gap-1 rounded py-0.5 text-xs text-indigo-500 hover:bg-indigo-100"
            >
              <Pencil className="h-3 w-3" />
              調整老師
            </button>
          </div>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={[
          "min-h-24 flex-1 space-y-1 rounded-b border p-1",
          isOver && draggingType === "student"
            ? "border-indigo-400 bg-indigo-50/70"
            : "border-gray-200 bg-gray-50",
        ].join(" ")}
      >
        {placements.map(placement => (
          <StudentCard
            key={placement.source_member_id}
            placement={placement}
            isPicked={isStudentSelected(placement.source_member_id)}
            onPick={onPickStudent}
            onDepart={onDepart}
          />
        ))}
        {/* 草稿期間編入的新生沒有來源名單列，不是 placement，所以不能拖也不能標離園；
            他們已經是這個班的成員，套用時原封不動留下。 */}
        {newStudents.map(student => (
          <div
            key={`new-${student.member_id}`}
            className="flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-1.5 py-1 text-xs text-emerald-900"
          >
            <span
              className="min-w-0 flex-1 truncate"
              title={
                student.student_serial
                  ? `${student.name}（新生，學號 ${student.student_serial}）`
                  : `${student.name}（新生，沒有學號）`
              }
            >
              {student.name}
            </span>
            {/* 沒有學號的孩子在名冊同步裡對不到行政系統——標出來，不然沒有人會發現 */}
            {student.student_serial ? (
              <span className="shrink-0 text-[10px] text-emerald-600">新</span>
            ) : (
              <span
                aria-label={`${student.name} 沒有學號`}
                title="沒有學號，之後名冊同步對不到行政系統"
                className="shrink-0 text-[10px] font-semibold text-amber-600"
              >
                新·無學號
              </span>
            )}
            <button
              type="button"
              aria-label={`移除新生 ${student.name}`}
              title="移除這位新生"
              disabled={isSubmitting}
              onClick={() => onRemoveNewStudent(column.id, student)}
              className="shrink-0 rounded text-emerald-500 enabled:hover:bg-emerald-100 disabled:opacity-40"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!isDeparted && (
          <button
            type="button"
            aria-label={`在 ${column.label} 新增新生`}
            disabled={isSubmitting}
            onClick={() => onAddNewStudents(column.id)}
            className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-emerald-300 py-1 text-xs text-emerald-600 enabled:hover:bg-emerald-50 disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            新生
          </button>
        )}
      </div>
    </div>
  );
}

export default function TermPlacementBoard({
  placements,
  classrooms,
  campuses,
  activeTab,
  onActiveTabChange: setActiveTab,
  focusClassroomId,
  teacherTargets,
  teacherLabelOf,
  onMovePlacements,
  onMoveTeachers,
  onPromoteTeacher,
  onRenameClassroom,
  onRemoveClassroom,
  onAddClassroom,
  onReorderClassrooms,
  onEditTeachers,
  newStudents = [],
  onAddNewStudents,
  onRemoveNewStudent,
  isSubmitting,
}) {
  // 多選一次只允許同一類：學生跟老師搬去的地方意義不同，混在一起沒有正確解
  const [selection, setSelection] = useState(null); // { type, items: [] }
  const [dragging, setDragging] = useState(null);
  // 分頁狀態由頁面持有：載入草稿時看板會被卸載（頁面切到 loading），
  // 內部 state 會被重置——新增班級之後就會彈回第一個分校，看不到剛建的班。
  const [marquee, setMarquee] = useState(null); // 框選中的矩形（viewport 座標）
  const marqueeRef = useRef(null);
  // 拖曳放開後瀏覽器還是會對按下去的那個元素補一個 click。不擋的話，
  // 那一張卡片會在搬完之後又被 toggle 一次——看起來就是「被拖的那位沒跟著搬」。
  // 記「拖曳結束的時間」而不是開關旗標：旗標一旦沒被關掉（拖曳沒正常結束），
  // 之後所有點選都會失效；時間戳最多只擋掉緊接著的那一下。
  const dragEndedAtRef = useRef(0);
  const sensors = useDndPhotoSensors();

  const classroomColumns = useMemo(
    () => classrooms.map(classroom => ({
      id: classroom.id,
      name: classroom.name,
      campusId: classroom.campusId,
      campusName: classroom.campusName,
      label: `${classroom.campusName}／${classroom.name}`,
      canRemove: classroom.canRemove,
    })),
    [classrooms],
  );
  const columns = useMemo(
    () => [...classroomColumns, DEPARTED_COLUMN],
    [classroomColumns],
  );

  // 班級的分校不可變更，分校就是天然的分段；同校的班排在一起才看得懂
  const campusGroups = useMemo(() => {
    const grouped = new Map();
    for (const column of classroomColumns) {
      grouped.set(column.campusName, [...(grouped.get(column.campusName) ?? []), column]);
    }
    return [...grouped.entries()].map(([campusName, items]) => ({ campusName, items }));
  }, [classroomColumns]);

  // 送出的是整個學期的完整順序，但只有指定那一校的內部次序被改寫
  const flattenOrder = (campusName, ids) => campusGroups.flatMap(group => (
    group.campusName === campusName ? ids : group.items.map(item => item.id)
  ));


  const placementsByColumn = useMemo(() => {
    const grouped = new Map(columns.map(column => [column.id, []]));
    for (const placement of placements) {
      // 目標班被移除時 placement 會暫時指向不存在的欄位，交給驗證報錯
      grouped.get(columnIdOf(placement))?.push(placement);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((first, second) => (
        first.student_name.localeCompare(second.student_name, "zh-TW")
      ));
    }
    return grouped;
  }, [columns, placements]);

  const newStudentsByColumn = useMemo(() => {
    const grouped = new Map();
    for (const student of newStudents) {
      grouped.set(student.classroom_id, [
        ...(grouped.get(student.classroom_id) ?? []),
        student,
      ]);
    }
    return grouped;
  }, [newStudents]);

  // 離園的學生沒有目標班級，只能用來源分校歸屬；每一頁只列自己校的，
  // 否則在安平校那一頁會看到湖美校的孩子。
  const departedByCampus = useMemo(() => {
    const grouped = new Map();
    for (const placement of placementsByColumn.get(DEPARTED_COLUMN_ID) ?? []) {
      const campusName = placement.source_campus_name;
      grouped.set(campusName, [...(grouped.get(campusName) ?? []), placement]);
    }
    return grouped;
  }, [placementsByColumn]);

  // 分頁以「園所的分校」為準，不是「有班級的分校」：某一校的班被全部移除時
  // 那一頁仍要在，否則連「新增班級」的入口都消失，回不去了。
  const tabs = useMemo(() => {
    const byCampus = new Map(campusGroups.map(group => [group.campusName, group.items]));
    const campusList = campuses?.length
      ? campuses.map(campus => ({ id: campus.id, name: campus.name }))
      : campusGroups.map(group => ({ id: group.items[0]?.campusId, name: group.campusName }));
    return campusList.map(campus => {
      const items = byCampus.get(campus.name) ?? [];
      return {
        key: campus.name,
        label: campus.name,
        classroomCount: items.length,
        // 新生也要算進去，否則分頁上的人數跟欄位裡看到的卡片對不起來
        studentCount: items.reduce(
          (total, item) => total
            + (placementsByColumn.get(item.id)?.length ?? 0)
            + (newStudentsByColumn.get(item.id)?.length ?? 0),
          0,
        ),
        departedCount: (departedByCampus.get(campus.name) ?? []).length,
        campusId: campus.id,
        columns: items,
      };
    });
  }, [campuses, campusGroups, placementsByColumn, newStudentsByColumn, departedByCampus]);
  const currentTab = tabs.find(tab => tab.key === activeTab) ?? tabs[0] ?? null;

  // 驗證錯誤指到別校的班時，自動切到那一頁，「前往修正」才定位得到
  useEffect(() => {
    if (focusClassroomId == null) return;
    const owner = tabs.find(tab => tab.columns.some(column => column.id === focusClassroomId));
    if (owner && owner.key !== currentTab?.key) setActiveTab(owner.key);
  }, [focusClassroomId, tabs, currentTab?.key, setActiveTab]);

  const teachersByColumn = useMemo(
    () => new Map((teacherTargets ?? []).map(target => [target.classroom_id, target.teachers])),
    [teacherTargets],
  );

  const teacherKey = item => `${item.fromClassroomId}-${item.teacherId}`;

  const applyTo = (columnId, batch) => {
    if (!batch) return;
    if (batch.type === "student") {
      onMovePlacements(
        batch.items,
        columnId === DEPARTED_COLUMN_ID ? "departed" : String(columnId),
      );
    } else if (batch.type === "teacher" && columnId !== DEPARTED_COLUMN_ID) {
      onMoveTeachers(batch.items, columnId);
    }
    setSelection(null);
  };

  // 多選一次只能同一類：換類別就重新開始選，不去合併兩種語意不同的搬動
  const toggleSelection = (type, item, keyOf) => setSelection((current) => {
    const base = current?.type === type ? current.items : [];
    const key = keyOf(item);
    const next = base.some(existing => keyOf(existing) === key)
      ? base.filter(existing => keyOf(existing) !== key)
      : [...base, item];
    return next.length ? { type, items: next } : null;
  });

  // 拖曳中的那張卡片若在選取集合裡，就整批一起搬；不在的話只搬它自己
  const batchFor = (source) => {
    if (source.type === "student") {
      const inSelection = selection?.type === "student"
        && selection.items.includes(source.sourceMemberId);
      return {
        type: "student",
        items: inSelection ? selection.items : [source.sourceMemberId],
      };
    }
    if (source.type === "teacher") {
      const item = { teacherId: source.teacherId, fromClassroomId: source.fromClassroomId };
      const inSelection = selection?.type === "teacher"
        && selection.items.some(existing => teacherKey(existing) === teacherKey(item));
      return { type: "teacher", items: inSelection ? selection.items : [item] };
    }
    return null;
  };

  const handleDragEnd = (event) => {
    setDragging(null);
    dragEndedAtRef.current = performance.now();
    const source = event.active.data.current;
    const target = event.over?.data.current;
    if (!source || !target) return;
    if (source.type === "column-handle") {
      if (target.columnId === DEPARTED_COLUMN_ID || target.columnId === source.columnId) return;
      const group = campusGroups.find(g => g.items.some(item => item.id === source.columnId));
      const ids = group?.items.map(item => item.id) ?? [];
      const from = ids.indexOf(source.columnId);
      const to = ids.indexOf(target.columnId);
      // 跨校拖曳不處理：班級的分校不可變更，挪過去只會讓順序失去意義
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      onReorderClassrooms(flattenOrder(group.campusName, ids));
      return;
    }
    applyTo(target.columnId, batchFor(source));
  };

  // 只在同一個分校內移動：跨校排序沒有意義
  const moveColumn = (columnId, offset) => {
    const group = campusGroups.find(g => g.items.some(item => item.id === columnId));
    if (!group) return;
    const ids = group.items.map(item => item.id);
    const from = ids.indexOf(columnId);
    const to = from + offset;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    onReorderClassrooms(flattenOrder(group.campusName, ids));
  };

  const draggingLabel = (() => {
    if (dragging?.type === "student") {
      const name = placements.find(
        item => item.source_member_id === dragging.sourceMemberId,
      )?.student_name;
      const size = batchFor(dragging).items.length;
      return size > 1 ? `${name} 等 ${size} 位` : name;
    }
    if (dragging?.type === "column-handle") {
      return columns.find(column => column.id === dragging.columnId)?.label;
    }
    if (dragging?.type === "teacher") {
      const teachers = teachersByColumn.get(dragging.fromClassroomId) ?? [];
      const teacher = teachers.find(item => item.teacher_id === dragging.teacherId);
      if (!teacher) return null;
      const size = batchFor(dragging).items.length;
      const label = teacherLabelOf(teacher);
      return size > 1 ? `${label} 等 ${size} 位` : label;
    }
    return null;
  })();

  // 框選：只在「不是卡片」的空白處按下才啟動，才不會跟卡片的拖曳搬動打架。
  // 矩形同時存在 ref 與 state：state 用來畫，ref 用來在 pointerup 當下讀取——
  // 只靠 state 的話，放開時讀到的是上一次 render 的值。
  const handleMarqueeDown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('[id^="term-student-"]')) return;
    if (event.target.closest("button, input")) return;
    const box = { x: event.clientX, y: event.clientY, x2: event.clientX, y2: event.clientY };
    marqueeRef.current = { box, additive: event.shiftKey, moved: false };
    setMarquee(box);
  };

  const handleMarqueeMove = (event) => {
    const state = marqueeRef.current;
    if (!state) return;
    const box = { ...state.box, x2: event.clientX, y2: event.clientY };
    if (Math.abs(box.x2 - box.x) + Math.abs(box.y2 - box.y) > 4) state.moved = true;
    state.box = box;
    setMarquee(box);
  };

  const handleMarqueeUp = () => {
    const state = marqueeRef.current;
    marqueeRef.current = null;
    setMarquee(null);
    if (!state) return;
    if (!state.moved) {
      // 空白處單純點一下＝清空選取
      setSelection(null);
      return;
    }
    const { box } = state;
    const left = Math.min(box.x, box.x2);
    const right = Math.max(box.x, box.x2);
    const top = Math.min(box.y, box.y2);
    const bottom = Math.max(box.y, box.y2);
    const hit = [...document.querySelectorAll('[id^="term-student-"]')]
      .filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom;
      })
      .map(node => Number(node.id.replace("term-student-", "")));
    setSelection((current) => {
      const base = state.additive && current?.type === "student" ? current.items : [];
      const merged = [...new Set([...base, ...hit])];
      return merged.length ? { type: "student", items: merged } : null;
    });
  };

  const renderColumn = (column, isFirst, isLast, placementsOverride) => (
    <BoardColumn
      key={column.id}
      column={column}
      draggingType={dragging?.type ?? null}
      isFirst={isFirst}
      isLast={isLast}
      onMoveColumn={moveColumn}
      onEditTeachers={onEditTeachers}
      placements={placementsOverride ?? placementsByColumn.get(column.id) ?? []}
      newStudents={newStudentsByColumn.get(column.id) ?? []}
      onAddNewStudents={onAddNewStudents}
      onRemoveNewStudent={onRemoveNewStudent}
      teachers={teachersByColumn.get(column.id) ?? []}
      teacherLabelOf={teacherLabelOf}
      hasSelection={Boolean(selection)}
      isStudentSelected={memberId => (
        selection?.type === "student" && selection.items.includes(memberId)
      )}
      isTeacherSelected={(teacherId, fromClassroomId) => (
        selection?.type === "teacher"
        && selection.items.some(item => (
          teacherKey(item) === teacherKey({ teacherId, fromClassroomId })
        ))
      )}
      onPromoteTeacher={onPromoteTeacher}
      onPickStudent={(memberId) => {
        if (performance.now() - dragEndedAtRef.current < CLICK_AFTER_DRAG_MS) return;
        toggleSelection("student", memberId, item => item);
      }}
      onPickTeacher={(teacherId, fromClassroomId) => {
        if (performance.now() - dragEndedAtRef.current < CLICK_AFTER_DRAG_MS) return;
        toggleSelection("teacher", { teacherId, fromClassroomId }, teacherKey);
      }}
      onDropInto={columnId => applyTo(columnId, selection)}
      onDepart={memberId => onMovePlacements([memberId], "departed")}
      onRename={onRenameClassroom}
      onRemove={onRemoveClassroom}
      isSubmitting={isSubmitting}
    />
  );

  return (
    <DndContext
      sensors={sensors}
      // 預設的 rectIntersection 比的是「拖曳浮標與各放置區的重疊面積」。空班的欄位只有
      // 標題約 93px＋放置區 96px，浮標壓在上面時與旁邊高欄位（尤其最後一欄「離園」）的
      // 重疊面積反而更大，學生就會被靜靜丟到離園去——2026-08 的實地演練有 7 位這樣跑掉。
      // pointerWithin 只認「游標真的在裡面」的放置區；游標落在空隙時寧可不放，也不亂猜。
      collisionDetection={pointerWithin}
      onDragStart={(event) => {
        setDragging(event.active.data.current ?? null);
      }}
      onDragCancel={() => { setDragging(null); dragEndedAtRef.current = performance.now(); }}
      onDragEnd={handleDragEnd}
    >
      <p className="mb-2 text-xs leading-5 text-gray-500">
        拖曳學生換班、× 標記離園；老師標籤可以拖到別班，點「協」把他改成主教（原主教同時改為協同）。班名點一下改名、⋮⋮ 拖曳或 ‹ › 調順序、× 移除空班。
        點卡片可以多選（同一類），也可以在空白處拖出框來一次框選多位；再點目標班級的標題整批搬過去。
        {selection && (
          <strong className="ml-1 text-indigo-600">
            已選取 {selection.items.length} {selection.type === "teacher" ? "位老師" : "位學生"}
            ，點目標班級的標題即整批搬過去（可以先切到別的分校）；再點一次卡片取消選取。
          </strong>
        )}
      </p>
      {/* 分校分頁：38 欄一次攤開要橫向捲 7400px，一個畫面只看得到 7 欄。
          選取狀態跨分頁保留，跨校搬動就是「這邊選、切過去點標題」。 */}
      {!currentTab && (
        <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
          目前沒有可編入的分校。請先到園所設定建立分校。
        </p>
      )}
      {currentTab && (
      <>
      <div className="mb-2 flex flex-wrap gap-1 border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            aria-label={`切換到 ${tab.label}`}
            aria-current={tab.key === currentTab.key}
            className={[
              "-mb-px rounded-t border-x border-t px-3 py-1.5 text-sm transition",
              tab.key === currentTab.key
                ? "border-gray-200 bg-white font-semibold text-indigo-700"
                : "border-transparent text-gray-500 hover:bg-gray-50",
            ].join(" ")}
          >
            {tab.label}
            <span className="ml-1.5 text-xs font-normal text-gray-400">
              {tab.classroomCount} 班・{tab.studentCount} 位
              {tab.departedCount > 0 ? `・離園 ${tab.departedCount}` : ""}
            </span>
          </button>
        ))}
      </div>
      {/* select-none：框選與拖曳時不要把卡片上的姓名反白 */}
      <div
        id="term-board"
        className="relative select-none overflow-x-auto pb-2"
        onPointerDown={handleMarqueeDown}
        onPointerMove={handleMarqueeMove}
        onPointerUp={handleMarqueeUp}
        onPointerLeave={handleMarqueeUp}
      >
        {marquee && (
          <div
            className="pointer-events-none fixed z-40 rounded border border-indigo-500 bg-indigo-400/20"
            style={{
              left: Math.min(marquee.x, marquee.x2),
              top: Math.min(marquee.y, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x),
              height: Math.abs(marquee.y2 - marquee.y),
            }}
          />
        )}
        <div className="flex items-start gap-2">
          {currentTab.columns.map((column, index) => renderColumn(
            column,
            index === 0,
            index === currentTab.columns.length - 1,
          ))}
          {renderColumn(
            DEPARTED_COLUMN,
            true,
            true,
            departedByCampus.get(currentTab.key) ?? [],
          )}
          {currentTab.columns.length === 0 && (
            <p className="w-56 shrink-0 px-2 py-6 text-sm text-amber-700">
              這個分校在新學期還沒有班級。
            </p>
          )}
          {currentTab.campusId != null && (
            <button
              type="button"
              onClick={() => onAddClassroom(currentTab.campusId)}
              disabled={isSubmitting}
              className="flex h-24 w-44 shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-indigo-300 text-sm text-indigo-500 hover:bg-indigo-50 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              在{currentTab.label}新增班級
            </button>
          )}
        </div>
      </div>
      </>
      )}
      {/* width/height 要覆寫：DragOverlay 預設沿用被拖曳元素的尺寸，而班級的握把
          只有 14px 寬，文字會被擠成一個字一行 */}
      <DragOverlay style={{ width: "auto", height: "auto" }}>
        {draggingLabel && (
          <div className="w-max whitespace-nowrap rounded border border-indigo-400 bg-white px-2 py-1 text-sm shadow-lg">
            {draggingLabel}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
