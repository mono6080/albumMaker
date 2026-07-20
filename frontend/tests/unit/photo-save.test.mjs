import assert from "node:assert/strict";
import { createPhotoSaveCoordinator, photoSaveSessionKey } from "../../src/utils/photoSaveCoordinator.js";
import {
  changedPageIndexesBetweenShadows,
  createPhotoDesiredSnapshot,
  createPhotoServerShadow,
} from "../../src/utils/photoSaveModel.js";
import { test } from "./harness.mjs";


function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}


function createFakeScheduler() {
  const scheduled = [];
  return {
    schedule(callback, delay) {
      const entry = { callback, delay, cancelled: false };
      scheduled.push(entry);
      return entry;
    },
    cancelSchedule(entry) {
      entry.cancelled = true;
    },
    fireNext() {
      const entry = scheduled.find(candidate => !candidate.cancelled);
      assert.ok(entry, "expected a scheduled callback");
      entry.cancelled = true;
      entry.callback();
      return entry.delay;
    },
    pendingCount() {
      return scheduled.filter(entry => !entry.cancelled).length;
    },
  };
}


function photoItem({
  pageIndex = 0,
  slotId,
  path = null,
  pendingUploadId = null,
  file = null,
  transform = { scale: 1, offsetX: 0, offsetY: 0, brightness: 1, contrast: 1 },
}) {
  return {
    pi: pageIndex,
    templatePageId: `page-${pageIndex}`,
    slotId,
    serverPath: path,
    origServerPath: path,
    pendingUploadId,
    pendingFile: file,
    transform: { ...transform },
    origTransform: { scale: 1, offsetX: 0, offsetY: 0, brightness: 1, contrast: 1 },
  };
}


function desired(items) {
  return createPhotoDesiredSnapshot(items);
}


function shadow(items) {
  return createPhotoServerShadow(items);
}


function initializeCoordinator(coordinator, items, revision = 1, studentId = 11) {
  const sessionKey = photoSaveSessionKey(7, studentId);
  coordinator.initialize({
    sessionKey,
    projectId: 7,
    studentId,
    revision,
    desiredSnapshot: desired(items),
    shadow: shadow(items),
  });
  return sessionKey;
}


async function allowRunToStart() {
  await Promise.resolve();
  await Promise.resolve();
}


async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), "condition did not become true");
}


test("photo coordinator keeps one run and reconciles a stale upload to the latest slot", async () => {
  const scheduler = createFakeScheduler();
  const uploadDeferred = deferred();
  const uploadCalls = [];
  const mappingCalls = [];
  let activeUploads = 0;
  let maxActiveUploads = 0;
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: async task => {
      uploadCalls.push(task);
      activeUploads += 1;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      const result = await uploadDeferred.promise;
      activeUploads -= 1;
      return result;
    },
    updatePhotoMapping: async request => mappingCalls.push(request),
  });
  const baseItems = [photoItem({ slotId: 1 }), photoItem({ slotId: 2 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  coordinator.subscribe(sessionKey, () => {});

  const file = { name: "a.jpg" };
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-a", file }),
    photoItem({ slotId: 2 }),
  ]));
  assert.equal(scheduler.fireNext(), 300);
  await allowRunToStart();
  assert.equal(uploadCalls.length, 1);

  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1 }),
    photoItem({ slotId: 2, pendingUploadId: "upload-a", file }),
  ]));
  scheduler.fireNext();
  assert.equal(uploadCalls.length, 1, "active snapshot must not be uploaded twice");

  uploadDeferred.resolve({ path: "projects/a.jpg" });
  await coordinator.waitForSettled(sessionKey);

  assert.equal(maxActiveUploads, 1);
  assert.equal(uploadCalls.length, 1);
  assert.equal(mappingCalls.length, 1);
  assert.deepEqual(mappingCalls[0].pages, {
    "0": {
      "1": null,
      "2": {
        path: "projects/a.jpg",
        scale: 1,
        offset_x: 0,
        offset_y: 0,
        brightness: 1,
        contrast: 1,
      },
    },
  });
  const state = coordinator.getState(sessionKey);
  assert.equal(state.phase, "idle");
  assert.equal(state.hasUnsaved, false);
  assert.equal(state.shadow.slots.get("page-0:1"), null);
  assert.equal(state.shadow.slots.get("page-0:2").path, "projects/a.jpg");
});


test("photo coordinator compensates stale delete after upload response", async () => {
  const scheduler = createFakeScheduler();
  const uploadDeferred = deferred();
  const mappingCalls = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: () => uploadDeferred.promise,
    updatePhotoMapping: async request => mappingCalls.push(request),
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  coordinator.subscribe(sessionKey, () => {});
  const file = { name: "delete.jpg" };

  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-delete", file }),
  ]));
  scheduler.fireNext();
  await allowRunToStart();
  coordinator.updateDesired(sessionKey, desired([photoItem({ slotId: 1 })]));
  uploadDeferred.resolve({ path: "projects/delete.jpg" });
  await coordinator.waitForSettled(sessionKey);

  assert.deepEqual(mappingCalls.map(call => call.pages), [{ "0": { "1": null } }]);
  assert.equal(coordinator.getState(sessionKey).shadow.slots.get("page-0:1"), null);
});


test("photo coordinator keeps replacement token latest and never lets stale response overwrite it", async () => {
  const scheduler = createFakeScheduler();
  const firstUpload = deferred();
  const secondUpload = deferred();
  const uploadCalls = [];
  const mappingCalls = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: task => {
      uploadCalls.push(task.pendingUploadId);
      return task.pendingUploadId === "upload-a" ? firstUpload.promise : secondUpload.promise;
    },
    updatePhotoMapping: async request => mappingCalls.push(request),
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  coordinator.subscribe(sessionKey, () => {});
  const firstFile = { name: "a.jpg" };
  const secondFile = { name: "b.jpg" };

  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-a", file: firstFile }),
  ]));
  scheduler.fireNext();
  await allowRunToStart();
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-b", file: secondFile }),
  ]));
  scheduler.fireNext();
  firstUpload.resolve({ path: "projects/a.jpg" });
  await waitUntil(() => uploadCalls.length === 2);

  assert.deepEqual(uploadCalls, ["upload-a", "upload-b"]);
  assert.equal(mappingCalls.length, 0, "unresolved replacement keeps current shadow until its POST");
  assert.equal(coordinator.getState(sessionKey).shadow.slots.get("page-0:1").path, "projects/a.jpg");

  secondUpload.resolve({ path: "projects/b.jpg" });
  await coordinator.waitForSettled(sessionKey);
  const state = coordinator.getState(sessionKey);
  assert.equal(state.shadow.slots.get("page-0:1").path, "projects/b.jpg");
  assert.equal(state.hasUnsaved, false);
});


test("photo coordinator maps desired transform after upload resets server transform", async () => {
  const scheduler = createFakeScheduler();
  const uploadDeferred = deferred();
  const mappingCalls = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: () => uploadDeferred.promise,
    updatePhotoMapping: async request => mappingCalls.push(request),
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  coordinator.subscribe(sessionKey, () => {});

  coordinator.updateDesired(sessionKey, desired([photoItem({
    slotId: 1,
    pendingUploadId: "upload-transform",
    file: { name: "transform.jpg" },
  })]));
  scheduler.fireNext();
  await allowRunToStart();
  coordinator.updateDesired(sessionKey, desired([photoItem({
    slotId: 1,
    pendingUploadId: "upload-transform",
    file: { name: "transform.jpg" },
    transform: { scale: 1.4, offsetX: 0.2, offsetY: -0.1, brightness: 1.2, contrast: 0.8 },
  })]));
  scheduler.fireNext();
  uploadDeferred.resolve({ path: "projects/transform.jpg" });
  await coordinator.waitForSettled(sessionKey);

  assert.deepEqual(mappingCalls[0].pages["0"]["1"], {
    path: "projects/transform.jpg",
    scale: 1.4,
    offset_x: 0.2,
    offset_y: -0.1,
    brightness: 1.2,
    contrast: 0.8,
  });
});


test("photo coordinator uses injected three-attempt retry and remains operable after permanent failure", async () => {
  const scheduler = createFakeScheduler();
  let uploadAttempts = 0;
  const retryDelays = [];
  let shouldFailPermanently = false;
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    retryUpload: async operation => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          if (attempt === 3 || error.status === 413) throw error;
          retryDelays.push(attempt * 10);
        }
      }
      throw new Error("unreachable");
    },
    uploadPhoto: async task => {
      uploadAttempts += 1;
      if (shouldFailPermanently) throw { status: 413 };
      if (uploadAttempts < 3) throw { status: 503 };
      return { path: `projects/${task.pendingUploadId}.jpg` };
    },
    updatePhotoMapping: async () => {},
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  coordinator.subscribe(sessionKey, () => {});

  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-retry", file: { name: "retry.jpg" } }),
  ]));
  scheduler.fireNext();
  await coordinator.waitForSettled(sessionKey);
  assert.equal(uploadAttempts, 3);
  assert.deepEqual(retryDelays, [10, 20]);

  shouldFailPermanently = true;
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-fail", file: { name: "fail.jpg" } }),
  ]));
  scheduler.fireNext();
  await coordinator.waitForSettled(sessionKey);
  let state = coordinator.getState(sessionKey);
  assert.equal(state.failureSequence, 1);
  assert.equal(state.hasUnsaved, false);

  shouldFailPermanently = false;
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-again", file: { name: "again.jpg" } }),
  ]));
  scheduler.fireNext();
  await coordinator.waitForSettled(sessionKey);
  state = coordinator.getState(sessionKey);
  assert.equal(state.hasUnsaved, false);
  assert.equal(state.shadow.slots.get("page-0:1").path, "projects/upload-again.jpg");
});


test("photo coordinator pauses upload conflict by project student revision and resumes same token", async () => {
  const scheduler = createFakeScheduler();
  const conflict = { response: { status: 409 } };
  let shouldConflict = true;
  const uploadCalls = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    isRevisionConflict: error => error === conflict,
    uploadPhoto: async task => {
      uploadCalls.push({ token: task.pendingUploadId, revision: task.revision });
      if (shouldConflict) throw conflict;
      return { path: "projects/resumed.jpg" };
    },
    updatePhotoMapping: async () => {},
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems, 4);
  const originalEvents = [];
  const originalListener = state => originalEvents.push(state.phase);
  coordinator.subscribe(sessionKey, originalListener);
  const pendingItems = [
    photoItem({ slotId: 1, pendingUploadId: "upload-conflict", file: { name: "conflict.jpg" } }),
  ];

  coordinator.updateDesired(sessionKey, desired(pendingItems));
  scheduler.fireNext();
  await coordinator.waitForSettled(sessionKey);
  let state = coordinator.getState(sessionKey);
  assert.equal(state.phase, "conflict");
  assert.equal(state.isBusy, false);
  assert.equal(state.hasUnsaved, true);
  assert.equal(state.pause.key, "7:11:4");

  coordinator.detach(sessionKey, originalListener);
  const sameRevisionEvents = [];
  const unsubscribeSameRevision = coordinator.attach(sessionKey, {
    revision: 4,
    serverDesiredSnapshot: desired(baseItems),
    shadow: shadow(baseItems),
  }, attachedState => sameRevisionEvents.push(attachedState.phase));
  assert.deepEqual(sameRevisionEvents, ["conflict"], "same revision reattach must request recovery");
  unsubscribeSameRevision();

  shouldConflict = false;
  const reattachedEvents = [];
  coordinator.attach(sessionKey, {
    revision: 5,
    serverDesiredSnapshot: desired(baseItems),
    shadow: shadow(baseItems),
  }, attachedState => reattachedEvents.push(attachedState.phase));
  assert.equal(reattachedEvents.includes("conflict"), false, "new revision must resume before notifying UI");
  assert.equal(scheduler.fireNext(), 0);
  await coordinator.waitForSettled(sessionKey);
  state = coordinator.getState(sessionKey);
  assert.deepEqual(uploadCalls, [
    { token: "upload-conflict", revision: 4 },
    { token: "upload-conflict", revision: 5 },
  ]);
  assert.equal(state.phase, "idle");
  assert.equal(state.hasUnsaved, false);
});


test("photo coordinator retries a newer desired version after an older mapping request fails", async () => {
  const scheduler = createFakeScheduler();
  const firstMapping = deferred();
  const mappingCalls = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: async () => { throw new Error("unexpected upload"); },
    updatePhotoMapping: request => {
      mappingCalls.push(request);
      return mappingCalls.length === 1 ? firstMapping.promise : Promise.resolve();
    },
  });
  const baseItems = [photoItem({ slotId: 1, path: "projects/existing.jpg" })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  coordinator.subscribe(sessionKey, () => {});

  coordinator.updateDesired(sessionKey, desired([photoItem({
    slotId: 1,
    path: "projects/existing.jpg",
    transform: { scale: 1.1, offsetX: 0, offsetY: 0, brightness: 1, contrast: 1 },
  })]));
  scheduler.fireNext();
  await waitUntil(() => mappingCalls.length === 1);

  coordinator.updateDesired(sessionKey, desired([photoItem({
    slotId: 1,
    path: "projects/existing.jpg",
    transform: { scale: 1.4, offsetX: 0.1, offsetY: 0, brightness: 1, contrast: 1 },
  })]));
  scheduler.fireNext();
  firstMapping.reject(new Error("first mapping failed"));
  await waitUntil(() => coordinator.getState(sessionKey).phase === "debouncing");
  scheduler.fireNext();
  await coordinator.waitForSettled(sessionKey);

  assert.equal(mappingCalls.length, 2);
  assert.deepEqual(mappingCalls[1].pages, {
    "0": {
      "1": {
        path: "projects/existing.jpg",
        scale: 1.4,
        offset_x: 0.1,
        offset_y: 0,
        brightness: 1,
        contrast: 1,
      },
    },
  });
  const state = coordinator.getState(sessionKey);
  assert.equal(state.phase, "idle");
  assert.equal(state.hasUnsaved, false);
});


test("photo coordinator retains upload shadow across mapping conflict and does not re-upload on resume", async () => {
  const scheduler = createFakeScheduler();
  const mappingConflict = { response: { status: 409 } };
  const uploadDeferred = deferred();
  const uploadCalls = [];
  const mappingCalls = [];
  let shouldConflict = true;
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    isRevisionConflict: error => error === mappingConflict,
    uploadPhoto: task => {
      uploadCalls.push(task);
      return uploadDeferred.promise;
    },
    updatePhotoMapping: async request => {
      mappingCalls.push(request);
      if (shouldConflict) throw mappingConflict;
    },
  });
  const baseItems = [photoItem({ slotId: 1 }), photoItem({ slotId: 2 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems, 8);
  coordinator.subscribe(sessionKey, () => {});
  const file = { name: "mapping.jpg" };

  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-mapping", file }),
    photoItem({ slotId: 2 }),
  ]));
  scheduler.fireNext();
  await allowRunToStart();
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1 }),
    photoItem({ slotId: 2, pendingUploadId: "upload-mapping", file }),
  ]));
  scheduler.fireNext();
  uploadDeferred.resolve({ path: "projects/mapping.jpg" });
  await coordinator.waitForSettled(sessionKey);

  let state = coordinator.getState(sessionKey);
  assert.equal(state.phase, "conflict");
  assert.equal(state.shadow.slots.get("page-0:1").path, "projects/mapping.jpg");
  assert.equal(uploadCalls.length, 1);

  shouldConflict = false;
  const reloadedItems = [
    photoItem({ slotId: 1, path: "projects/mapping.jpg" }),
    photoItem({ slotId: 2 }),
  ];
  coordinator.resumeRevision(sessionKey, {
    revision: 9,
    serverDesiredSnapshot: desired(reloadedItems),
    shadow: shadow(reloadedItems),
  });
  scheduler.fireNext();
  await coordinator.waitForSettled(sessionKey);
  state = coordinator.getState(sessionKey);
  assert.equal(uploadCalls.length, 1, "resolved token must not POST again after revision recovery");
  assert.equal(mappingCalls.length, 2);
  assert.equal(state.shadow.slots.get("page-0:1"), null);
  assert.equal(state.shadow.slots.get("page-0:2").path, "projects/mapping.jpg");
});


test("photo coordinator commits a resolved token when recovered server shadow already equals desired", async () => {
  const scheduler = createFakeScheduler();
  const mappingConflict = { response: { status: 409 } };
  const uploadDeferred = deferred();
  const uploadCalls = [];
  const mappingCalls = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    isRevisionConflict: error => error === mappingConflict,
    uploadPhoto: task => {
      uploadCalls.push(task);
      return uploadDeferred.promise;
    },
    updatePhotoMapping: async request => {
      mappingCalls.push(request);
      throw mappingConflict;
    },
  });
  const baseItems = [photoItem({ slotId: 1 }), photoItem({ slotId: 2 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems, 20);
  const originalListener = () => {};
  coordinator.subscribe(sessionKey, originalListener);
  const file = { name: "already-current.jpg" };

  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-already-current", file }),
    photoItem({ slotId: 2 }),
  ]));
  scheduler.fireNext();
  await allowRunToStart();
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1 }),
    photoItem({ slotId: 2, pendingUploadId: "upload-already-current", file }),
  ]));
  scheduler.fireNext();
  uploadDeferred.resolve({ path: "projects/already-current.jpg" });
  await coordinator.waitForSettled(sessionKey);
  assert.equal(coordinator.getState(sessionKey).phase, "conflict");
  coordinator.detach(sessionKey, originalListener);

  const recoveredItems = [
    photoItem({ slotId: 1 }),
    photoItem({ slotId: 2, path: "projects/already-current.jpg" }),
  ];
  const attachedStates = [];
  coordinator.attach(sessionKey, {
    revision: 21,
    serverDesiredSnapshot: desired(recoveredItems),
    shadow: shadow(recoveredItems),
  }, state => attachedStates.push(state));

  const state = coordinator.getState(sessionKey);
  assert.equal(uploadCalls.length, 1);
  assert.equal(mappingCalls.length, 1, "matching recovered shadow must not issue another mapping request");
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(state.phase, "idle");
  assert.equal(state.hasUnsaved, false);
  assert.equal(state.saveSequence, 1);
  assert.equal(state.committedUploadIds.has("upload-already-current"), true);
  assert.equal(attachedStates.at(-1).committedUploadIds.has("upload-already-current"), true);
});


test("photo coordinator flushes queued work on detach without notifying detached or other student UI", async () => {
  const scheduler = createFakeScheduler();
  const firstUpload = deferred();
  const secondUpload = deferred();
  const uploadCalls = [];
  const firstStudentEvents = [];
  const secondStudentEvents = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: task => {
      uploadCalls.push(task);
      return task.pendingUploadId === "upload-detached-a" ? firstUpload.promise : secondUpload.promise;
    },
    updatePhotoMapping: async () => {},
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const firstSessionKey = initializeCoordinator(coordinator, baseItems, 1, 11);
  const secondSessionKey = initializeCoordinator(coordinator, baseItems, 1, 12);
  const firstListener = state => firstStudentEvents.push(state.phase);
  coordinator.subscribe(firstSessionKey, firstListener);
  coordinator.subscribe(secondSessionKey, state => secondStudentEvents.push(state.phase));

  coordinator.updateDesired(firstSessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-detached-a", file: { name: "detached-a.jpg" } }),
  ]));
  scheduler.fireNext();
  await allowRunToStart();
  assert.equal(uploadCalls.length, 1);

  coordinator.updateDesired(firstSessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-detached-b", file: { name: "detached-b.jpg" } }),
  ]));
  const eventCountBeforeDetach = firstStudentEvents.length;
  coordinator.detach(firstSessionKey, firstListener);
  assert.equal(uploadCalls.length, 1, "queued replacement must serialize behind active upload");

  firstUpload.resolve({ path: "projects/detached-a.jpg" });
  await waitUntil(() => uploadCalls.length === 2);
  secondUpload.resolve({ path: "projects/detached-b.jpg" });
  await coordinator.waitForSettled(firstSessionKey);
  assert.equal(firstStudentEvents.length, eventCountBeforeDetach);
  assert.deepEqual(secondStudentEvents, ["idle"]);
  assert.deepEqual(uploadCalls.map(call => call.studentId), [11, 11]);
  assert.equal(coordinator.getState(firstSessionKey), null, "clean detached session can be evicted");
});


test("photo coordinator flushes debounce-only detach and supports a clean StrictMode remount", async () => {
  const scheduler = createFakeScheduler();
  const uploadCalls = [];
  const events = [];
  const coordinator = createPhotoSaveCoordinator({
    ...scheduler,
    uploadPhoto: async task => {
      uploadCalls.push(task);
      return { path: `projects/${task.pendingUploadId}.jpg` };
    },
    updatePhotoMapping: async () => {},
  });
  const baseItems = [photoItem({ slotId: 1 })];
  const sessionKey = initializeCoordinator(coordinator, baseItems);
  const firstListener = state => events.push(`first:${state.phase}`);
  const unsubscribeFirst = coordinator.subscribe(sessionKey, firstListener);

  // React StrictMode 的 clean setup → cleanup → setup 不應留下幽靈 session。
  unsubscribeFirst();
  coordinator.detach(sessionKey);
  assert.equal(coordinator.getState(sessionKey), null);
  initializeCoordinator(coordinator, baseItems);
  const secondListener = state => events.push(`second:${state.phase}`);
  coordinator.subscribe(sessionKey, secondListener);
  coordinator.updateDesired(sessionKey, desired([
    photoItem({ slotId: 1, pendingUploadId: "upload-debounce-detach", file: { name: "detach.jpg" } }),
  ]));
  const eventCountBeforeDetach = events.length;
  coordinator.detach(sessionKey, secondListener);
  await coordinator.waitForSettled(sessionKey);

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(uploadCalls.length, 1);
  assert.equal(events.length, eventCountBeforeDetach, "detached listener must not receive flushed work");
  assert.equal(coordinator.getState(sessionKey), null);
});


test("changed page indexes between shadows cover path and transform changes only", () => {
  const baseItems = [
    photoItem({ pageIndex: 0, slotId: 1, path: "projects/a.jpg" }),
    photoItem({ pageIndex: 1, slotId: 2, path: "projects/b.jpg" }),
    photoItem({ pageIndex: 2, slotId: 3 }),
  ];
  const previousShadow = shadow(baseItems);
  const desiredSnapshot = desired(baseItems);

  // 第 0 頁換照片、第 1 頁只動 transform、第 2 頁不變
  const nextItems = [
    photoItem({ pageIndex: 0, slotId: 1, path: "projects/a2.jpg" }),
    {
      ...photoItem({ pageIndex: 1, slotId: 2, path: "projects/b.jpg" }),
      origTransform: { scale: 1.5, offsetX: 0, offsetY: 0, brightness: 1, contrast: 1 },
    },
    photoItem({ pageIndex: 2, slotId: 3 }),
  ];
  assert.deepEqual(
    changedPageIndexesBetweenShadows(previousShadow, shadow(nextItems), desiredSnapshot),
    [0, 1],
  );
  assert.deepEqual(
    changedPageIndexesBetweenShadows(previousShadow, previousShadow, desiredSnapshot),
    [],
  );
});


test("changed page indexes fall back to null when a changed slot cannot map to a page", () => {
  const previousShadow = shadow([photoItem({ pageIndex: 0, slotId: 9, path: "projects/x.jpg" })]);
  const nextShadow = shadow([photoItem({ pageIndex: 0, slotId: 9, path: "projects/y.jpg" })]);
  assert.equal(
    changedPageIndexesBetweenShadows(previousShadow, nextShadow, desired([])),
    null,
  );
});
