import { memo, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { fetchAllProjects, createProject, deleteProject, renameProject } from "../api/projectApi";
import { fetchAllTemplates } from "../api/templateApi";
import { FolderOpen, Plus, Users, Eye, Pencil, Trash2, Check, X } from "lucide-react";
import { usePermissions } from "../hooks/usePermissions";
import { useAuth } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import { useInlineEdit } from "../hooks/useInlineEdit";

// ── 專案卡片（memo 化，只在自身資料變動時重渲染）────────────────────────────

const ProjectCard = memo(function ProjectCard({
  project,
  editingId,
  editingName,
  showOwner,
  canEditProject,
  onEditStart,
  onEditSave,
  onEditCancel,
  onEditNameChange,
  onDelete,
}) {
  const isEditing = editingId === project.id;

  return (
    <div className="group bg-white border border-gray-200 rounded-2xl shadow-sm hover:shadow-md hover:border-indigo-200 transition-all overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            {isEditing ? (
              <div className="flex items-center gap-1 mb-1">
                <input
                  autoFocus
                  className="border border-indigo-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 font-semibold"
                  value={editingName}
                  onChange={e => onEditNameChange(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") onEditSave(project.id);
                    if (e.key === "Escape") onEditCancel();
                  }}
                />
                <button onClick={() => onEditSave(project.id)} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={onEditCancel} className="p-1 text-gray-400 hover:bg-gray-100 rounded">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1 group/name">
                <div className="font-semibold text-gray-900 text-lg">{project.name}</div>
                {canEditProject(project.owner_id) && (
                  <button
                    onClick={() => onEditStart(project.id, project.name)}
                    className="opacity-0 group-hover/name:opacity-100 p-0.5 text-gray-400 hover:text-indigo-600 rounded transition-opacity"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-gray-400 mt-0.5">
              <Users className="w-3 h-3" />
              {project.student_count} 位學生 · {new Date(project.created_at).toLocaleDateString("zh-TW")}
              {showOwner && project.owner_name && (
                <>
                  <span className="text-gray-300">·</span>
                  <span>{project.owner_name}</span>
                </>
              )}
            </div>
          </div>
          {canEditProject(project.owner_id) && (
            <button
              onClick={() => onDelete(project.id)}
              className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <div className={`border-t border-gray-100 grid divide-x divide-gray-100 ${canEditProject(project.owner_id) ? "grid-cols-2" : "grid-cols-1"}`}>
        {canEditProject(project.owner_id) && (
          <Link
            to={`/projects/${project.id}/batch`}
            className="flex items-center justify-center gap-1.5 py-3 text-sm text-indigo-600 font-medium hover:bg-indigo-50 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
            專案設定
          </Link>
        )}
        <Link
          to={`/projects/${project.id}/review`}
          className="flex items-center justify-center gap-1.5 py-3 text-sm text-emerald-600 font-medium hover:bg-emerald-50 transition-colors"
        >
          <Eye className="w-3.5 h-3.5" />
          個人編輯
        </Link>
      </div>
    </div>
  );
});

// ── 專案清單頁面 ──────────────────────────────────────────────────────────────

export default function ProjectList() {
  const { canCreateProject, canEditProject } = usePermissions();
  const { currentUser } = useAuth();
  // teacher 只能看自己的專案，顯示建立者無意義；其餘角色顯示
  const showOwner = currentUser?.role !== "teacher";
  const [projects, setProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [form, setForm] = useState({ customName: "", template_id: "" });
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  useEffect(() => {
    fetchAllProjects().then(r => setProjects(r.data));
    fetchAllTemplates().then(r => setTemplates(r.data));
  }, []);

  const selectedTemplate = templates.find(t => String(t.id) === String(form.template_id));
  const composedName = selectedTemplate
    ? `${selectedTemplate.name}${form.customName.trim() ? " " + form.customName.trim() : ""}`
    : form.customName.trim();

  // ── 建立（樂觀更新：先顯示後 fetch 完整清單）
  const handleCreate = async () => {
    if (!form.template_id) return toast.error("請選擇模板");
    if (!composedName.trim()) return toast.error("請填寫名稱");
    setCreating(true);
    try {
      await createProject(composedName, form.template_id);
      toast.success("專案已建立");
      setForm({ customName: "", template_id: "" });
      setShowForm(false);
      // 建立後 fetch 完整清單以取得 id / student_count / owner_name
      const r = await fetchAllProjects();
      setProjects(r.data);
    } catch {
      toast.error("建立失敗");
    } finally {
      setCreating(false);
    }
  };

  // ── 重命名（樂觀更新）
  const { editingId, editingValue: editingName, setEditingValue: setEditingName,
    startEdit: handleEditStart, cancelEdit: handleEditCancel, submitEdit: handleEditSave } =
    useInlineEdit(useCallback(async (id, newName) => {
      // cancelEdit 在 submitEdit 中已先執行，此處直接樂觀更新
      setProjects(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p));
      try {
        await renameProject(id, newName);
        toast.success("已更新名稱");
      } catch {
        const r = await fetchAllProjects();
        setProjects(r.data);
        toast.error("更新失敗");
      }
    }, []));

  // ── 刪除（樂觀更新）
  const handleDelete = useCallback((id) => {
    setConfirmModal({
      message: "確定刪除此專案？所有學生資料將一併刪除。",
      onConfirm: async () => {
        const prev = projects;
        setProjects(p => p.filter(x => x.id !== id));
        try {
          await deleteProject(id);
          toast.success("已刪除");
        } catch {
          setProjects(prev);
          toast.error("刪除失敗");
        }
      },
    });
  }, [projects]);

  return (
    <div className="w-full">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
            <FolderOpen className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">相本專案</h1>
            <p className="text-sm text-gray-500">每個班級每個月一個專案</p>
          </div>
        </div>
        {canCreateProject && (
          <button
            onClick={() => setShowForm(v => !v)}
            className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            新建專案
          </button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-white border border-indigo-100 rounded-2xl p-6 mb-8 shadow-sm">
          <h2 className="font-semibold text-gray-800 mb-4">新建相本專案</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">選擇模板</label>
              <select
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
                value={form.template_id}
                onChange={e => setForm(f => ({ ...f, template_id: e.target.value }))}
              >
                <option value="">請選擇...</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">自訂名稱（加在模板名後）</label>
              <input
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
                placeholder="例：蘋果班 2026.01"
                value={form.customName}
                onChange={e => setForm(f => ({ ...f, customName: e.target.value }))}
              />
            </div>
          </div>
          {composedName && (
            <div className="text-xs text-gray-500 mb-4">
              專案全名：<span className="font-medium text-gray-800">{composedName}</span>
            </div>
          )}
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="bg-indigo-600 text-white px-5 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              {creating ? "建立中..." : "建立"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-gray-500 px-5 py-2 rounded-xl text-sm hover:bg-gray-100 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">尚無專案，請點右上角建立</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {projects.map(p => (
            <ProjectCard
              key={p.id}
              project={p}
              editingId={editingId}
              editingName={editingName}
              showOwner={showOwner}
              canEditProject={canEditProject}
              onEditStart={handleEditStart}
              onEditSave={handleEditSave}
              onEditCancel={handleEditCancel}
              onEditNameChange={setEditingName}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
