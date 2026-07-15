// PhotoManager 的 framework-neutral 儲存協調器。
// 同一學生只允許一個 active run；React 只負責訂閱狀態，不持有 request 生命週期。

import { runWithConcurrency } from "./concurrency.js";
import {
  applyPhotoMappingPlanToShadow,
  applyPhotoUploadToShadow,
  buildPendingUploadTasks,
  buildPhotoMappingPlan,
  clonePhotoDesiredSnapshot,
  clonePhotoServerShadow,
  hasPhotoMappingChanges,
  isPhotoSnapshotDirty,
  rebasePhotoDesiredSnapshot,
  replaceFailedPendingWithShadow,
} from "./photoSaveModel.js";

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_UPLOAD_PARALLEL_LIMIT = 2;

export function photoSaveSessionKey(projectId, studentId) {
  return `${projectId}:${studentId}`;
}

function conflictPauseKey(session, revision) {
  return `${session.projectId}:${session.studentId}:${revision}`;
}

function hasActivePhase(phase) {
  return phase === "debouncing" || phase === "uploading" || phase === "processing" || phase === "saving";
}

export function createPhotoSaveCoordinator({
  uploadPhoto,
  updatePhotoMapping,
  prepareFile = async file => file,
  retryUpload = async operation => operation(),
  isRevisionConflict = () => false,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = handle => clearTimeout(handle),
  debounceMs = DEFAULT_DEBOUNCE_MS,
  uploadParallelLimit = DEFAULT_UPLOAD_PARALLEL_LIMIT,
} = {}) {
  const sessions = new Map();

  const publicState = session => ({
    sessionKey: session.sessionKey,
    phase: session.phase,
    progress: session.progress ? { ...session.progress } : null,
    isBusy: hasActivePhase(session.phase),
    hasUnsaved: isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads),
    pause: session.pause ? { ...session.pause } : null,
    conflictSequence: session.conflictSequence,
    saveSequence: session.saveSequence,
    failureSequence: session.failureSequence,
    committedUploadIds: new Set(session.committedUploadIds),
    failedUploadIds: new Set(session.failedUploadIds),
    lastError: session.lastError,
    desiredSnapshot: clonePhotoDesiredSnapshot(session.desiredSnapshot),
    shadow: clonePhotoServerShadow(session.shadow),
    resolvedUploads: new Map(session.resolvedUploads),
  });

  const emit = session => {
    if (session.listeners.size === 0) return;
    const state = publicState(session);
    for (const listener of session.listeners) listener(state);
  };

  const clearDebounce = session => {
    if (session.debounceHandle === null) return;
    cancelSchedule(session.debounceHandle);
    session.debounceHandle = null;
  };

  const maybeEvict = session => {
    if (
      session.listeners.size === 0
      && session.activeRun === null
      && session.debounceHandle === null
      && !session.pause
      && !isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads)
    ) {
      sessions.delete(session.sessionKey);
    }
  };

  const pauseForConflict = (session, revision, error) => {
    clearDebounce(session);
    session.queuedReady = false;
    session.pause = {
      key: conflictPauseKey(session, revision),
      revision,
      error,
    };
    session.phase = "conflict";
    session.progress = null;
    session.lastError = error;
    session.conflictSequence += 1;
    emit(session);
  };

  const markMappingError = (session, error, errorVersion) => {
    clearDebounce(session);
    session.queuedReady = false;
    session.phase = "error";
    session.progress = null;
    session.lastError = error;
    session.errorVersion = errorVersion;
    emit(session);
  };

  let startRun;

  const scheduleRun = (session, delay = debounceMs) => {
    if (session.pause) return;
    clearDebounce(session);
    session.queuedReady = false;
    if (session.activeRun === null) {
      session.phase = "debouncing";
      session.progress = null;
    }
    session.debounceHandle = schedule(() => {
      session.debounceHandle = null;
      session.queuedReady = true;
      if (session.activeRun === null) startRun(session);
      else emit(session);
    }, delay);
    emit(session);
  };

  const finishRun = session => {
    if (session.pause) return;
    const hasUnsaved = isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads);
    if (!hasUnsaved) {
      clearDebounce(session);
      session.queuedReady = false;
      session.phase = "idle";
      session.progress = null;
      session.lastError = null;
      session.errorVersion = null;
      emit(session);
      maybeEvict(session);
      return;
    }
    if (session.errorVersion !== null && session.desiredVersion <= session.errorVersion) {
      session.phase = "error";
      session.progress = null;
      emit(session);
      return;
    }
    if (session.queuedReady) {
      startRun(session);
      return;
    }
    if (session.debounceHandle !== null) {
      session.phase = "debouncing";
      session.progress = null;
      emit(session);
      return;
    }
    scheduleRun(session);
  };

  const performRun = async session => {
    const revision = session.revision;
    const runSnapshot = clonePhotoDesiredSnapshot(session.desiredSnapshot);
    const uploadTasks = buildPendingUploadTasks(runSnapshot, session.resolvedUploads);
    const successfulUploadIds = new Set();
    const permanentFailures = new Map();
    const conflictFailures = [];
    let didPersist = false;

    if (uploadTasks.length > 0) {
      const progressByToken = new Map(uploadTasks.map(task => [task.pendingUploadId, 0]));
      let completedUploads = 0;
      const updateProgress = phase => {
        const totalProgress = [...progressByToken.values()].reduce((sum, percent) => sum + percent, 0);
        session.phase = phase;
        session.progress = {
          percent: Math.round(totalProgress / uploadTasks.length),
          completed: completedUploads,
          total: uploadTasks.length,
        };
        emit(session);
      };

      updateProgress("uploading");
      await runWithConcurrency(uploadTasks, uploadParallelLimit, async task => {
        try {
          const preparedFile = await prepareFile(task.file);
          const response = await retryUpload(() => uploadPhoto({
            projectId: session.projectId,
            studentId: session.studentId,
            revision,
            pendingUploadId: task.pendingUploadId,
            pageIndex: task.pageIndex,
            slotId: task.slotId,
            slotKey: task.slotKey,
            file: preparedFile,
            onProgress: percent => {
              progressByToken.set(task.pendingUploadId, percent);
              updateProgress(percent >= 100 ? "processing" : "uploading");
            },
          }));
          const path = typeof response === "string" ? response : response.path;
          // POST 已經改寫 snapshot 格位；即使 UI desired 已移動/刪除/替換，也必須先記錄這筆事實。
          session.shadow = applyPhotoUploadToShadow(session.shadow, task, path);
          session.resolvedUploads.set(task.pendingUploadId, path);
          successfulUploadIds.add(task.pendingUploadId);
          didPersist = true;
          progressByToken.set(task.pendingUploadId, 100);
          emit(session);
        } catch (error) {
          progressByToken.set(task.pendingUploadId, 100);
          if (isRevisionConflict(error)) conflictFailures.push(error);
          else permanentFailures.set(task.pendingUploadId, error);
        } finally {
          completedUploads += 1;
          updateProgress(completedUploads === uploadTasks.length ? "saving" : session.phase);
        }
      });
    } else {
      session.phase = "saving";
      session.progress = null;
      emit(session);
    }

    // 已開始的 sibling upload 全部完成後才暫停；成功者的 shadow 已保留下來。
    if (conflictFailures.length > 0) {
      pauseForConflict(session, revision, conflictFailures[0]);
      return;
    }

    if (permanentFailures.size > 0) {
      const failedUploadIds = new Set(permanentFailures.keys());
      session.desiredSnapshot = replaceFailedPendingWithShadow(
        session.desiredSnapshot,
        session.shadow,
        failedUploadIds,
      );
      session.failedUploadIds = failedUploadIds;
      session.failureSequence += 1;
      session.lastError = permanentFailures.values().next().value;
    } else {
      session.failedUploadIds = new Set();
    }

    const mappingPlan = buildPhotoMappingPlan(
      session.desiredSnapshot,
      session.shadow,
      session.resolvedUploads,
    );
    if (hasPhotoMappingChanges(mappingPlan)) {
      session.phase = "saving";
      emit(session);
      const mappingVersion = session.desiredVersion;
      try {
        await updatePhotoMapping({
          projectId: session.projectId,
          studentId: session.studentId,
          revision,
          pages: mappingPlan.pages,
        });
        didPersist = true;
      } catch (error) {
        if (isRevisionConflict(error)) pauseForConflict(session, revision, error);
        else markMappingError(session, error, mappingVersion);
        return;
      }
    }

    session.shadow = applyPhotoMappingPlanToShadow(session.shadow, mappingPlan);
    session.committedUploadIds = new Set([
      ...session.committedUploadIds,
      ...successfulUploadIds,
      ...[...session.resolvedUploads.keys()].filter(pendingUploadId =>
        [...session.desiredSnapshot.slots.values()].some(slot =>
          slot.binding?.kind === "pending" && slot.binding.pendingUploadId === pendingUploadId
        )
      ),
    ]);
    if (didPersist) session.saveSequence += 1;
    if (permanentFailures.size === 0) session.lastError = null;
    session.errorVersion = null;
    emit(session);
  };

  startRun = session => {
    if (
      session.activeRun !== null
      || session.pause
      || !isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads)
    ) return;
    clearDebounce(session);
    session.queuedReady = false;
    const startVersion = session.desiredVersion;
    const runPromise = Promise.resolve().then(() => performRun(session));
    session.activeRun = runPromise;
    void runPromise.then(
      () => {
        if (session.activeRun !== runPromise) return;
        session.activeRun = null;
        finishRun(session);
      },
      error => {
        if (session.activeRun !== runPromise) return;
        session.activeRun = null;
        markMappingError(session, error, startVersion);
        finishRun(session);
      },
    );
  };

  const initialize = ({
    sessionKey,
    projectId,
    studentId,
    revision,
    desiredSnapshot,
    shadow,
  }) => {
    if (sessions.has(sessionKey)) return sessions.get(sessionKey);
    const session = {
      sessionKey,
      projectId,
      studentId,
      revision,
      desiredSnapshot: clonePhotoDesiredSnapshot(desiredSnapshot),
      shadow: clonePhotoServerShadow(shadow),
      resolvedUploads: new Map(),
      listeners: new Set(),
      activeRun: null,
      debounceHandle: null,
      queuedReady: false,
      phase: "idle",
      progress: null,
      pause: null,
      desiredVersion: 0,
      errorVersion: null,
      conflictSequence: 0,
      saveSequence: 0,
      failureSequence: 0,
      committedUploadIds: new Set(),
      failedUploadIds: new Set(),
      lastError: null,
    };
    sessions.set(sessionKey, session);
    return session;
  };

  const commitResolvedTokensAlreadyInShadow = session => {
    const mappingPlan = buildPhotoMappingPlan(
      session.desiredSnapshot,
      session.shadow,
      session.resolvedUploads,
    );
    const newlyCommittedUploadIds = [];
    for (const slot of session.desiredSnapshot.slots.values()) {
      const binding = slot.binding;
      if (binding?.kind !== "pending" || !session.resolvedUploads.has(binding.pendingUploadId)) continue;
      const pageMapping = mappingPlan.pages[String(slot.pageIndex)];
      if (pageMapping && Object.hasOwn(pageMapping, String(slot.slotId))) continue;
      if (!session.committedUploadIds.has(binding.pendingUploadId)) {
        newlyCommittedUploadIds.push(binding.pendingUploadId);
      }
    }
    if (newlyCommittedUploadIds.length === 0) return;
    session.committedUploadIds = new Set([
      ...session.committedUploadIds,
      ...newlyCommittedUploadIds,
    ]);
    session.saveSequence += 1;
  };

  const resumeRevisionSession = (session, { revision, serverDesiredSnapshot, shadow }) => {
    clearDebounce(session);
    session.revision = revision;
    session.shadow = clonePhotoServerShadow(shadow);
    session.desiredSnapshot = rebasePhotoDesiredSnapshot(
      session.desiredSnapshot,
      serverDesiredSnapshot,
    );
    session.desiredVersion += 1;
    session.pause = null;
    session.lastError = null;
    session.errorVersion = null;
    session.phase = "idle";
    session.progress = null;
    commitResolvedTokensAlreadyInShadow(session);
    if (isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads)) {
      scheduleRun(session, 0);
    } else {
      emit(session);
    }
  };

  return {
    initialize,

    subscribe(sessionKey, listener) {
      const session = sessions.get(sessionKey);
      session.listeners.add(listener);
      listener(publicState(session));
      return () => session.listeners.delete(listener);
    },

    attach(sessionKey, { revision, serverDesiredSnapshot, shadow }, listener) {
      const session = sessions.get(sessionKey);
      if (session.pause && session.pause.revision !== revision) {
        resumeRevisionSession(session, { revision, serverDesiredSnapshot, shadow });
      }
      session.listeners.add(listener);
      listener(publicState(session));
      return () => session.listeners.delete(listener);
    },

    updateDesired(sessionKey, desiredSnapshot) {
      const session = sessions.get(sessionKey);
      session.desiredSnapshot = clonePhotoDesiredSnapshot(desiredSnapshot);
      session.desiredVersion += 1;
      session.errorVersion = null;
      if (session.pause) {
        emit(session);
        return;
      }
      if (!isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads)) {
        clearDebounce(session);
        session.queuedReady = false;
        if (session.activeRun === null) {
          session.phase = "idle";
          session.progress = null;
        }
        emit(session);
        return;
      }
      scheduleRun(session);
    },

    resumeRevision(sessionKey, { revision, serverDesiredSnapshot, shadow }) {
      const session = sessions.get(sessionKey);
      resumeRevisionSession(session, { revision, serverDesiredSnapshot, shadow });
    },

    flush(sessionKey) {
      const session = sessions.get(sessionKey);
      if (!session || session.pause) return;
      clearDebounce(session);
      session.queuedReady = true;
      if (session.activeRun === null) startRun(session);
    },

    detach(sessionKey, listener) {
      const session = sessions.get(sessionKey);
      if (!session) return;
      if (listener) session.listeners.delete(listener);
      if (session.debounceHandle !== null) {
        clearDebounce(session);
        session.queuedReady = true;
      }
      if (
        !session.pause
        && isPhotoSnapshotDirty(session.desiredSnapshot, session.shadow, session.resolvedUploads)
        && session.activeRun === null
      ) startRun(session);
      maybeEvict(session);
    },

    getState(sessionKey) {
      const session = sessions.get(sessionKey);
      return session ? publicState(session) : null;
    },

    async waitForSettled(sessionKey) {
      const session = sessions.get(sessionKey);
      while (session?.activeRun) await session.activeRun;
      await Promise.resolve();
      const latestSession = sessions.get(sessionKey);
      if (latestSession?.activeRun) return this.waitForSettled(sessionKey);
      return latestSession ? publicState(latestSession) : null;
    },
  };
}
