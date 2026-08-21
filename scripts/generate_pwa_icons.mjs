// 由 frontend/public/favicon.svg 產生 PWA 與 iOS 圖示。
//
// 為什麼要有這支：manifest 與 index.html 一直宣告 /icons/*.png，但那些檔案從來沒有
// 被產生過。SPA catch-all 對找不到的實體檔會回 index.html，所以瀏覽器拿到的是
// HTTP 200 + text/html 而不是 404——圖示解析必定失敗，而且不會有任何錯誤訊號。
//
// 為什麼用 chromium 而不是 node-canvas：favicon.svg 內含 mask、feGaussianBlur 與
// display-p3 色彩，Path2D 只畫得出外框，會丟掉整個彩色內裡。
//
// 用法：node scripts/generate_pwa_icons.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceSvgPath = resolve(repoRoot, "frontend/public/favicon.svg");
const outputDir = resolve(repoRoot, "frontend/public/icons");

// playwright 裝在 frontend/node_modules，從 repo 根目錄的腳本要顯式解析（同 parity 腳本）
const frontendRequire = createRequire(resolve(repoRoot, "frontend/package.json"));
const playwrightModule = await import(
  pathToFileURL(frontendRequire.resolve("@playwright/test")).href
);
const { chromium } = playwrightModule.default ?? playwrightModule;

// manifest 的 background_color；iOS 不處理透明背景，統一填實色。
const BACKGROUND = "#ffffff";

// maskable 圖示的安全區是中央直徑 80% 的圓，Android 會把四角裁掉。
// 512 那張在 manifest 宣告 `any maskable`，所以標記畫小一點才不會被切到。
const ICONS = [
  { filename: "icon-192x192.png", size: 192, markRatio: 0.72 },
  { filename: "icon-512x512.png", size: 512, markRatio: 0.6 },
  { filename: "apple-touch-icon.png", size: 180, markRatio: 0.72 },
];

const svgSource = await readFile(sourceSvgPath, "utf8");
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const { filename, size, markRatio } of ICONS) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><style>
         html,body{margin:0;padding:0;width:${size}px;height:${size}px;
                   background:${BACKGROUND};display:flex;
                   align-items:center;justify-content:center;overflow:hidden}
         svg{width:${Math.round(size * markRatio)}px;height:auto;display:block}
       </style></head><body>${svgSource}</body></html>`,
      { waitUntil: "load" },
    );
    const png = await page.screenshot({ type: "png" });
    await writeFile(resolve(outputDir, filename), png);
    await page.close();
    console.log(`${filename}  ${size}x${size}  ${png.length} bytes`);
  }
} finally {
  await browser.close();
}
