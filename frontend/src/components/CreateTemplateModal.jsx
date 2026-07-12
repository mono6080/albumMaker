import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Plus } from "lucide-react";
import { createTemplate } from "../api/templateApi";
import FormModal from "./FormModal";
import { Button, FormField, fieldControlClass } from "./ui";

// ── 建立模板 Modal（自管表單狀態；元件常駐掛載，關閉不清空輸入）──────────────
// periods / templates 由頁面載入後傳入；建立成功後透過 onCreated 讓頁面重新載入清單。

export default function CreateTemplateModal({
  isOpen,
  onClose,
  periods,
  selectedDepartment,
  selectedPeriodId,
  templates,
  onCreated,
}) {
  const [templateForm, setTemplateForm] = useState({
    name: "",
    periodId: "",
    mode: "blank",
    sourceTemplateId: "",
  });
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  useEffect(() => {
    if (!selectedPeriodId) return;
    setTemplateForm(form => {
      const periodStillExists = periods.some(period => String(period.id) === String(form.periodId));
      if (periodStillExists && form.periodId) return form;
      return { ...form, periodId: selectedPeriodId };
    });
  }, [periods, selectedPeriodId]);

  const periodOptions = useMemo(
    () => periods.filter(period => period.department === selectedDepartment),
    [periods, selectedDepartment]
  );

  const handleCreateTemplate = async () => {
    const targetPeriodId = templateForm.periodId || selectedPeriodId;
    if (!targetPeriodId) return toast.error("請先選擇期別");
    if (!templateForm.name.trim()) return toast.error("請填寫模板名稱");
    if (templateForm.mode === "copy" && !templateForm.sourceTemplateId) {
      return toast.error("請選擇要複製的模板");
    }

    setCreatingTemplate(true);
    try {
      await createTemplate(
        templateForm.name.trim(),
        targetPeriodId,
        templateForm.mode === "copy" ? templateForm.sourceTemplateId : undefined
      );
      toast.success(templateForm.mode === "copy" ? "模板已複製" : "模板已建立");
      setTemplateForm(form => ({ ...form, name: "", sourceTemplateId: "" }));
      onClose();
      await onCreated();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "建立模板失敗");
    } finally {
      setCreatingTemplate(false);
    }
  };

  return (
    <FormModal isOpen={isOpen} title="建立新模板" onClose={onClose}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormField label="模板名稱" className="md:col-span-2">
          <input
            id="template-name"
            data-guide="template-name-input"
            className={fieldControlClass}
            placeholder="2026-06 12階 感官世界"
            value={templateForm.name}
            onChange={event => setTemplateForm(form => ({ ...form, name: event.target.value }))}
            onKeyDown={event => event.key === "Enter" && handleCreateTemplate()}
          />
        </FormField>
        <FormField label="目標期別">
          <select
            className={fieldControlClass}
            value={templateForm.periodId || selectedPeriodId}
            onChange={event => setTemplateForm(form => ({ ...form, periodId: event.target.value }))}
          >
            <option value="">請選擇...</option>
            {periodOptions.map(period => (
              <option key={period.id} value={period.id}>
                {period.name}（{period.status_label}）
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="建立方式">
          <select
            className={fieldControlClass}
            value={templateForm.mode}
            onChange={event => setTemplateForm(form => ({ ...form, mode: event.target.value }))}
          >
            <option value="blank">從零開始</option>
            <option value="copy">複製過往模板</option>
          </select>
        </FormField>
        {templateForm.mode === "copy" && (
          <FormField label="來源模板" className="md:col-span-2">
            <select
              className={fieldControlClass}
              value={templateForm.sourceTemplateId}
              onChange={event => setTemplateForm(form => ({ ...form, sourceTemplateId: event.target.value }))}
            >
              <option value="">請選擇要複製的模板...</option>
              {templates.map(template => (
                <option key={template.id} value={template.id}>
                  {template.department_label || "未分類"} / {template.period_name || "未分類"} / {template.name}
                </option>
              ))}
            </select>
          </FormField>
        )}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button onClick={onClose} variant="ghost">
          取消
        </Button>
        <Button
          onClick={handleCreateTemplate}
          disabled={creatingTemplate || !templateForm.name.trim()}
          data-guide="template-create-button"
          variant="primary"
        >
          <Plus className="h-4 w-4" />
          {creatingTemplate ? "建立中" : "建立模板"}
        </Button>
      </div>
    </FormModal>
  );
}
