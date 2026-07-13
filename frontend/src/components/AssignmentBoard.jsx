// 手動配對拖曳板（批次照片分配精靈 Step 3 的手動模式）
//   拖曳照片到學生指派、拖學生互換、拖到照片池取消；
//   也支援「點照片拿起、點學生放下」的點選模式。
//   對外只透過 props 溝通：students / matchResult / files / getUrl / onAssign / onClear / onSwap

import { useMemo, useState } from "react";
import { DndContext, DragOverlay, useDraggable, useDroppable } from "@dnd-kit/core";
import { Image as ImageIcon, X } from "lucide-react";
import { useDndPhotoSensors } from "../hooks/useDndPhotoSensors";

function fileKey(file) {
  return `${file.name}__${file.size}__${file.lastModified}`;
}

export default function AssignmentBoard({ students, matchResult, files, getUrl, onAssign, onClear, onSwap }) {
  const [focusedFileKey, setFocusedFileKey] = useState(null);
  const [activeDragData, setActiveDragData] = useState(null); // { type: "file"|"student", fileKeyValue?, studentId? }

  const assignmentByStudent = useMemo(() => {
    const map = new Map();
    matchResult.assignments.forEach((a) => map.set(a.studentId, a.file));
    return map;
  }, [matchResult]);

  const studentByFileKey = useMemo(() => {
    const map = new Map();
    matchResult.assignments.forEach((a) => map.set(fileKey(a.file), a.studentId));
    return map;
  }, [matchResult]);

  const fileByKey = useMemo(() => {
    const map = new Map();
    files.forEach((f) => map.set(fileKey(f), f));
    return map;
  }, [files]);

  const studentById = useMemo(() => {
    const map = new Map();
    students.forEach((s) => map.set(s.id, s));
    return map;
  }, [students]);

  const focusedFile = focusedFileKey ? fileByKey.get(focusedFileKey) : null;

  // 邊緣自動捲動由 DndContext 內建處理，長清單拖到畫面外目標時會自動捲動
  const dndSensors = useDndPhotoSensors();

  const handleDragStart = (event) => {
    setFocusedFileKey(null);
    setActiveDragData(event.active.data.current);
  };

  const handleDragCancel = () => setActiveDragData(null);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveDragData(null);
    if (!over) return;
    const source = active.data.current;
    const target = over.data.current;
    if (source.type === "file" && target?.type === "student") {
      const file = fileByKey.get(source.fileKeyValue);
      if (file) onAssign(target.studentId, file);
      return;
    }
    if (source.type === "student" && target?.type === "student") {
      if (source.studentId !== target.studentId) onSwap(source.studentId, target.studentId);
      return;
    }
    if (source.type === "student" && target?.type === "pool") {
      onClear(source.studentId);
    }
  };

  // ── 點選模式：點照片（含已配對學生身上的照片）「拿起」，再點目標學生「放下」 ──

  const handleFileTap = (file) => () => {
    const key = fileKey(file);
    setFocusedFileKey(focusedFileKey === key ? null : key);
  };

  const handleStudentTap = (studentId) => () => {
    if (focusedFile) {
      // 點到照片目前的主人視為取消拿起
      if (studentByFileKey.get(focusedFileKey) === studentId) {
        setFocusedFileKey(null);
        return;
      }
      onAssign(studentId, focusedFile);
      setFocusedFileKey(null);
      return;
    }
    // 沒有拿起中的照片時，點已配對的學生 → 拿起他身上的照片
    const assignedFile = assignmentByStudent.get(studentId);
    if (assignedFile) setFocusedFileKey(fileKey(assignedFile));
  };

  const usedKeys = new Set(matchResult.assignments.map((a) => fileKey(a.file)));
  const unusedFiles = files.filter((f) => !usedKeys.has(fileKey(f)));

  // 拖曳殘影顯示的照片
  const activeDragFile = activeDragData
    ? activeDragData.type === "file"
      ? fileByKey.get(activeDragData.fileKeyValue)
      : assignmentByStudent.get(activeDragData.studentId)
    : null;

  return (
    <DndContext
      sensors={dndSensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className="space-y-3"
        // dnd-kit 拖曳走 pointer event,不會觸發這裡的原生 HTML5 drag 事件；
        // 這兩個 handler 只會攔到「從作業系統拖檔案進來」的情境，避免瀏覽器
        // 用預設的開檔導覽把整個精靈換掉、弄丟尚未完成的指派
        onDragOver={e => e.preventDefault()}
        onDrop={e => e.preventDefault()}
      >
        <div className="rounded-md border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-[11px] text-indigo-800">
          💡 拖曳（手機長按後拖）照片到學生指派、拖學生互換、拖到照片池取消；
          或先點照片、再點目標學生。鍵盤可用 Tab 移動、Enter／空白鍵拿起或放下。
        </div>

        {/* 拿起中的照片提示列：黏在頂端，捲動時仍可見 */}
        {focusedFile && (
          <div className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 shadow-sm">
            {getUrl(focusedFile) && (
              <img src={getUrl(focusedFile)} alt={focusedFile.name} className="h-8 w-8 rounded object-cover" />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-indigo-800">
              已拿起 {focusedFile.name} — 點目標學生完成指派
            </span>
            <button
              type="button"
              onClick={() => setFocusedFileKey(null)}
              className="rounded border border-indigo-200 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100"
            >
              取消
            </button>
          </div>
        )}

        {/* 學生列 */}
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-white p-2 sm:grid-cols-3 lg:grid-cols-4">
          {students.map((student, index) => (
            <StudentCell
              key={student.id}
              student={student}
              index={index}
              file={assignmentByStudent.get(student.id) ?? null}
              url={assignmentByStudent.get(student.id) ? getUrl(assignmentByStudent.get(student.id)) : null}
              canTapAssign={!!focusedFile}
              onTap={handleStudentTap(student.id)}
              onClearAssignment={() => onClear(student.id)}
            />
          ))}
        </div>

        {/* 照片池 */}
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          照片池（{files.length}）
          {unusedFiles.length > 0 && <span className="ml-2 text-amber-700">未使用 {unusedFiles.length}</span>}
        </div>
        <PoolArea isEmpty={files.length === 0}>
          {files.map((file) => (
            <PoolPhoto
              key={fileKey(file)}
              file={file}
              url={getUrl(file)}
              assignedName={(() => {
                const assignedTo = studentByFileKey.get(fileKey(file));
                return assignedTo ? studentById.get(assignedTo)?.name ?? null : null;
              })()}
              isFocused={fileKey(file) === focusedFileKey}
              onTap={handleFileTap(file)}
            />
          ))}
        </PoolArea>
      </div>

      {/* 拖曳殘影：跟著游標/手指移動的縮圖 */}
      <DragOverlay dropAnimation={null}>
        {activeDragFile ? (
          <div className="h-16 w-16 overflow-hidden rounded-md border-2 border-indigo-400 bg-white shadow-lg">
            {getUrl(activeDragFile) && (
              <img src={getUrl(activeDragFile)} alt={activeDragFile.name} className="h-full w-full object-cover" />
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// 學生格：可放（指派目標）也可拖（有照片時，拖去交換或退回照片池）
function StudentCell({ student, index, file, url, canTapAssign, onTap, onClearAssignment }) {
  // 不展開 dnd-kit 的 attributes：它會加 role="button" 與 aria-disabled，
  // 使「未配對但可點選指派」的格被輔助工具誤判為停用
  const { setNodeRef: setDragRef, listeners, isDragging } = useDraggable({
    id: `student-${student.id}`,
    data: { type: "student", studentId: student.id },
    disabled: !file,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `student-drop-${student.id}`,
    data: { type: "student", studentId: student.id },
  });

  return (
    <div
      ref={(node) => { setDragRef(node); setDropRef(node); }}
      {...listeners}
      onClick={onTap}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onTap();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={file ? `${student.name}，已配對 ${file.name}` : `${student.name}，未配對`}
      style={{ touchAction: "manipulation" }}
      className={`group relative flex flex-col overflow-hidden rounded-lg border bg-white transition-all ${
        isOver
          ? "border-indigo-500 ring-2 ring-indigo-300"
          : file
          ? "border-emerald-200"
          : canTapAssign
          ? "border-indigo-300 ring-1 ring-indigo-200"
          : "border-dashed border-amber-300 bg-amber-50/30"
      } ${file ? "cursor-grab active:cursor-grabbing" : canTapAssign ? "cursor-pointer" : "cursor-default"} ${
        isDragging ? "opacity-40" : ""
      }`}
      title={file ? `${student.name} ← ${file.name}（拖移可交換）` : `${student.name}（未配對）`}
    >
      <div className="flex items-center gap-1 px-2 py-1 text-[11px]">
        <span className="text-gray-400">{index + 1}.</span>
        <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{student.name}</span>
        {file && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onClearAssignment(); }}
            className="rounded-full p-0.5 text-gray-300 hover:bg-red-100 hover:text-red-600"
            aria-label={`取消 ${student.name} 的配對`}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {/* 方形用 padding-bottom 百分比而非 aspect-ratio（WebKit grid 行高問題，見 FileTile） */}
      <div className="relative w-full bg-gray-50 pb-[100%]">
        {url ? (
          <img
            src={url} alt={file.name} draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
            style={{ WebkitTouchCallout: "none", userSelect: "none" }}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-amber-600">
            <ImageIcon className="h-5 w-5 opacity-60" />
            <span className="text-[10px]">未配對</span>
          </div>
        )}
      </div>
    </div>
  );
}

// 照片池容器：接收「拖學生 → 取消分配」的放置目標
function PoolArea({ isEmpty, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: "pool", data: { type: "pool" } });
  return (
    <div
      ref={setNodeRef}
      // 手機 2 格一層（同照片管理的節奏），sm 以上再加密
      className={`grid grid-cols-2 gap-2 rounded-lg border bg-gray-50/60 p-2 sm:grid-cols-6 md:grid-cols-8 ${
        isOver ? "border-red-400 ring-2 ring-red-200" : "border-gray-200"
      }`}
    >
      {isEmpty && (
        <div className="col-span-full py-6 text-center text-xs text-gray-400">尚未選任何照片</div>
      )}
      {children}
    </div>
  );
}

// 照片池單張照片：可拖去指派，也可點選拿起
function PoolPhoto({ file, url, assignedName, isFocused, onTap }) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `file-${fileKey(file)}`,
    data: { type: "file", fileKeyValue: fileKey(file) },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      onClick={onTap}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onTap();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={isFocused}
      aria-label={`${file.name}${assignedName ? `，已配對給 ${assignedName}` : "，未使用"}`}
      style={{ touchAction: "manipulation" }}
      // 方形用 padding-bottom 百分比而非 aspect-ratio（WebKit grid 行高問題，見 FileTile）
      className={`group relative w-full cursor-grab overflow-hidden rounded-md border bg-white pb-[100%] transition-all active:cursor-grabbing ${
        isFocused
          ? "border-indigo-500 ring-2 ring-indigo-300"
          : assignedName
          ? "border-emerald-300"
          : "border-amber-300"
      } ${isDragging ? "opacity-40" : ""}`}
      title={assignedName ? `已配對給 ${assignedName}` : "未使用，拖到學生上指派"}
    >
      {url ? (
        <img
          src={url} alt={file.name} draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          style={{ WebkitTouchCallout: "none", userSelect: "none" }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-gray-300">
          <ImageIcon className="h-5 w-5" />
        </div>
      )}
      {assignedName && (
        <div className="absolute inset-x-0 top-0 truncate bg-emerald-600/85 px-1 py-0.5 text-center text-[10px] font-medium text-white">
          → {assignedName}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
        {file.name}
      </div>
    </div>
  );
}
