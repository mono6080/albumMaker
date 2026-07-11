// 通用行內編輯 hook
// 管理「雙擊進入編輯、Enter 儲存、Escape 取消」的 id + value 狀態，
// 供 TemplateList、ProjectList、RosterModal 等共用

import { useState, useCallback } from "react";

/**
 * @param {(id: number, newValue: string) => Promise<void>} onSave
 *   儲存回呼；id 為正在編輯的項目 id，newValue 為已 trim 的新值。
 *   cancelEdit 會在呼叫 onSave 之前執行，讓 UI 立即脫離編輯狀態。
 */
export function useInlineEdit(onSave) {
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState("");

  const startEdit = useCallback((id, currentValue) => {
    setEditingId(id);
    setEditingValue(currentValue);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingValue("");
  }, []);

  const submitEdit = useCallback(async (id) => {
    const trimmed = editingValue.trim();
    if (!trimmed) { cancelEdit(); return; }
    cancelEdit();
    await onSave(id, trimmed);
  }, [editingValue, cancelEdit, onSave]);

  return { editingId, editingValue, setEditingValue, startEdit, cancelEdit, submitEdit };
}
