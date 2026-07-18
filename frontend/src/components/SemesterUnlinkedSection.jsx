// 學期彙整匯出：名冊身分或正式學期歸班異常的只讀清單

import { Surface } from "./ui";

const ANOMALY_LABELS = Object.freeze({
  missing_roster_child: "尚未連結園所學生",
  invalid_roster_child: "學生身分已失效",
  duplicate_project_roster_child: "同一本相本重複學生身分",
  missing_term_student_snapshot: "尚未納入本學期最終名單",
});

function formatAnomalyReasons(entry) {
  const reasons = (entry.identity_anomalies ?? [])
    .map(code => ANOMALY_LABELS[code] ?? "名冊身分不一致");
  return [...new Set(reasons)].join("、") || "名冊身分不一致";
}

export default function SemesterUnlinkedSection({
  // 「遷移異常」chip 捲動定位用的 ref（由頁面持有）
  sectionRef,
  unlinked,
}) {
  return (
    <Surface ref={sectionRef} className="mb-4 max-h-52 shrink-0 overflow-auto border-amber-200 bg-amber-50/60">
      <h2 className="mb-2 text-sm font-bold text-amber-800">
        名冊或學期歸班異常（{unlinked.length}）
      </h2>
      <p className="mb-3 text-xs text-amber-700">
        這些相本的學生身分與正式學期名單不一致，不會納入匯出。請由管理員回到園所設定確認歸班資料。
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
            <span className="text-xs text-amber-700">
              {formatAnomalyReasons(entry)} · 未納入本次匯出
            </span>
          </div>
        ))}
      </div>
    </Surface>
  );
}
