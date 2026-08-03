import assert from "node:assert/strict";

import { createLatestRequestCoordinator } from "../../src/utils/latestRequest.js";
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


function createFakeAbortController() {
  const created = [];
  const factory = () => {
    const controller = {
      signal: { aborted: false },
      abort() { controller.signal.aborted = true; },
    };
    created.push(controller);
    return controller;
  };
  return { factory, created };
}


test("較慢的舊回應不會蓋掉較新的選擇", async () => {
  const coordinator = createLatestRequestCoordinator();
  const first = deferred();
  const second = deferred();
  const applied = [];

  const firstRun = coordinator.run(() => first.promise, {
    onResult: value => applied.push(value),
  });
  const secondRun = coordinator.run(() => second.promise, {
    onResult: value => applied.push(value),
  });

  // 新的先回、舊的後回——這正是使用者連按兩下時的真實順序
  second.resolve("新學期");
  await secondRun;
  first.resolve("舊學期");
  await firstRun;

  assert.deepEqual(applied, ["新學期"], "舊回應不該被套用");
});


test("被取代的請求即使失敗也不該把錯誤丟到畫面上", async () => {
  const coordinator = createLatestRequestCoordinator();
  const first = deferred();
  const second = deferred();
  const errors = [];
  const applied = [];

  const firstRun = coordinator.run(() => first.promise, {
    onError: error => errors.push(error.message),
  });
  const secondRun = coordinator.run(() => second.promise, {
    onResult: value => applied.push(value),
  });

  first.reject(new Error("舊請求逾時"));
  await firstRun;
  second.resolve("新資料");
  await secondRun;

  assert.deepEqual(errors, [], "舊請求的錯誤不該顯示");
  assert.deepEqual(applied, ["新資料"]);
});


test("onSettled 只由目前這一個請求觸發，載入狀態不會被舊請求提早關掉", async () => {
  const coordinator = createLatestRequestCoordinator();
  const first = deferred();
  const second = deferred();
  let loading = 0;

  const firstRun = coordinator.run(() => first.promise, {
    onStart: () => { loading += 1; },
    onSettled: () => { loading -= 1; },
  });
  const secondRun = coordinator.run(() => second.promise, {
    onStart: () => { loading += 1; },
    onSettled: () => { loading -= 1; },
  });

  first.resolve("舊");
  await firstRun;
  assert.equal(loading, 2, "舊請求結束不該動到載入狀態");

  second.resolve("新");
  await secondRun;
  assert.equal(loading, 1, "只有目前這一個會把載入狀態收掉");
});


test("發起新請求時會中止前一個", async () => {
  const { factory, created } = createFakeAbortController();
  const coordinator = createLatestRequestCoordinator({ createAbortController: factory });
  const first = deferred();
  const second = deferred();

  const firstRun = coordinator.run(() => first.promise, {});
  const secondRun = coordinator.run(() => second.promise, {});

  assert.equal(created.length, 2);
  assert.equal(created[0].signal.aborted, true, "前一個請求要被中止");
  assert.equal(created[1].signal.aborted, false);

  first.resolve(null);
  second.resolve(null);
  await Promise.all([firstRun, secondRun]);
});


test("abort() 之後回來的結果一律不算數", async () => {
  const { factory } = createFakeAbortController();
  const coordinator = createLatestRequestCoordinator({ createAbortController: factory });
  const pending = deferred();
  const applied = [];

  const run = coordinator.run(() => pending.promise, {
    onResult: value => applied.push(value),
    onSettled: () => applied.push("settled"),
  });
  coordinator.abort();
  pending.resolve("卸載後才回來的資料");
  await run;

  assert.deepEqual(applied, [], "元件已經卸載，什麼都不該做");
  assert.equal(coordinator.isPending, false);
});


test("三個請求交錯時只有最後一個算數", async () => {
  const coordinator = createLatestRequestCoordinator();
  const requests = [deferred(), deferred(), deferred()];
  const applied = [];
  const runs = requests.map((request, index) => coordinator.run(
    () => request.promise,
    { onResult: () => applied.push(index) },
  ));

  // 回來的順序完全打亂：中間的最先、最新的其次、最舊的最後
  requests[1].resolve(null);
  requests[2].resolve(null);
  requests[0].resolve(null);
  await Promise.all(runs);

  assert.deepEqual(applied, [2], "只有第三個（最新的）能套用");
});
