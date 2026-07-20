import assert from "node:assert/strict";
import { createPreviewBlobCache } from "../../src/utils/previewImageCache.js";
import { test } from "./harness.mjs";


function fakeDeps(overrides = {}) {
  const fetchCalls = [];
  const revoked = [];
  let blobSeq = 0;
  return {
    fetchCalls,
    revoked,
    deps: {
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return { ok: true, blob: async () => ({ url }) };
      },
      createObjectURL: () => `blob:${blobSeq++}`,
      revokeObjectURL: (u) => revoked.push(u),
      maxEntries: 3,
      timeoutMs: 1000,
      ...overrides,
    },
  };
}


test("preview cache serves a memory hit without re-fetching", async () => {
  const { deps, fetchCalls } = fakeDeps();
  const cache = createPreviewBlobCache(deps);

  const first = await cache.load("/preview/a");
  assert.equal(fetchCalls.length, 1);
  assert.equal(cache.getCached("/preview/a"), first);

  const second = await cache.load("/preview/a");
  assert.equal(second, first, "same URL returns the same blob");
  assert.equal(fetchCalls.length, 1, "cached URL is never re-fetched");
});


test("preview cache dedupes concurrent in-flight loads of the same URL", async () => {
  let resolveFetch;
  const fetchCalls = [];
  const cache = createPreviewBlobCache({
    fetchImpl: (url) => {
      fetchCalls.push(url);
      return new Promise(resolve => { resolveFetch = () => resolve({ ok: true, blob: async () => ({ url }) }); });
    },
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
  });

  const p1 = cache.load("/preview/a");
  const p2 = cache.load("/preview/a");
  assert.equal(fetchCalls.length, 1, "second concurrent load reuses the in-flight request");
  resolveFetch();
  assert.equal(await p1, await p2);
});


test("preview cache evicts the least-recently-used blob and revokes it", async () => {
  const { deps, revoked } = fakeDeps({ maxEntries: 2 });
  const cache = createPreviewBlobCache(deps);

  const a = await cache.load("/preview/a");
  await cache.load("/preview/b");
  // 觸碰 a 使 b 成為最舊
  cache.getCached("/preview/a");
  await cache.load("/preview/c"); // 超過上限 → 逐出最舊（b）

  assert.equal(cache.getCached("/preview/b"), null, "LRU victim is gone");
  assert.equal(cache.getCached("/preview/a"), a, "recently touched entry survives");
  assert.ok(cache.getCached("/preview/c"));
  assert.equal(revoked.length, 1, "evicted blob URL is revoked exactly once");
});


test("preview cache propagates fetch failure and clears in-flight for retry", async () => {
  let shouldFail = true;
  const fetchCalls = [];
  const cache = createPreviewBlobCache({
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      if (shouldFail) return { ok: false, status: 503, blob: async () => ({}) };
      return { ok: true, blob: async () => ({ url }) };
    },
    createObjectURL: () => "blob:ok",
    revokeObjectURL: () => {},
  });

  await assert.rejects(() => cache.load("/preview/a"), /503/);
  assert.equal(cache.getCached("/preview/a"), null, "failed load is not cached");
  assert.equal(cache.inflight.has("/preview/a"), false, "in-flight cleared so a retry can start");

  shouldFail = false;
  const ok = await cache.load("/preview/a");
  assert.equal(ok, "blob:ok");
  assert.equal(fetchCalls.length, 2, "retry issues a fresh request");
});


test("preview cache aborts a hung fetch via its timeout", async () => {
  let sawAbort = false;
  const cache = createPreviewBlobCache({
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); });
    }),
    createObjectURL: () => "blob:never",
    revokeObjectURL: () => {},
    timeoutMs: 5,
  });

  await assert.rejects(() => cache.load("/preview/a"));
  assert.equal(sawAbort, true, "timeout fires the abort signal on a hung request");
});
