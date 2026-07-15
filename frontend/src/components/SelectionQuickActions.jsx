import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Group,
  Lock,
  LockOpen,
  Scissors,
  Trash2,
  Ungroup,
} from "lucide-react";

function ActionButton({
  label,
  disabled = false,
  onClick,
  children,
  danger = false,
  isTouchTarget = false,
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-35 ${
        isTouchTarget ? "h-11 min-w-11" : "h-8 min-w-8"
      } ${
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
  canCopy = false,
  canCut = false,
  canPaste = false,
  onToggleVisibility,
  onToggleLock,
  onDuplicate,
  onCopy,
  onCut,
  onPaste,
  onGroup,
  onUngroup,
  onDelete,
  presentation = "overlay",
  touchFriendly = false,
  className = "",
}) {
  const isContextRail = presentation === "context-rail";
  const useTouchTargets = isContextRail || touchFriendly;
  const hasSelection = selectedCount > 0;
  const canShowPasteOnlyRail = isContextRail && !hasSelection && canPaste && !!onPaste;
  if (!hasSelection && !canShowPasteOnlyRail) return null;

  const actionButtons = (
    <>
      {hasSelection && (
        <>
          <ActionButton
            label={isVisible ? "隱藏選取圖層" : "顯示選取圖層"}
            onClick={onToggleVisibility}
            isTouchTarget={useTouchTargets}
          >
            {isVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </ActionButton>
          <ActionButton
            label={isLocked ? "解除鎖定選取圖層" : "鎖定選取圖層"}
            onClick={onToggleLock}
            isTouchTarget={useTouchTargets}
          >
            {isLocked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
          </ActionButton>
          <span className="mx-0.5 h-5 w-px flex-shrink-0 bg-gray-200" aria-hidden="true" />
          {isContextRail && onCopy && (
            <ActionButton
              label="複製選取物件"
              disabled={!canCopy}
              onClick={onCopy}
              isTouchTarget
            >
              <Copy className="h-4 w-4" />
              <span>複製</span>
            </ActionButton>
          )}
          <ActionButton
            label={isContextRail ? "複製一份" : "複製選取物件"}
            disabled={!canDuplicate || !canEdit}
            onClick={onDuplicate}
            isTouchTarget={useTouchTargets}
          >
            {isContextRail ? <CopyPlus className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {isContextRail && <span>副本</span>}
          </ActionButton>
          {onCut && (
            <ActionButton label="剪下選取物件" disabled={!canCut || !canEdit} onClick={onCut} isTouchTarget={useTouchTargets}>
              <Scissors className="h-4 w-4" />
              {isContextRail && <span>剪下</span>}
            </ActionButton>
          )}
        </>
      )}
      {onPaste && (
        <ActionButton
          label="貼上物件"
          disabled={!canPaste || (!isContextRail && !canEdit)}
          onClick={onPaste}
          isTouchTarget={useTouchTargets}
        >
          <ClipboardPaste className="h-4 w-4" />
          {isContextRail && <span>貼上</span>}
        </ActionButton>
      )}
      {hasSelection && canGroup && (
        <ActionButton label="建立群組" disabled={!canEdit} onClick={onGroup} isTouchTarget={useTouchTargets}>
          <Group className="h-4 w-4" />
          {isContextRail && <span>群組</span>}
        </ActionButton>
      )}
      {hasSelection && canUngroup && (
        <ActionButton label="解除群組" disabled={!canEdit} onClick={onUngroup} isTouchTarget={useTouchTargets}>
          <Ungroup className="h-4 w-4" />
          {isContextRail && <span>解散</span>}
        </ActionButton>
      )}
      {hasSelection && (
        <ActionButton label="刪除選取物件" disabled={!canEdit} onClick={onDelete} danger isTouchTarget={useTouchTargets}>
          <Trash2 className="h-4 w-4" />
          {isContextRail && <span>刪除</span>}
        </ActionButton>
      )}
    </>
  );

  if (isContextRail) {
    return (
      <div
        className={`flex min-h-12 w-full min-w-0 items-center border-y border-gray-200 bg-white/95 shadow-sm backdrop-blur ${className}`}
        role="toolbar"
        aria-label={hasSelection ? `選取 ${selectedCount} 個物件的快捷操作` : "剪貼簿快捷操作"}
        onPointerDown={event => event.stopPropagation()}
        data-guide="selection-context-rail"
      >
        {hasSelection && (
          <span className="flex-shrink-0 border-r border-gray-200 px-3 text-xs font-semibold text-gray-600">
            已選 {selectedCount}
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain px-1.5">
          {actionButtons}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`absolute left-1/2 top-2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-0.5 rounded-lg border border-gray-200 bg-white/95 p-1 shadow-lg backdrop-blur ${className}`}
      role="toolbar"
      aria-label={`選取 ${selectedCount} 個物件的快捷操作`}
      onPointerDown={event => event.stopPropagation()}
    >
      {actionButtons}
    </div>
  );
}
