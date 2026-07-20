// PhotoManager 的 React adapter：把 items / toast / callback 接到 framework-neutral coordinator。

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { updatePhotoMapping, uploadPhoto } from "../api/projectApi";
import { maybeCompressImageFile } from "../utils/imageCompression";
import { getApiErrorMessage, isProjectTemplateRevisionError } from "../utils/apiError";
import {
  DEFAULT_PHOTO_TRANSFORM,
  changedPageIndexesBetweenShadows,
  clonePhotoServerShadow,
  createPhotoDesiredSnapshot,
  createPhotoServerShadow,
  isPhotoTransformDirty,
  normalizePhotoTransform,
  photoSlotKey,
} from "../utils/photoSaveModel";
import { createPhotoSaveCoordinator, photoSaveSessionKey } from "../utils/photoSaveCoordinator";
import { isRetryableUploadError, retryDelayMs } from "../utils/uploadRetry";

const PHOTO_UPLOAD_MAX_ATTEMPTS = 3;

async function retryPhotoUpload(operation) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableUploadError(error) || attempt >= PHOTO_UPLOAD_MAX_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(error)));
    }
  }
}

const photoSaveCoordinator = createPhotoSaveCoordinator({
  prepareFile: maybeCompressImageFile,
  retryUpload: retryPhotoUpload,
  isRevisionConflict: isProjectTemplateRevisionError,
  uploadPhoto: async ({
    projectId,
    revision,
    studentId,
    pageIndex,
    slotId,
    file,
    onProgress,
  }) => {
    const response = await uploadPhoto(
      projectId,
      revision,
      studentId,
      pageIndex,
      slotId,
      file,
      onProgress,
    );
    return response.data;
  },
  updatePhotoMapping: async ({ projectId, revision, studentId, pages }) => {
    const response = await updatePhotoMapping(projectId, revision, studentId, pages);
    return response.data;
  },
});

function getPhotoSaveFailureMessage(error, count = 1) {
  const detailMessage = getApiErrorMessage(error, "");
  if (error?.response?.status === 413) {
    return count > 1
      ? `${count} 張照片超過大小上限，請壓縮後再上傳`
      : (detailMessage || "照片超過大小上限，請壓縮後再上傳");
  }
  if (detailMessage) return count > 1 ? `${count} 張照片上傳失敗：${detailMessage}` : detailMessage;
  return count > 1 ? `${count} 張照片上傳失敗` : "照片上傳失敗";
}

function shadowLocationByPath(items, shadow) {
  const itemBySlot = new Map(items.map(item => [photoSlotKey(item), item]));
  const locations = new Map();
  for (const [slotKey, binding] of shadow.slots) {
    if (!binding?.path) continue;
    const item = itemBySlot.get(slotKey);
    if (item) locations.set(binding.path, { pi: item.pi, slotId: item.slotId });
  }
  return locations;
}

function baselineFields(item, shadowBinding, pathLocations) {
  const desiredLocation = item.serverPath ? pathLocations.get(item.serverPath) : null;
  return {
    origServerPath: shadowBinding?.path ?? null,
    origTransform: normalizePhotoTransform(shadowBinding?.transform),
    origPi: desiredLocation?.pi ?? null,
    origSlotId: desiredLocation?.slotId ?? null,
  };
}

function applyCoordinatorStateToItems(items, state, { applySave, applyFailure }) {
  const pathLocations = shadowLocationByPath(items, state.shadow);
  return items.map(item => {
    const slotKey = photoSlotKey(item);
    const shadowBinding = state.shadow.slots.get(slotKey) ?? null;

    if (applyFailure && item.pendingUploadId && state.failedUploadIds.has(item.pendingUploadId)) {
      const desiredBinding = state.desiredSnapshot.slots.get(slotKey)?.binding ?? null;
      const restoredPath = desiredBinding?.kind === "server" ? desiredBinding.path : null;
      const restoredTransform = desiredBinding?.kind === "server"
        ? desiredBinding.transform
        : DEFAULT_PHOTO_TRANSFORM;
      const restoredLocation = restoredPath ? pathLocations.get(restoredPath) : null;
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return {
        ...item,
        pendingUploadId: null,
        pendingFile: null,
        previewUrl: null,
        serverPath: restoredPath,
        transform: normalizePhotoTransform(restoredTransform),
        origServerPath: shadowBinding?.path ?? null,
        origTransform: normalizePhotoTransform(shadowBinding?.transform),
        origPi: restoredLocation?.pi ?? null,
        origSlotId: restoredLocation?.slotId ?? null,
      };
    }

    if (!applySave) return item;
    if (item.pendingUploadId && state.committedUploadIds.has(item.pendingUploadId)) {
      const path = state.resolvedUploads.get(item.pendingUploadId);
      if (!path) return item;
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      const committedTransform = state.desiredSnapshot.slots.get(slotKey)?.binding?.transform;
      return {
        ...item,
        pendingUploadId: null,
        pendingFile: null,
        previewUrl: null,
        serverPath: path,
        origServerPath: shadowBinding?.path ?? path,
        origTransform: normalizePhotoTransform(shadowBinding?.transform ?? committedTransform),
        origPi: item.pi,
        origSlotId: item.slotId,
      };
    }
    if (item.pendingUploadId) return item;
    return { ...item, ...baselineFields(item, shadowBinding, pathLocations) };
  });
}

function materializeDesiredItems(serverItems, previousItems, state) {
  const previousPendingByToken = new Map(
    previousItems
      .filter(item => item.pendingUploadId)
      .map(item => [item.pendingUploadId, item]),
  );
  const pathLocations = shadowLocationByPath(serverItems, state.shadow);
  const retainedPreviewUrls = new Set();

  const nextItems = serverItems.map(serverItem => {
    const slotKey = photoSlotKey(serverItem);
    const desiredBinding = state.desiredSnapshot.slots.get(slotKey)?.binding ?? null;
    const shadowBinding = state.shadow.slots.get(slotKey) ?? null;
    const baseline = {
      origServerPath: shadowBinding?.path ?? null,
      origTransform: normalizePhotoTransform(shadowBinding?.transform),
    };

    if (desiredBinding?.kind === "pending") {
      const resolvedPath = state.resolvedUploads.get(desiredBinding.pendingUploadId);
      if (resolvedPath && state.committedUploadIds.has(desiredBinding.pendingUploadId)) {
        const location = pathLocations.get(resolvedPath);
        return {
          ...serverItem,
          ...baseline,
          pendingUploadId: null,
          pendingFile: null,
          previewUrl: null,
          serverPath: resolvedPath,
          transform: normalizePhotoTransform(desiredBinding.transform),
          origPi: location?.pi ?? null,
          origSlotId: location?.slotId ?? null,
        };
      }
      const previousPending = previousPendingByToken.get(desiredBinding.pendingUploadId);
      const previewUrl = previousPending?.previewUrl ?? URL.createObjectURL(desiredBinding.file);
      retainedPreviewUrls.add(previewUrl);
      return {
        ...serverItem,
        ...baseline,
        pendingUploadId: desiredBinding.pendingUploadId,
        pendingFile: desiredBinding.file,
        previewUrl,
        serverPath: null,
        transform: normalizePhotoTransform(desiredBinding.transform),
        origPi: null,
        origSlotId: null,
      };
    }

    if (desiredBinding?.kind === "server") {
      const location = pathLocations.get(desiredBinding.path);
      return {
        ...serverItem,
        ...baseline,
        pendingUploadId: null,
        pendingFile: null,
        previewUrl: null,
        serverPath: desiredBinding.path,
        transform: normalizePhotoTransform(desiredBinding.transform),
        origPi: location?.pi ?? null,
        origSlotId: location?.slotId ?? null,
      };
    }

    return {
      ...serverItem,
      ...baseline,
      pendingUploadId: null,
      pendingFile: null,
      previewUrl: null,
      serverPath: null,
      transform: { ...DEFAULT_PHOTO_TRANSFORM },
      origPi: null,
      origSlotId: null,
    };
  });

  previousItems.forEach(item => {
    if (item.previewUrl && !retainedPreviewUrls.has(item.previewUrl)) URL.revokeObjectURL(item.previewUrl);
  });
  return nextItems;
}

function isPhotoItemDirty(item) {
  return item.pendingFile !== null
    || item.serverPath !== item.origServerPath
    || isPhotoTransformDirty(item.transform, item.origTransform);
}

export default function usePhotoAutoSave({
  projectId,
  templateRevision,
  studentId,
  serverItems,
  onPhotoSaved,
  onTemplateRevisionChanged,
}) {
  const sessionKey = photoSaveSessionKey(projectId, studentId);
  const [items, setItems] = useState(() => serverItems);
  const [coordinatorState, setCoordinatorState] = useState({
    phase: "idle",
    progress: null,
    isBusy: false,
    hasUnsaved: false,
  });
  const [photoRefreshKey, setPhotoRefreshKey] = useState(0);
  const [hasSavedPhotos, setHasSavedPhotos] = useState(false);
  const itemsRef = useRef(items);
  const serverItemsRef = useRef(serverItems);
  const onPhotoSavedRef = useRef(onPhotoSaved);
  const onTemplateRevisionChangedRef = useRef(onTemplateRevisionChanged);
  const subscriptionGenerationRef = useRef(0);
  const previousRevisionRef = useRef(templateRevision);
  const templateRevisionRef = useRef(templateRevision);
  const skipDesiredUpdateRef = useRef(false);
  const conflictSequenceRef = useRef(0);
  const saveSequenceRef = useRef(0);
  const failureSequenceRef = useRef(0);
  const errorRef = useRef(null);
  const instanceId = useId();
  const pendingSequenceRef = useRef(0);
  // 上一次「已通知存檔」時的 server shadow：diff 出本次存檔實際變動的頁面
  const lastSavedShadowRef = useRef(null);

  useEffect(() => { itemsRef.current = items; }, [items]);
  useEffect(() => { serverItemsRef.current = serverItems; }, [serverItems]);
  useEffect(() => { templateRevisionRef.current = templateRevision; }, [templateRevision]);
  useEffect(() => { onPhotoSavedRef.current = onPhotoSaved; }, [onPhotoSaved]);
  useEffect(() => {
    onTemplateRevisionChangedRef.current = onTemplateRevisionChanged;
  }, [onTemplateRevisionChanged]);

  useEffect(() => {
    const currentRevision = templateRevisionRef.current;
    const currentServerItems = serverItemsRef.current;
    const serverDesiredSnapshot = createPhotoDesiredSnapshot(currentServerItems);
    photoSaveCoordinator.initialize({
      sessionKey,
      projectId,
      studentId,
      revision: currentRevision,
      desiredSnapshot: serverDesiredSnapshot,
      shadow: createPhotoServerShadow(currentServerItems),
    });
    previousRevisionRef.current = currentRevision;
    skipDesiredUpdateRef.current = true;
    conflictSequenceRef.current = 0;
    saveSequenceRef.current = 0;
    failureSequenceRef.current = 0;
    errorRef.current = null;
    lastSavedShadowRef.current = createPhotoServerShadow(currentServerItems);
    setHasSavedPhotos(false);
    setPhotoRefreshKey(0);
    const generation = subscriptionGenerationRef.current + 1;
    subscriptionGenerationRef.current = generation;
    const listener = state => {
      if (subscriptionGenerationRef.current !== generation) return;
      setCoordinatorState(state);

      const hasNewFailure = state.failureSequence > failureSequenceRef.current;
      const hasNewSave = state.saveSequence > saveSequenceRef.current;
      if (hasNewFailure || hasNewSave) {
        setItems(previousItems => applyCoordinatorStateToItems(previousItems, state, {
          applyFailure: hasNewFailure,
          applySave: hasNewSave,
        }));
      }
      if (hasNewFailure) {
        failureSequenceRef.current = state.failureSequence;
        toast.error(getPhotoSaveFailureMessage(state.lastError, state.failedUploadIds.size));
      }
      if (hasNewSave) {
        saveSequenceRef.current = state.saveSequence;
        setPhotoRefreshKey(Date.now());
        setHasSavedPhotos(true);
        // 只回報本次存檔實際變動的頁面；對不回頁面時回 null（呼叫端全頁刷新）
        const previousSavedShadow = lastSavedShadowRef.current;
        lastSavedShadowRef.current = clonePhotoServerShadow(state.shadow);
        const changedPages = previousSavedShadow
          ? changedPageIndexesBetweenShadows(previousSavedShadow, state.shadow, state.desiredSnapshot)
          : null;
        onPhotoSavedRef.current?.(changedPages);
      }
      if (state.conflictSequence > conflictSequenceRef.current) {
        conflictSequenceRef.current = state.conflictSequence;
        // 不同 revision 的 reattach 會在訂閱前直接 resume；舊 conflict sequence
        // 仍保留供除錯，但只有仍處於 conflict 才需要再觸發 recovery。
        if (state.phase === "conflict") {
          toast.error(getPhotoSaveFailureMessage(state.lastError));
          void onTemplateRevisionChangedRef.current?.();
        }
      } else if (state.phase === "error" && state.lastError && state.lastError !== errorRef.current) {
        errorRef.current = state.lastError;
        toast.error(getPhotoSaveFailureMessage(state.lastError));
      }
    };
    const unsubscribe = photoSaveCoordinator.attach(sessionKey, {
      revision: currentRevision,
      serverDesiredSnapshot,
      shadow: createPhotoServerShadow(currentServerItems),
    }, listener);
    const currentState = photoSaveCoordinator.getState(sessionKey);
    if (currentState) {
      setItems(previousItems => materializeDesiredItems(
        serverItemsRef.current,
        previousItems,
        currentState,
      ));
    }

    return () => {
      subscriptionGenerationRef.current += 1;
      unsubscribe();
      // items effect 尚未跑到也不能丟失最後一次操作；detach 會把尚在 debounce 的工作立即交給 coordinator。
      photoSaveCoordinator.updateDesired(sessionKey, createPhotoDesiredSnapshot(itemsRef.current));
      photoSaveCoordinator.detach(sessionKey);
      itemsRef.current.forEach(item => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, [projectId, sessionKey, studentId]);

  useEffect(() => {
    if (previousRevisionRef.current === templateRevision) return;
    skipDesiredUpdateRef.current = true;
    const serverDesiredSnapshot = createPhotoDesiredSnapshot(serverItems);
    photoSaveCoordinator.resumeRevision(sessionKey, {
      revision: templateRevision,
      serverDesiredSnapshot,
      shadow: createPhotoServerShadow(serverItems),
    });
    // revision 換版後 server 狀態已重取，變動頁 diff 從新基準重新算起
    lastSavedShadowRef.current = createPhotoServerShadow(serverItems);
    const state = photoSaveCoordinator.getState(sessionKey);
    setItems(previousItems => materializeDesiredItems(serverItems, previousItems, state));
    previousRevisionRef.current = templateRevision;
  }, [serverItems, sessionKey, templateRevision]);

  useEffect(() => {
    if (skipDesiredUpdateRef.current) {
      skipDesiredUpdateRef.current = false;
      return;
    }
    photoSaveCoordinator.updateDesired(sessionKey, createPhotoDesiredSnapshot(items));
  }, [items, sessionKey]);

  const createPendingUploadId = useCallback(() => {
    pendingSequenceRef.current += 1;
    return `${sessionKey}:${instanceId}:${pendingSequenceRef.current}`;
  }, [instanceId, sessionKey]);

  const hasLocalUnsaved = useMemo(() => items.some(isPhotoItemDirty), [items]);
  const hasUnsaved = hasLocalUnsaved || coordinatorState.hasUnsaved;
  const isBusy = coordinatorState.phase === "conflict"
    ? false
    : (hasUnsaved || coordinatorState.isBusy);
  const hasUploadProgress = coordinatorState.progress !== null;
  const uploadStatus = hasUploadProgress ? {
    phase: coordinatorState.phase,
    ...coordinatorState.progress,
  } : null;

  return {
    items,
    setItems,
    itemsRef,
    createPendingUploadId,
    uploadStatus,
    photoRefreshKey,
    hasSavedPhotos,
    hasUnsaved,
    isBusy,
  };
}
