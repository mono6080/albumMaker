import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { copyStudentsFromProject, createProject } from "../api/projectApi";
import FormModal from "./FormModal";
import { Button, FormField, fieldControlClass } from "./ui";

// ── 新建專案 Modal（自管表單狀態；元件常駐掛載，關閉不清空輸入，誤觸不失資料）──
// templates / departments / projects 由頁面載入後傳入；建立成功後直接導向名單頁。

export default function CreateProjectModal({ isOpen, onClose, templates, departments, projects }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    customName: "",
    department: "infant",
    period_id: "",
    template_id: "",
    copy_source_id: "",  // 從既有專案複製學生名單（選填）
  });
  const [creating, setCreating] = useState(false);

  const departmentTemplates = useMemo(
    () => templates.filter(template => template.department === form.department),
    [templates, form.department]
  );
  const activePeriods = useMemo(() => {
    const periodMap = new Map();
    for (const template of departmentTemplates) {
      if (!template.period_id || periodMap.has(template.period_id)) continue;
      periodMap.set(template.period_id, {
        id: template.period_id,
        name: template.period_name,
        department: template.department,
        department_label: template.department_label,
      });
    }
    return Array.from(periodMap.values());
  }, [departmentTemplates]);
  const periodTemplates = useMemo(
    () => departmentTemplates.filter(template => String(template.period_id) === String(form.period_id)),
    [departmentTemplates, form.period_id]
  );

  useEffect(() => {
    const periodExists = activePeriods.some(period => String(period.id) === String(form.period_id));
    const nextPeriodId = periodExists ? form.period_id : (activePeriods[0]?.id ? String(activePeriods[0].id) : "");
    const templatesForNextPeriod = departmentTemplates.filter(template => String(template.period_id) === String(nextPeriodId));
    const templateExists = templatesForNextPeriod.some(template => String(template.id) === String(form.template_id));
    const nextTemplateId = templateExists ? form.template_id : (templatesForNextPeriod[0]?.id ? String(templatesForNextPeriod[0].id) : "");
    if (nextPeriodId === form.period_id && nextTemplateId === form.template_id) return;
    setForm(current => ({
      ...current,
      period_id: nextPeriodId,
      template_id: nextTemplateId,
    }));
  }, [activePeriods, departmentTemplates, form.period_id, form.template_id]);

  const selectedTemplate = templates.find(t => String(t.id) === String(form.template_id));
  const composedName = selectedTemplate
    ? `${selectedTemplate.name}${form.customName.trim() ? " " + form.customName.trim() : ""}`
    : form.customName.trim();

  // ── 建立（成功後直接帶去名單頁開始下一步）
  const handleCreate = async () => {
    if (!form.template_id) return toast.error("請選擇模板");
    if (!composedName.trim()) return toast.error("請填寫名稱");
    setCreating(true);
    try {
      const created = await createProject(composedName, form.template_id, form.department, form.period_id);
      // 選了來源專案就順帶複製學生名單（名冊連結一併延續）
      if (form.copy_source_id) {
        try {
          const copyResult = await copyStudentsFromProject(created.data.id, Number(form.copy_source_id));
          toast.success(`專案已建立，已複製 ${copyResult.data.created.length} 位學生`);
        } catch {
          toast.error("專案已建立，但複製學生名單失敗，請手動新增");
        }
      } else {
        toast.success("專案已建立，先加入學生名單吧");
      }
      setForm(current => ({ ...current, customName: "", template_id: "", copy_source_id: "" }));
      onClose();
      navigate(`/projects/${created.data.id}/review`);
    } catch {
      toast.error("建立失敗");
    } finally {
      setCreating(false);
    }
  };

  return (
    <FormModal isOpen={isOpen} title="新建相本專案" onClose={onClose}>
      <div data-guide="project-create-form">
        <div className="grid grid-cols-1 gap-4 mb-4 md:grid-cols-2">
          <FormField label="部門">
            <select
              className={fieldControlClass}
              value={form.department}
              onChange={e => setForm(f => ({
                ...f,
                department: e.target.value,
                period_id: "",
                template_id: "",
              }))}
            >
              {departments.map(department => (
                <option key={department.code} value={department.code}>{department.name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="期別" hint="這本相本屬於哪一期（由園所行政建立）">
            <select
              className={fieldControlClass}
              value={form.period_id}
              onChange={e => setForm(f => ({ ...f, period_id: e.target.value, template_id: "" }))}
              disabled={activePeriods.length <= 1}
            >
              {activePeriods.length === 0 ? (
                <option value="">尚無使用中期別</option>
              ) : activePeriods.map(period => (
                <option key={period.id} value={period.id}>{period.name}</option>
              ))}
            </select>
          </FormField>
          <FormField label="選擇模板">
            <select
              className={fieldControlClass}
              value={form.template_id}
              onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
            >
              {periodTemplates.length === 0 ? (
                <option value="">此期別尚無模板</option>
              ) : (
                <option value="">請選擇...</option>
              )}
              {periodTemplates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}（{t.page_count} 頁 / {t.photo_count ?? 0} 張照片）
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="自訂名稱" hint="接在模板名稱後，例：分校或班級">
            <input
              className={fieldControlClass}
              placeholder="例：東區校 10階A"
              value={form.customName}
              onChange={e => setForm(f => ({ ...f, customName: e.target.value }))}
            />
          </FormField>
          <FormField label="複製學生名單（選填）" hint="從上一期的專案帶入全班名單，不複製照片與文字">
            <select
              className={fieldControlClass}
              value={form.copy_source_id}
              onChange={e => setForm(f => ({ ...f, copy_source_id: e.target.value }))}
            >
              <option value="">不複製</option>
              {projects
                .filter(project => project.student_count > 0)
                .map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}（{project.student_count} 位學生）
                  </option>
                ))}
            </select>
          </FormField>
        </div>
        {composedName && (
          <div className="text-xs text-gray-500 mb-4 break-words">
            專案全名：<span className="font-medium text-gray-800">{composedName}</span>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <Button onClick={onClose} variant="ghost">
            取消
          </Button>
          <Button onClick={handleCreate} disabled={creating} variant="primary">
            {creating ? "建立中..." : "建立專案"}
          </Button>
        </div>
      </div>
    </FormModal>
  );
}
