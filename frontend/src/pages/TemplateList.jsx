import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  fetchAllTemplates,
  deleteTemplate,
  renameTemplate,
  fetchTemplateDepartments,
  fetchTemplatePeriods,
  createTemplatePeriod,
  updateTemplatePeriod,
} from "../api/templateApi";
import { fetchAcademicTerms } from "../api/organizationApi";
import {
  BookOpen,
  CalendarDays,
  LayoutTemplate,
  Plus,
} from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import CreateTemplateModal from "../components/CreateTemplateModal";
import TemplateCard from "../components/TemplateCard";
import {
  Badge,
  Button,
  FormField,
  PageHeader,
  SegmentedControl,
  Surface,
  fieldControlClass,
} from "../components/ui";
import { useInlineEdit } from "../hooks/useInlineEdit";
import { statusTone } from "../utils/periodStatus";

const FALLBACK_DEPARTMENTS = [
  { code: "infant", name: "嬰幼部" },
  { code: "academy", name: "學院部" },
];

const PERIOD_STATUSES = [
  { value: "draft", label: "草稿" },
  { value: "active", label: "使用中" },
  { value: "archived", label: "已封存" },
];

export default function TemplateList() {
  const [departments, setDepartments] = useState(FALLBACK_DEPARTMENTS);
  const [periods, setPeriods] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [academicTerms, setAcademicTerms] = useState([]);
  const [selectedDepartment, setSelectedDepartment] = useState("infant");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [periodForm, setPeriodForm] = useState({
    name: "",
    department: "infant",
    status: "draft",
    academicTermId: "",
  });
  const [showTemplateCreate, setShowTemplateCreate] = useState(false);
  const [creatingPeriod, setCreatingPeriod] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  const load = useCallback(async () => {
    const [departmentResponse, periodResponse, templateResponse, termResponse] = await Promise.all([
      fetchTemplateDepartments(),
      fetchTemplatePeriods(),
      fetchAllTemplates(),
      fetchAcademicTerms(),
    ]);
    setDepartments(departmentResponse.data.length ? departmentResponse.data : FALLBACK_DEPARTMENTS);
    setPeriods(periodResponse.data);
    setTemplates(templateResponse.data);
    setAcademicTerms(termResponse.data);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPeriodForm(form => ({ ...form, department: selectedDepartment }));
  }, [selectedDepartment]);

  const assignableAcademicTerms = useMemo(() => (
    academicTerms.filter(term => ["draft", "imported", "active"].includes(term.status))
  ), [academicTerms]);

  useEffect(() => {
    setPeriodForm(form => {
      if (assignableAcademicTerms.some(term => String(term.id) === String(form.academicTermId))) {
        return form;
      }
      const defaultTerm = assignableAcademicTerms.find(term => term.status === "draft")
        ?? assignableAcademicTerms.find(term => ["active", "imported"].includes(term.status));
      return { ...form, academicTermId: defaultTerm ? String(defaultTerm.id) : "" };
    });
  }, [assignableAcademicTerms]);

  const academicTermNameById = useMemo(() => new Map(
    academicTerms.map(term => [String(term.id), term.label]),
  ), [academicTerms]);

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

  // （建立表單已改為 Modal：不再於期別無模板時自動展開，避免一進頁就跳彈窗）

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
        academicTermId: periodForm.academicTermId || undefined,
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
        onConfirm={async () => { await confirmModal?.onConfirm(); setConfirmModal(null); }}
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
                  {period.academic_term_id && (
                    <span className="text-xs text-gray-400">
                      {academicTermNameById.get(String(period.academic_term_id)) ?? "正式學期"}
                    </span>
                  )}
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
              <FormField label="所屬正式學期">
                <select
                  className={fieldControlClass}
                  value={periodForm.academicTermId}
                  onChange={event => setPeriodForm(form => ({ ...form, academicTermId: event.target.value }))}
                >
                  <option value="">尚未建立正式學期</option>
                  {assignableAcademicTerms.map(term => (
                    <option key={term.id} value={term.id}>
                      {term.label}{term.status === "draft" ? "（編班草稿）" : "（目前學期）"}
                    </option>
                  ))}
                </select>
              </FormField>
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

      <Surface className="mb-6 border-indigo-100" padding="md" data-guide="template-create-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpen className="h-4 w-4 flex-shrink-0 text-indigo-500" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-800">建立新模板</h2>
              <p className="mt-0.5 truncate text-xs text-gray-400">
                目前期別：{selectedPeriod?.department_label ?? "未選擇"} / {selectedPeriod?.name ?? "未選擇"}
              </p>
            </div>
          </div>
          <Button
            type="button"
            onClick={() => setShowTemplateCreate(true)}
            variant="primary"
            size="sm"
          >
            <Plus className="h-4 w-4" />
            建立模板
          </Button>
        </div>
      </Surface>

      {/* 建立模板 Modal（關閉不清空輸入） */}
      <CreateTemplateModal
        isOpen={showTemplateCreate}
        onClose={() => setShowTemplateCreate(false)}
        periods={periods}
        selectedDepartment={selectedDepartment}
        selectedPeriodId={selectedPeriodId}
        templates={templates}
        onCreated={load}
      />

      {visibleTemplates.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <LayoutTemplate className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="mb-4 text-sm">此期別尚未建立模板</p>
          <Button variant="primary" size="sm" onClick={() => setShowTemplateCreate(true)}>
            <Plus className="h-4 w-4" />
            建立第一個模板
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleTemplates.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              periods={periods}
              editingId={editingId}
              editingName={editingName}
              onEditStart={startEdit}
              onEditSave={saveEdit}
              onEditCancel={cancelEdit}
              onEditNameChange={setEditingName}
              onDelete={handleDelete}
              onMovePeriod={handleMoveTemplate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
