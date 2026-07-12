// 學期彙整匯出：待確認配對區塊
// 名冊中有多個同名孩子、系統無法自動判斷時的人工配對介面；操作邏輯在 SemesterExport 頁

import { Button, Surface } from "./ui";

export default function SemesterUnlinkedSection({
  // 「待確認」chip 捲動定位用的 ref（由頁面持有）
  sectionRef,
  unlinked,
  isAdmin,
  onLinkStudent,
  onCreateNewChild,
}) {
  return (
    <Surface ref={sectionRef} className="mb-4 max-h-52 shrink-0 overflow-auto border-amber-200 bg-amber-50/60">
      <h2 className="mb-2 text-sm font-bold text-amber-800">
        待確認配對（{unlinked.length}）
      </h2>
      <p className="mb-3 text-xs text-amber-700">
        名冊中有多個同名孩子，系統無法自動判斷這些學生是誰，請人工確認。未配對的學生不會納入匯出。
      </p>
      <div className="flex flex-col gap-2">
        {unlinked.map(entry => (
          <div
            key={entry.student_id}
            className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-white p-3 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium text-gray-900">{entry.student_name}</span>
              <span className="ml-2 text-gray-500">{entry.project_name}</span>
              {entry.owner_name && (
                <span className="ml-2 text-xs text-gray-400">老師:{entry.owner_name}</span>
              )}
            </div>
            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                {entry.candidates.map(candidate => (
                  <Button
                    key={candidate.roster_child_id}
                    variant="secondary"
                    size="xs"
                    onClick={() => onLinkStudent(entry.student_id, candidate.roster_child_id)}
                  >
                    就是「{candidate.name}」#{candidate.roster_child_id}
                  </Button>
                ))}
                <Button variant="neutral" size="xs" onClick={() => onCreateNewChild(entry)}>
                  是新的孩子
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Surface>
  );
}
