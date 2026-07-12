// 游標式並行工作池：N 個 worker 共享游標依序認領 items，全部完成後回傳 results。
// task(item, index) 的回傳值依原始順序放入 results（副作用式呼叫端忽略回傳值即可）。
export async function runWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
