import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import {
  fetchAllTemplates,
  createTemplate,
  deleteTemplate,
  renameTemplate,
  fetchTemplateDepartments,
  fetchTemplatePeriods,
  createTemplatePeriod,
  updateTemplatePeriod,
} from "../api/templateApi";
import {
  BookOpen,
  CalendarDays,
  Check,
  Images,
  LayoutTemplate,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import {
  mobileVisibleHoverActionClass,
  mobileVisibleNamedHoverActionClass,
} from "../components/ResponsiveActionGroup";
import {
  Badge,
  Button,
  FormField,
  IconButton,
  PageHeader,
  SegmentedControl,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { useInlineEdit } from "../hooks/useInlineEdit";

const FALLBACK_DEPARTMENTS = [
  { code: "infant", name: "嬰幼部" },
  { code: "academy", name: "學院部" },
];

const PERIOD_STATUSES = [
  { value: "draft", label: "草稿" },
  { value: "active", label: "使用中" },
  { value: "archived", label: "已封存" },
];

function statusTone(status) {
  if (status === "active") return "success";
  if (status === "archived") return "archive";
  return "warning";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("zh-TW");
}

export default function TemplateList() {
  const [departments, setDepartments] = useState(FALLBACK_DEPARTMENTS);
  const [periods, setPeriods] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedDepartment, setSelectedDepartment] = useState("infant");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [periodForm, setPeriodForm] = useState({
    name: "",
    department: "infant",
    status: "draft",
  });
  const [templateForm, setTemplateForm] = useState({
    name: "",
    periodId: "",
    mode: "blank",
    sourceTemplateId: "",
  });
  const [showTemplateCreate, setShowTemplateCreate] = useState(false);
  const [creatingPeriod, setCreatingPeriod] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  const load = useCallback(async () => {
    const [departmentResponse, periodResponse, templateResponse] = await Promise.all([
      fetchTemplateDepartments(),
      fetchTemplatePeriods(),
      fetchAllTemplates(),
    ]);
    setDepartments(departmentResponse.data.length ? departmentResponse.data : FALLBACK_DEPARTMENTS);
    setPeriods(periodResponse.data);
    setTemplates(templateResponse.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPeriodForm(form => ({ ...form, department: selectedDepartment }));
  }, [selectedDepartment]);

  const departmentPeriods = useMemo(
    () => periods.filter(period => period.department === selectedDepartment),
    [periods, selectedDepartment]
  );

  useEffect(() => {
    const currentExists = departmentPeriods.some(period => String(period.id) === String(selectedPeriodId));
    if (currentExists) return;
    const nextPeriod = departmentPeriods.find(period => period.status === "active") ?? departmentPeriods[0];
    setSelectedPeriodId(nextPeriod ? String(nextPeriod.id) : "");
  }, [departmentPeriods, selectedPeriodId]);

  useEffect(() => {
    if (!selectedPeriodId) return;
    setTemplateForm(form => {
      const periodStillExists = periods.some(period => String(period.id) === String(form.periodId));
      if (periodStillExists && form.periodId) return form;
      return { ...form, periodId: selectedPeriodId };
    });
  }, [periods, selectedPeriodId]);

  const selectedPeriod = useMemo(
    () => periods.find(period => String(period.id) === String(selectedPeriodId)),
    [periods, selectedPeriodId]
  );

  const visibleTemplates = useMemo(() => {
    return templates.filter(template => {
      if (selectedPeriodId) return String(template.period_id) === String(selectedPeriodId);
      return template.department === selectedDepartment;
    });
  }, [templates, selectedDepartment, selectedPeriodId]);

  useEffect(() => {
    if (visibleTemplates.length === 0) {
      setShowTemplateCreate(true);
    }
  }, [visibleTemplates.length]);

  const periodOptions = useMemo(
    () => periods.filter(period => period.department === selectedDepartment),
    [periods, selectedDepartment]
  );

  const { editingId, editingValue: editingName, setEditingValue: setEditingName,
    startEdit, cancelEdit, submitEdit: saveEdit } = useInlineEdit(
    useCallback(async (id, newName) => {
      await renameTemplate(id, newName);
      toast.success("已更新名稱");
      load();
    }, [load])
  );

  const handleCreatePeriod = async () => {
    if (!periodForm.name.trim()) return toast.error("請填寫期別名稱");
    setCreatingPeriod(true);
    try {
      const response = await createTemplatePeriod({
        ...periodForm,
        name: periodForm.name.trim(),
      });
      toast.success("期別已建立");
      setSelectedDepartment(response.data.department);
      setSelectedPeriodId(String(response.data.id));
      setPeriodForm(form => ({ ...form, name: "" }));
      await load();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "建立期別失敗");
    } finally {
      setCreatingPeriod(false);
    }
  };

  const handleUpdatePeriodStatus = async (periodId, status) => {
    try {
      await updateTemplatePeriod(periodId, { status });
      toast.success("期別狀態已更新");
      await load();
    } catch {
      toast.error("更新期別狀態失敗");
    }
  };

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
      setShowTemplateCreate(false);
      await load();
    } catch (error) {
      const detail = error.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "建立模板失敗");
    } finally {
      setCreatingTemplate(false);
    }
  };

  const handleMoveTemplate = async (template, nextPeriodId) => {
    if (!nextPeriodId || String(nextPeriodId) === String(template.period_id)) return;
    try {
      await renameTemplate(template.id, undefined, nextPeriodId);
      toast.success("模板期別已更新");
      await load();
    } catch {
      toast.error("更新模板期別失敗");
    }
  };

  const handleDelete = (id, e) => {
    e.preventDefault();
    setConfirmModal({
      message: "確定刪除此模板？已建立專案使用中的模板不建議刪除。",
      onConfirm: async () => {
        await deleteTemplate(id);
        toast.success("已刪除");
        load();
      },
    });
  };

  return (
    <div className="w-full">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />

      <PageHeader
        icon={LayoutTemplate}
        title="模板管理"
        subtitle="依部門與期別管理週期性模板"
      />

      <Surface className="mb-6" padding="lg">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
          <div className="min-w-0">
            <FormField label="部門">
              <SegmentedControl
                value={selectedDepartment}
                onChange={setSelectedDepartment}
                options={departments.map(department => ({
                  value: department.code,
                  label: department.name,
                }))}
              />
            </FormField>

            <div className="mt-4 flex flex-wrap gap-2">
              {departmentPeriods.length === 0 ? (
                <div className="text-sm text-gray-400">此部門尚未建立期別</div>
              ) : departmentPeriods.map(period => (
                <button
                  key={period.id}
                  type="button"
                  onClick={() => setSelectedPeriodId(String(period.id))}
                  className={`inline-flex min-h-10 min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    String(selectedPeriodId) === String(period.id)
                      ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <CalendarDays className="h-4 w-4 flex-shrink-0" />
                  <span className="font-medium">{period.name}</span>
                  <Badge tone={statusTone(period.status)}>{period.status_label}</Badge>
                  <span className="text-xs text-gray-400">{period.template_count} 個模板</span>
                </button>
              ))}
            </div>

            {selectedPeriod && (
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-end">
                <div className="min-w-0 text-sm text-gray-500">
                  目前檢視：
                  <span className="font-medium text-gray-800">
                    {selectedPeriod.department_label} / {selectedPeriod.name}
                  </span>
                </div>
                <FormField label="期別狀態">
                  <select
                    className={fieldControlClass}
                    value={selectedPeriod.status}
                    onChange={event => handleUpdatePeriodStatus(selectedPeriod.id, event.target.value)}
                  >
                    {PERIOD_STATUSES.map(status => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </FormField>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <FormField label="新增期別">
                <input
                  className={fieldControlClass}
                  placeholder="例：202606"
                  value={periodForm.name}
                  onChange={event => setPeriodForm(form => ({ ...form, name: event.target.value }))}
                  onKeyDown={event => event.key === "Enter" && handleCreatePeriod()}
                />
              </FormField>
              <FormField label="建立狀態">
                <select
                  className={fieldControlClass}
                  value={periodForm.status}
                  onChange={event => setPeriodForm(form => ({ ...form, status: event.target.value }))}
                >
                  {PERIOD_STATUSES.map(status => (
                    <option key={status.value} value={status.value}>{status.label}</option>
                  ))}
                </select>
              </FormField>
            </div>
            <Button
              type="button"
              onClick={handleCreatePeriod}
              disabled={creatingPeriod || !periodForm.name.trim()}
              variant="secondary"
              fullWidth
            >
              <Plus className="h-4 w-4" />
              {creatingPeriod ? "建立中" : "建立期別"}
            </Button>
          </div>
        </div>
      </Surface>

      <Surface className="mb-6 border-indigo-100" padding={showTemplateCreate ? "lg" : "md"} data-guide="template-create-card">
        <div className={`${showTemplateCreate ? "mb-4" : ""} flex items-center justify-between gap-3`}>
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-4 w-4 flex-shrink-0 text-indigo-500" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-800">建立新模板</h2>
              {!showTemplateCreate && (
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  目前期別：{selectedPeriod?.department_label ?? "未選擇"} / {selectedPeriod?.name ?? "未選擇"}
                </p>
              )}
            </div>
          </div>
          <Button
            type="button"
            onClick={() => setShowTemplateCreate(value => !value)}
            variant={showTemplateCreate ? "ghost" : "primary"}
            size="sm"
          >
            {showTemplateCreate ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {showTemplateCreate ? "收合" : "建立模板"}
          </Button>
        </div>

        {showTemplateCreate && (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_180px_220px_160px] lg:items-end">
              <FormField label="模板名稱">
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
              <Button
                onClick={handleCreateTemplate}
                disabled={creatingTemplate || !templateForm.name.trim()}
                data-guide="template-create-button"
                variant="primary"
                fullWidth
              >
                <Plus className="h-4 w-4" />
                {creatingTemplate ? "建立中" : "建立"}
              </Button>
            </div>
            {templateForm.mode === "copy" && (
              <div className="mt-4">
                <FormField label="來源模板">
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
              </div>
            )}
          </>
        )}
      </Surface>

      {visibleTemplates.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <LayoutTemplate className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">此期別尚未建立模板</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleTemplates.map(template => (
            <Surface
              key={template.id}
              className="group overflow-hidden transition-all hover:border-indigo-200 hover:shadow-md"
              padding="none"
              data-guide="template-card"
            >
              <div className="p-5">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-500">
                    <BookOpen className="h-4 w-4" />
                  </div>
                  <IconButton
                    label="刪除模板"
                    onClick={event => handleDelete(template.id, event)}
                    variant="danger"
                    className={mobileVisibleHoverActionClass}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>

                {editingId === template.id ? (
                  <div className="mb-2 flex min-w-0 items-center gap-1">
                    <input
                      autoFocus
                      className={`${fieldControlClass} flex-1 py-1 font-semibold`}
                      value={editingName}
                      onChange={event => setEditingName(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === "Enter") saveEdit(template.id);
                        if (event.key === "Escape") cancelEdit();
                      }}
                    />
                    <IconButton label="儲存模板名稱" variant="success" onClick={() => saveEdit(template.id)}>
                      <Check className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton label="取消編輯模板名稱" onClick={cancelEdit}>
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ) : (
                  <div className="mb-2 flex min-w-0 items-center gap-1 group/name">
                    <span className="truncate font-semibold text-gray-900">{template.name}</span>
                    <IconButton
                      label="編輯模板名稱"
                      onClick={() => startEdit(template.id, template.name)}
                      variant="primary"
                      size="xs"
                      className={mobileVisibleNamedHoverActionClass}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                )}

                <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-gray-400" data-guide="template-card-counts">
                  <Badge tone={statusTone(template.period_status)}>{template.period_status_label || "未分類"}</Badge>
                  <span>{template.page_count} 頁</span>
                  <span className="text-gray-300">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Images className="h-3 w-3" />
                    {template.photo_count ?? 0} 張照片
                  </span>
                  <span className="text-gray-300">·</span>
                  <span>{formatDate(template.created_at)}</span>
                </div>

                <FormField label="所屬期別" className="mb-4">
                  <select
                    className={fieldControlClass}
                    value={template.period_id || ""}
                    onChange={event => handleMoveTemplate(template, event.target.value)}
                  >
                    {periods.map(period => (
                      <option key={period.id} value={period.id}>
                        {period.department_label} / {period.name}（{period.status_label}）
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>

              <div className="border-t border-gray-100 p-3">
                <Button
                  as={Link}
                  to={`/templates/${template.id}/edit`}
                  data-guide="template-edit-link"
                  variant="secondary"
                  fullWidth
                >
                  <Pencil className="h-3.5 w-3.5" />
                  編輯模板
                </Button>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
