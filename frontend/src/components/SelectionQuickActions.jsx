import {
  Copy,
  Eye,
  EyeOff,
  Group,
  Lock,
  LockOpen,
  Trash2,
  Ungroup,
} from "lucide-react";

function ActionButton({ label, disabled = false, onClick, children, danger = false }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        danger
          ? "text-red-600 hover:bg-red-50"
          : "text-gray-600 hover:bg-gray-100 hover:text-indigo-700"
      }`}
    >
      {children}
    </button>
  );
}

export default function SelectionQuickActions({
  selectedCount,
  isVisible,
  isLocked,
  canEdit,
  canGroup,
  canUngroup,
  canDuplicate,
  onToggleVisibility,
  onToggleLock,
  onDuplicate,
  onGroup,
  onUngroup,
  onDelete,
}) {
  if (!selectedCount) return null;

  return (
    <div
      className="absolute left-1/2 top-2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-0.5 rounded-lg border border-gray-200 bg-white/95 p-1 shadow-lg backdrop-blur"
      role="toolbar"
      aria-label={`選取 ${selectedCount} 個物件的快捷操作`}
      onPointerDown={event => event.stopPropagation()}
    >
      <ActionButton
        label={isVisible ? "隱藏選取圖層" : "顯示選取圖層"}
        onClick={onToggleVisibility}
      >
        {isVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </ActionButton>
      <ActionButton
        label={isLocked ? "解除鎖定選取圖層" : "鎖定選取圖層"}
        onClick={onToggleLock}
      >
        {isLocked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
      </ActionButton>
      <span className="mx-0.5 h-5 w-px bg-gray-200" aria-hidden="true" />
      <ActionButton label="複製選取物件" disabled={!canDuplicate || !canEdit} onClick={onDuplicate}>
        <Copy className="h-4 w-4" />
      </ActionButton>
      {canGroup && (
        <ActionButton label="建立群組" disabled={!canEdit} onClick={onGroup}>
          <Group className="h-4 w-4" />
        </ActionButton>
      )}
      {canUngroup && (
        <ActionButton label="解除群組" disabled={!canEdit} onClick={onUngroup}>
          <Ungroup className="h-4 w-4" />
        </ActionButton>
      )}
      <ActionButton label="刪除選取物件" disabled={!canEdit} onClick={onDelete} danger>
        <Trash2 className="h-4 w-4" />
      </ActionButton>
    </div>
  );
}
