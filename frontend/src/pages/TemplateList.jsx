import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { fetchAllTemplates, createTemplate, deleteTemplate, renameTemplate } from "../api/templateApi";
import { LayoutTemplate, Plus, Pencil, Trash2, BookOpen, Check, X } from "lucide-react";
import ConfirmModal from "../components/ConfirmModal";
import { useInlineEdit } from "../hooks/useInlineEdit";

export default function TemplateList() {
  const [templates, setTemplates] = useState([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmModal, setConfirmModal] = useState(null);

  const load = () => fetchAllTemplates().then(r => setTemplates(r.data));
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    await createTemplate(name.trim());
    setName("");
    toast.success("模板已建立");
    load();
    setCreating(false);
  };

  const { editingId, editingValue: editingName, setEditingValue: setEditingName,
    startEdit, cancelEdit, submitEdit: saveEdit } = useInlineEdit(
    useCallback(async (id, newName) => {
      await renameTemplate(id, newName);
      toast.success("已更新名稱");
      load();
    }, [])
  );

  const handleDelete = (id, e) => {
    e.preventDefault();
    setConfirmModal({
      message: "確定刪除此模板？",
      onConfirm: async () => {
        await deleteTemplate(id);
        toast.success("已刪除");
        load();
      },
    });
  };

  return (
    <div className="max-w-4xl mx-auto">
      <ConfirmModal
        isOpen={!!confirmModal}
        message={confirmModal?.message}
        onConfirm={() => { confirmModal?.onConfirm(); setConfirmModal(null); }}
        onCancel={() => setConfirmModal(null)}
      />
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
          <LayoutTemplate className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">模板管理</h1>
          <p className="text-sm text-gray-500">管中設計在此建立每月相本版型</p>
        </div>
      </div>

      {/* Create card */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-8 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">建立新模板</h2>
        <div className="flex gap-3">
          <input
            className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-gray-50"
            placeholder="模板名稱，例：感官世界 2026.01"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleCreate()}
          />
          <button
            onClick={handleCreate}
            disabled={creating || !name.trim()}
            className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            <Plus className="w-4 h-4" />
            建立
          </button>
        </div>
      </div>

      {/* Template grid */}
      {templates.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <LayoutTemplate className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">尚未建立任何模板</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(t => (
            <div key={t.id} className="group bg-white border border-gray-200 rounded-2xl p-5 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all">
              <div className="flex items-start justify-between mb-3">
                <div className="w-9 h-9 bg-indigo-50 rounded-xl flex items-center justify-center">
                  <BookOpen className="w-4 h-4 text-indigo-500" />
                </div>
                <button
                  onClick={e => handleDelete(t.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {editingId === t.id ? (
                <div className="flex items-center gap-1 mb-1">
                  <input
                    autoFocus
                    className="flex-1 border border-indigo-300 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    value={editingName}
                    onChange={e => setEditingName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveEdit(t.id); if (e.key === "Escape") cancelEdit(); }}
                  />
                  <button onClick={() => saveEdit(t.id)} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"><Check className="w-3.5 h-3.5" /></button>
                  <button onClick={cancelEdit} className="p-1 text-gray-400 hover:bg-gray-100 rounded"><X className="w-3.5 h-3.5" /></button>
                </div>
              ) : (
                <div className="flex items-center gap-1 mb-1 group/name">
                  <span className="font-semibold text-gray-900">{t.name}</span>
                  <button onClick={() => startEdit(t.id, t.name)} className="opacity-0 group-hover/name:opacity-100 p-0.5 text-gray-400 hover:text-indigo-600 rounded transition-opacity">
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              )}
              <div className="text-xs text-gray-400 mb-4">
                {t.page_count} 頁 · {new Date(t.created_at).toLocaleDateString("zh-TW")}
              </div>
              <Link
                to={`/templates/${t.id}/edit`}
                className="flex items-center justify-center gap-2 w-full bg-indigo-50 text-indigo-700 rounded-xl py-2 text-sm font-medium hover:bg-indigo-100 transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" />
                編輯模板
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
