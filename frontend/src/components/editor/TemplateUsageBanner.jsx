export default function TemplateUsageBanner({ template }) {
  const projectCount = template.project_count ?? 0;
  if (projectCount === 0) return null;
  const studentCount = template.student_count ?? 0;
  const completedProjectCount = template.completed_project_count ?? 0;
  const fullMessage = `此模板已套用於 ${projectCount} 個專案、${studentCount} 位學生；按下儲存後，變更會同步套用。${
    completedProjectCount > 0
      ? ` 其中 ${completedProjectCount} 個專案已完成，既有輸出會標記為需重新產生。`
      : ""
  }`;
  return (
    <div
      role="status"
      className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 max-md:mb-0 max-md:rounded-none max-md:border-x-0 max-md:py-1.5 max-md:text-xs"
      data-guide="template-project-impact"
      title={fullMessage}
    >
      <span className="max-md:block max-md:truncate">{fullMessage}</span>
    </div>
  );
}
