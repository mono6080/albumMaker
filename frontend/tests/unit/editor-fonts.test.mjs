import assert from "node:assert/strict";

import {
  EDITOR_FONT_ERROR_CODES,
  createEditorFontLoader,
  shouldRetryEditorFontsInPage,
} from "../../src/utils/editorFonts.js";
import { test } from "./harness.mjs";


function createFakeFontSet(load) {
  const loadingErrorListeners = new Set();
  return {
    load,
    addEventListener(eventName, listener) {
      if (eventName === "loadingerror") loadingErrorListeners.add(listener);
    },
    removeEventListener(eventName, listener) {
      if (eventName === "loadingerror") loadingErrorListeners.delete(listener);
    },
    dispatchLoadingError() {
      for (const listener of loadingErrorListeners) listener();
    },
    get loadingErrorListenerCount() {
      return loadingErrorListeners.size;
    },
  };
}


function createFakeTimers() {
  let nextTimerId = 1;
  const callbacks = new Map();
  return {
    setTimeoutFn(callback) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      callbacks.set(timerId, callback);
      return timerId;
    },
    clearTimeoutFn(timerId) {
      callbacks.delete(timerId);
    },
    fireAll() {
      const pendingCallbacks = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pendingCallbacks) callback();
    },
    get pendingCount() {
      return callbacks.size;
    },
  };
}


function createLoader(fontSet, timers) {
  return createEditorFontLoader({
    getFontSet: () => fontSet,
    timeoutMs: 45_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
}


test("editor font loader rejects a never-settling load at the bounded timeout", async () => {
  const fontSet = createFakeFontSet(() => new Promise(() => {}));
  const timers = createFakeTimers();
  const { loadEditorFonts } = createLoader(fontSet, timers);

  const pendingLoad = loadEditorFonts();
  assert.equal(timers.pendingCount, 1);
  timers.fireAll();

  const timeoutError = await pendingLoad.catch(error => error);
  assert.equal(timeoutError.code, EDITOR_FONT_ERROR_CODES.TIMEOUT);
  assert.equal(shouldRetryEditorFontsInPage(timeoutError), true);
  assert.equal(timers.pendingCount, 0);
  assert.equal(fontSet.loadingErrorListenerCount, 0);
});


test("editor font loader rejects empty FontFaceSet results", async () => {
  const fontSet = createFakeFontSet(async () => []);
  const timers = createFakeTimers();
  const { loadEditorFonts } = createLoader(fontSet, timers);

  const unavailableError = await loadEditorFonts().catch(error => error);
  assert.equal(unavailableError.code, EDITOR_FONT_ERROR_CODES.UNAVAILABLE);
  assert.equal(shouldRetryEditorFontsInPage(unavailableError), false);
  assert.equal(timers.pendingCount, 0);
  assert.equal(fontSet.loadingErrorListenerCount, 0);
});


test("editor font loader fails immediately on FontFaceSet loadingerror", async () => {
  const fontSet = createFakeFontSet(() => new Promise(() => {}));
  const timers = createFakeTimers();
  const { loadEditorFonts } = createLoader(fontSet, timers);

  const pendingLoad = loadEditorFonts();
  fontSet.dispatchLoadingError();

  const loadingError = await pendingLoad.catch(error => error);
  assert.equal(loadingError.code, EDITOR_FONT_ERROR_CODES.LOAD_FAILED);
  assert.equal(shouldRetryEditorFontsInPage(loadingError), false);
  assert.equal(timers.pendingCount, 0);
  assert.equal(fontSet.loadingErrorListenerCount, 0);
});


test("editor font loader retains failure until an explicit retry generation", async () => {
  let loadCallCount = 0;
  const fontSet = createFakeFontSet(async () => {
    loadCallCount += 1;
    return loadCallCount <= 3 ? [] : [{}];
  });
  const timers = createFakeTimers();
  const {
    loadEditorFonts,
    retryEditorFonts,
  } = createLoader(fontSet, timers);

  const failedAttempt = loadEditorFonts();
  assert.strictEqual(loadEditorFonts(), failedAttempt);
  await assert.rejects(failedAttempt, /unavailable/);
  assert.strictEqual(loadEditorFonts(), failedAttempt);

  retryEditorFonts();
  const successfulRetry = loadEditorFonts();
  assert.notStrictEqual(successfulRetry, failedAttempt);
  assert.strictEqual(loadEditorFonts(), successfulRetry);
  await assert.doesNotReject(successfulRetry);
  assert.equal(loadCallCount, 6);
  assert.equal(timers.pendingCount, 0);
});
