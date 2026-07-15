// PhotoManager 儲存模型：只描述 desired、server shadow 與 mapping 差異，
// 不依賴 React / axios，讓延遲上傳與衝突流程可以用 Node 單元測試釘住。

export const DEFAULT_PHOTO_TRANSFORM = Object.freeze({
  scale: 1.0,
  offsetX: 0,
  offsetY: 0,
  brightness: 1.0,
  contrast: 1.0,
});

export function normalizePhotoTransform(transform = DEFAULT_PHOTO_TRANSFORM) {
  const source = transform ?? DEFAULT_PHOTO_TRANSFORM;
  return {
    scale: source.scale ?? 1.0,
    offsetX: source.offsetX ?? 0,
    offsetY: source.offsetY ?? 0,
    brightness: source.brightness ?? 1.0,
    contrast: source.contrast ?? 1.0,
  };
}

export function isPhotoTransformDirty(transform, originalTransform) {
  const current = normalizePhotoTransform(transform);
  const original = normalizePhotoTransform(originalTransform);
  return (
    Math.abs(current.scale - original.scale) > 0.001 ||
    Math.abs(current.offsetX - original.offsetX) > 0.001 ||
    Math.abs(current.offsetY - original.offsetY) > 0.001 ||
    Math.abs(current.brightness - original.brightness) > 0.001 ||
    Math.abs(current.contrast - original.contrast) > 0.001
  );
}

export function photoSlotKey(item) {
  return `${item.templatePageId ?? `page-index:${item.pi}`}:${String(item.slotId)}`;
}

function cloneDesiredBinding(binding) {
  if (!binding) return null;
  if (binding.kind === "pending") {
    return {
      kind: "pending",
      pendingUploadId: binding.pendingUploadId,
      file: binding.file,
      transform: normalizePhotoTransform(binding.transform),
    };
  }
  return {
    kind: "server",
    path: binding.path,
    transform: normalizePhotoTransform(binding.transform),
  };
}

function cloneDesiredSlot(slot) {
  return {
    slotKey: slot.slotKey,
    pageIndex: slot.pageIndex,
    slotId: slot.slotId,
    binding: cloneDesiredBinding(slot.binding),
  };
}

function cloneShadowBinding(binding) {
  if (!binding) return null;
  return {
    bindingId: binding.bindingId,
    pendingUploadId: binding.pendingUploadId ?? null,
    path: binding.path,
    transform: normalizePhotoTransform(binding.transform),
  };
}

export function createPhotoDesiredSnapshot(items) {
  const slots = new Map();
  for (const item of items) {
    let binding = null;
    if (item.pendingFile) {
      binding = {
        kind: "pending",
        pendingUploadId: item.pendingUploadId,
        file: item.pendingFile,
        transform: normalizePhotoTransform(item.transform),
      };
    } else if (item.serverPath) {
      binding = {
        kind: "server",
        path: item.serverPath,
        transform: normalizePhotoTransform(item.transform),
      };
    }
    const slot = {
      slotKey: photoSlotKey(item),
      pageIndex: item.pi,
      slotId: item.slotId,
      binding,
    };
    slots.set(slot.slotKey, slot);
  }
  return { slots };
}

export function clonePhotoDesiredSnapshot(snapshot) {
  return {
    slots: new Map(
      [...snapshot.slots].map(([slotKey, slot]) => [slotKey, cloneDesiredSlot(slot)]),
    ),
  };
}

export function createPhotoServerShadow(items) {
  const slots = new Map();
  for (const item of items) {
    const path = item.origServerPath ?? null;
    slots.set(photoSlotKey(item), path ? {
      bindingId: `server:${path}`,
      pendingUploadId: null,
      path,
      transform: normalizePhotoTransform(item.origTransform),
    } : null);
  }
  return { slots };
}

export function clonePhotoServerShadow(shadow) {
  return {
    slots: new Map(
      [...shadow.slots].map(([slotKey, binding]) => [slotKey, cloneShadowBinding(binding)]),
    ),
  };
}

export function rebasePhotoDesiredSnapshot(previousSnapshot, serverSnapshot) {
  const slots = new Map();
  for (const [slotKey, serverSlot] of serverSnapshot.slots) {
    const previousSlot = previousSnapshot.slots.get(slotKey);
    slots.set(slotKey, {
      slotKey,
      pageIndex: serverSlot.pageIndex,
      slotId: serverSlot.slotId,
      binding: cloneDesiredBinding(previousSlot ? previousSlot.binding : serverSlot.binding),
    });
  }
  return { slots };
}

export function buildPendingUploadTasks(snapshot, resolvedUploads) {
  const tasks = [];
  const seenTokens = new Set();
  for (const slot of snapshot.slots.values()) {
    const binding = slot.binding;
    if (binding?.kind !== "pending") continue;
    if (resolvedUploads.has(binding.pendingUploadId) || seenTokens.has(binding.pendingUploadId)) continue;
    seenTokens.add(binding.pendingUploadId);
    tasks.push({
      pendingUploadId: binding.pendingUploadId,
      file: binding.file,
      pageIndex: slot.pageIndex,
      slotId: slot.slotId,
      slotKey: slot.slotKey,
    });
  }
  return tasks;
}

export function applyPhotoUploadToShadow(shadow, task, path) {
  const nextShadow = clonePhotoServerShadow(shadow);
  nextShadow.slots.set(task.slotKey, {
    bindingId: `pending:${task.pendingUploadId}`,
    pendingUploadId: task.pendingUploadId,
    path,
    // 單張上傳端點會把裁切參數重設為預設值；desired transform 由後續 mapping 補齊。
    transform: normalizePhotoTransform(DEFAULT_PHOTO_TRANSFORM),
  });
  return nextShadow;
}

function resolveDesiredBinding(binding, resolvedUploads) {
  if (!binding) return { isResolved: true, binding: null };
  if (binding.kind === "server") {
    return {
      isResolved: true,
      binding: {
        bindingId: `server:${binding.path}`,
        pendingUploadId: null,
        path: binding.path,
        transform: normalizePhotoTransform(binding.transform),
      },
    };
  }
  const path = resolvedUploads.get(binding.pendingUploadId);
  if (!path) return { isResolved: false, binding: null };
  return {
    isResolved: true,
    binding: {
      bindingId: `pending:${binding.pendingUploadId}`,
      pendingUploadId: binding.pendingUploadId,
      path,
      transform: normalizePhotoTransform(binding.transform),
    },
  };
}

function shadowBindingMatches(currentBinding, desiredBinding) {
  if (!currentBinding || !desiredBinding) return currentBinding === desiredBinding;
  return currentBinding.path === desiredBinding.path
    && !isPhotoTransformDirty(currentBinding.transform, desiredBinding.transform);
}

function mappingValue(binding) {
  if (!binding) return null;
  return {
    path: binding.path,
    scale: binding.transform.scale,
    offset_x: binding.transform.offsetX,
    offset_y: binding.transform.offsetY,
    brightness: binding.transform.brightness,
    contrast: binding.transform.contrast,
  };
}

export function buildPhotoMappingPlan(desiredSnapshot, shadow, resolvedUploads) {
  const pages = {};
  const resolvedBySlot = new Map();
  let hasUnresolvedPending = false;

  for (const [slotKey, desiredSlot] of desiredSnapshot.slots) {
    const resolved = resolveDesiredBinding(desiredSlot.binding, resolvedUploads);
    if (!resolved.isResolved) {
      hasUnresolvedPending = true;
      continue;
    }
    resolvedBySlot.set(slotKey, cloneShadowBinding(resolved.binding));
    const currentBinding = shadow.slots.get(slotKey) ?? null;
    if (shadowBindingMatches(currentBinding, resolved.binding)) continue;
    const pageKey = String(desiredSlot.pageIndex);
    if (!pages[pageKey]) pages[pageKey] = {};
    pages[pageKey][String(desiredSlot.slotId)] = mappingValue(resolved.binding);
  }

  return { pages, resolvedBySlot, hasUnresolvedPending };
}

export function applyPhotoMappingPlanToShadow(shadow, plan) {
  const nextShadow = clonePhotoServerShadow(shadow);
  for (const [slotKey, binding] of plan.resolvedBySlot) {
    nextShadow.slots.set(slotKey, cloneShadowBinding(binding));
  }
  return nextShadow;
}

export function hasPhotoMappingChanges(plan) {
  return Object.keys(plan.pages).length > 0;
}

export function isPhotoSnapshotDirty(desiredSnapshot, shadow, resolvedUploads) {
  const plan = buildPhotoMappingPlan(desiredSnapshot, shadow, resolvedUploads);
  return plan.hasUnresolvedPending || hasPhotoMappingChanges(plan);
}

export function replaceFailedPendingWithShadow(desiredSnapshot, shadow, failedUploadIds) {
  const nextSnapshot = clonePhotoDesiredSnapshot(desiredSnapshot);
  const pathsDesiredElsewhere = new Set(
    [...nextSnapshot.slots.values()]
      .map(slot => slot.binding)
      .filter(binding => binding?.kind === "server")
      .map(binding => binding.path),
  );
  for (const slot of nextSnapshot.slots.values()) {
    const binding = slot.binding;
    if (binding?.kind !== "pending" || !failedUploadIds.has(binding.pendingUploadId)) continue;
    const shadowBinding = shadow.slots.get(slot.slotKey) ?? null;
    slot.binding = shadowBinding && !pathsDesiredElsewhere.has(shadowBinding.path) ? {
      kind: "server",
      path: shadowBinding.path,
      transform: normalizePhotoTransform(shadowBinding.transform),
    } : null;
  }
  return nextSnapshot;
}
