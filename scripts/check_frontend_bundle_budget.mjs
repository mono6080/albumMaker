// 防止 route lazy boundary 退化，讓重型編輯頁重新進入首屏 bundle。
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const BASELINE_INDEX_BYTES = 351_204;
const distDir = resolve(process.cwd(), process.argv[2] ?? "frontend/dist");
const assetsDir = resolve(distDir, "assets");

const findSingleMatch = (source, pattern, label) => {
  const matches = [...source.matchAll(pattern)].map(match => match[1]);
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length !== 1) {
    throw new Error(`Expected exactly one active ${label} chunk, found ${uniqueMatches.length}`);
  }
  return uniqueMatches[0];
};

const indexHtml = await readFile(resolve(distDir, "index.html"), "utf8");
const indexChunk = findSingleMatch(indexHtml, /assets\/(index-[^"']+\.js)/g, "index");
const indexBytes = (await stat(resolve(assetsDir, indexChunk))).size;
if (indexBytes >= BASELINE_INDEX_BYTES) {
  throw new Error(
    `Initial bundle ${indexChunk} is ${indexBytes} bytes; expected strictly below ${BASELINE_INDEX_BYTES}`,
  );
}

const indexSource = await readFile(resolve(assetsDir, indexChunk), "utf8");
const templateEditorChunk = findSingleMatch(
  indexSource,
  /(?:\.\/)?(TemplateEditor-[A-Za-z0-9_-]+\.js)/g,
  "TemplateEditor",
);
const templateEditorBytes = (await stat(resolve(assetsDir, templateEditorChunk))).size;

console.log(
  `Frontend bundle budget passed: index=${indexBytes} (<${BASELINE_INDEX_BYTES}), `
  + `TemplateEditor=${templateEditorBytes} bytes.`,
);
