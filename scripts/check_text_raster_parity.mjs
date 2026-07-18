import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(repoRoot, "frontend");
const frontendRequire = createRequire(resolve(frontendRoot, "package.json"));
const { createCanvas, loadImage } = frontendRequire("canvas");
const playwrightModule = await import(
  pathToFileURL(frontendRequire.resolve("@playwright/test")).href
);
const { chromium } = playwrightModule.default ?? playwrightModule;
const konvaEntryPath = frontendRequire.resolve("konva");
const konvaBrowserPath = resolve(dirname(konvaEntryPath), "..", "konva.min.js");
const fixturePath = resolve(
  repoRoot,
  "tests/fixtures/text_raster_parity_cases.json",
);
const outputRoot = resolve(
  repoRoot,
  ".tmp",
  `text-raster-parity-${process.pid}-${Date.now()}`,
);
const backendOutputDir = resolve(outputRoot, "backend");
const frontendOutputDir = resolve(outputRoot, "frontend");
const cases = JSON.parse(await readFile(fixturePath, "utf8"));

function isPathInside(candidatePath, allowedRoot) {
  const pathFromRoot = relative(allowedRoot, candidatePath);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function getContentType(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}

function createParityServer() {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      @font-face {
        font-family: "Album Noto Sans TC";
        src: url("/fonts/NotoSansTC-VF.woff2") format("woff2");
        font-style: normal;
        font-weight: 100 900;
        font-display: block;
      }
      @font-face {
        font-family: "Album Noto Serif TC";
        src: url("/fonts/NotoSerifTC-VF.woff2") format("woff2");
        font-style: normal;
        font-weight: 100 900;
        font-display: block;
      }
      html, body { margin: 0; background: transparent; }
    </style>
    <script src="/konva.min.js"></script>
  </head>
  <body></body>
</html>`;

  return createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/" || requestUrl.pathname === "/parity.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      let filePath;
      let allowedRoot;
      if (requestUrl.pathname === "/konva.min.js") {
        filePath = konvaBrowserPath;
        allowedRoot = dirname(konvaBrowserPath);
      } else if (requestUrl.pathname.startsWith("/frontend/")) {
        allowedRoot = frontendRoot;
        filePath = resolve(repoRoot, `.${decodeURIComponent(requestUrl.pathname)}`);
      } else if (requestUrl.pathname.startsWith("/fonts/")) {
        allowedRoot = resolve(frontendRoot, "public/fonts");
        filePath = resolve(
          allowedRoot,
          decodeURIComponent(requestUrl.pathname.slice("/fonts/".length)),
        );
      }

      if (!filePath || !isPathInside(filePath, allowedRoot)) {
        response.writeHead(404);
        response.end();
        return;
      }

      const body = await readFile(filePath);
      response.writeHead(200, { "Content-Type": getContentType(filePath) });
      response.end(body);
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
}

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((accept, reject) => {
    server.close(error => error ? reject(error) : accept());
  });
}

async function renderFrontendRasters(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/parity.html`, { waitUntil: "load" });
    const rasterResults = await page.evaluate(async testCases => {
      const {
        getTextLabelClipGroupProps,
        getTextLabelLineRenderProps,
        getTextLabelRenderModel,
        measureTextLabelRenderLayout,
      } = await import("/frontend/src/utils/textRenderModel.js");
      const {
        CANVAS_SCALE,
        toDisplayCoord,
      } = await import("/frontend/src/utils/renderLayoutModel.js");

      await Promise.all([
        document.fonts.load('400 26px "Album Noto Sans TC"'),
        document.fonts.load('700 26px "Album Noto Sans TC"'),
        document.fonts.load('400 26px "Album Noto Serif TC"'),
      ]);
      if (
        !document.fonts.check('400 26px "Album Noto Sans TC"')
        || !document.fonts.check('700 26px "Album Noto Sans TC"')
      ) {
        throw new Error("Chromium 未完成 bundled Noto Sans TC regular/bold 載入");
      }

      return testCases.map(testCase => {
        const container = document.createElement("div");
        container.style.position = "fixed";
        container.style.left = "-10000px";
        container.style.top = "0";
        document.body.append(container);

        const stage = new window.Konva.Stage({
          container,
          width: toDisplayCoord(testCase.canvas_width) + 0.001,
          height: toDisplayCoord(testCase.canvas_height) + 0.001,
        });
        const layer = new window.Konva.Layer({ listening: false });
        stage.add(layer);

        const displayWidth = toDisplayCoord(testCase.width);
        const displayHeight = toDisplayCoord(testCase.height);
        const outerGroup = new window.Konva.Group({
          x: toDisplayCoord(testCase.x) + displayWidth / 2,
          y: toDisplayCoord(testCase.y) + displayHeight / 2,
          offsetX: displayWidth / 2,
          offsetY: displayHeight / 2,
          width: displayWidth,
          height: displayHeight,
          rotation: testCase.rotation ?? 0,
          listening: false,
        });
        const textModel = getTextLabelRenderModel(testCase);
        const textLayout = measureTextLabelRenderLayout(
          textModel,
          window.Konva.Text,
        );
        const clipGroup = new window.Konva.Group(
          getTextLabelClipGroupProps(textModel),
        );
        for (
          let lineIndex = 0;
          lineIndex < textLayout.visibleLines.length;
          lineIndex += 1
        ) {
          clipGroup.add(new window.Konva.Text(
            getTextLabelLineRenderProps(textModel, textLayout, lineIndex),
          ));
        }
        outerGroup.add(clipGroup);
        layer.add(outerGroup);
        layer.draw();

        const canvas = stage.toCanvas({ pixelRatio: 1 / CANVAS_SCALE });
        const result = {
          name: testCase.name,
          width: canvas.width,
          height: canvas.height,
          pngBase64: canvas.toDataURL("image/png").split(",", 2)[1],
          fontFamily: textModel.fontFamily,
          fontStyle: textModel.fontStyle,
          visibleLines: textLayout.visibleLines,
        };
        stage.destroy();
        container.remove();
        return result;
      });
    }, cases);

    for (const rasterResult of rasterResults) {
      assert.equal(
        rasterResult.width,
        cases.find(testCase => testCase.name === rasterResult.name).canvas_width,
        `${rasterResult.name} Chromium raster width`,
      );
      assert.equal(
        rasterResult.height,
        cases.find(testCase => testCase.name === rasterResult.name).canvas_height,
        `${rasterResult.name} Chromium raster height`,
      );
      assert.match(
        rasterResult.fontFamily,
        /^"Album Noto (Sans|Serif) TC"/,
        `${rasterResult.name} 必須優先使用 bundled production font`,
      );
      await writeFile(
        resolve(frontendOutputDir, `${rasterResult.name}.png`),
        Buffer.from(rasterResult.pngBase64, "base64"),
      );
    }
    return rasterResults;
  } finally {
    await browser.close();
  }
}

async function readRaster(filePath) {
  const image = await loadImage(filePath);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    rgba: context.getImageData(0, 0, image.width, image.height).data,
  };
}

function buildRowBands(rowCounts) {
  const activeRows = [];
  for (let rowIndex = 0; rowIndex < rowCounts.length; rowIndex += 1) {
    if (rowCounts[rowIndex] >= 2) activeRows.push(rowIndex);
  }
  if (activeRows.length === 0) return [];

  const bands = [];
  let start = activeRows[0];
  let previous = activeRows[0];
  for (const rowIndex of activeRows.slice(1)) {
    if (rowIndex - previous > 2) {
      bands.push({ start, end: previous, center: (start + previous) / 2 });
      start = rowIndex;
    }
    previous = rowIndex;
  }
  bands.push({ start, end: previous, center: (start + previous) / 2 });
  return bands.filter(band => band.end - band.start >= 1);
}

function toLocalFrame(testCase, pixelX, pixelY) {
  const centerX = testCase.x + testCase.width / 2;
  const centerY = testCase.y + testCase.height / 2;
  const radians = (testCase.rotation ?? 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = pixelX - centerX;
  const deltaY = pixelY - centerY;
  return {
    x: cosine * deltaX + sine * deltaY + testCase.width / 2,
    y: -sine * deltaX + cosine * deltaY + testCase.height / 2,
  };
}

function analyzeRaster(raster, testCase, alphaThreshold = 16) {
  const mask = new Uint8Array(raster.width * raster.height);
  const rowCounts = Array(raster.height).fill(0);
  let alphaSum = 0;
  let foregroundCount = 0;
  let minimumX = raster.width;
  let minimumY = raster.height;
  let maximumX = -1;
  let maximumY = -1;
  let outsideFrameCount = 0;
  const edgeContacts = { left: 0, right: 0, top: 0, bottom: 0 };
  const clipTolerance = 1.75;

  for (let pixelY = 0; pixelY < raster.height; pixelY += 1) {
    for (let pixelX = 0; pixelX < raster.width; pixelX += 1) {
      const pixelIndex = pixelY * raster.width + pixelX;
      const alpha = raster.rgba[pixelIndex * 4 + 3];
      alphaSum += alpha;
      if (alpha < alphaThreshold) continue;

      mask[pixelIndex] = 1;
      foregroundCount += 1;
      rowCounts[pixelY] += 1;
      minimumX = Math.min(minimumX, pixelX);
      minimumY = Math.min(minimumY, pixelY);
      maximumX = Math.max(maximumX, pixelX);
      maximumY = Math.max(maximumY, pixelY);

      const local = toLocalFrame(testCase, pixelX + 0.5, pixelY + 0.5);
      if (
        local.x < -clipTolerance
        || local.x > testCase.width + clipTolerance
        || local.y < -clipTolerance
        || local.y > testCase.height + clipTolerance
      ) {
        outsideFrameCount += 1;
      }
      if (Math.abs(local.x) <= clipTolerance) edgeContacts.left += 1;
      if (Math.abs(local.x - testCase.width) <= clipTolerance) edgeContacts.right += 1;
      if (Math.abs(local.y) <= clipTolerance) edgeContacts.top += 1;
      if (Math.abs(local.y - testCase.height) <= clipTolerance) edgeContacts.bottom += 1;
    }
  }

  assert.ok(foregroundCount > 0, `${testCase.name} raster 不可為空`);
  return {
    mask,
    alphaSum,
    foregroundCount,
    bbox: {
      left: minimumX,
      top: minimumY,
      right: maximumX,
      bottom: maximumY,
    },
    rowBands: buildRowBands(rowCounts),
    outsideFrameCount,
    edgeContacts,
  };
}

function getMaskMatchRatio(source, target, width, height, radius) {
  let sourceCount = 0;
  let matchedCount = 0;
  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      const pixelIndex = pixelY * width + pixelX;
      if (!source[pixelIndex]) continue;
      sourceCount += 1;
      let isMatched = false;
      for (
        let targetY = Math.max(0, pixelY - radius);
        targetY <= Math.min(height - 1, pixelY + radius) && !isMatched;
        targetY += 1
      ) {
        for (
          let targetX = Math.max(0, pixelX - radius);
          targetX <= Math.min(width - 1, pixelX + radius);
          targetX += 1
        ) {
          if (target[targetY * width + targetX]) {
            isMatched = true;
            break;
          }
        }
      }
      if (isMatched) matchedCount += 1;
    }
  }
  return matchedCount / sourceCount;
}

function assertClose(actual, expected, tolerance, context) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${context}: ${actual} 與 ${expected} 差距超過 ${tolerance}`,
  );
}

function compareRasterStats(testCase, frontendStats, backendStats) {
  const isEffectCase = !!testCase.text_shadow_enabled || !!testCase.rotation;
  const bboxTolerance = isEffectCase ? 7 : 3;
  for (const edge of ["left", "top", "right", "bottom"]) {
    assertClose(
      frontendStats.bbox[edge],
      backendStats.bbox[edge],
      bboxTolerance,
      `${testCase.name} alpha bbox ${edge}`,
    );
  }

  if (testCase.compare_row_bands) {
    assert.equal(
      frontendStats.rowBands.length,
      backendStats.rowBands.length,
      `${testCase.name} row band 數量不一致`,
    );
    if (testCase.expected_row_band_count != null) {
      assert.equal(
        frontendStats.rowBands.length,
        testCase.expected_row_band_count,
        `${testCase.name} 可見 raster 行數不符 fixture`,
      );
    }
    for (
      let bandIndex = 0;
      bandIndex < frontendStats.rowBands.length;
      bandIndex += 1
    ) {
      const frontendBand = frontendStats.rowBands[bandIndex];
      const backendBand = backendStats.rowBands[bandIndex];
      assertClose(
        frontendBand.start,
        backendBand.start,
        3,
        `${testCase.name} row band ${bandIndex + 1} start`,
      );
      assertClose(
        frontendBand.end,
        backendBand.end,
        3,
        `${testCase.name} row band ${bandIndex + 1} end`,
      );
      assertClose(
        frontendBand.center,
        backendBand.center,
        2,
        `${testCase.name} row band ${bandIndex + 1} center`,
      );
    }
  }

  assert.ok(
    frontendStats.outsideFrameCount <= 2,
    `${testCase.name} Chromium 有 ${frontendStats.outsideFrameCount} 個框外 alpha pixels`,
  );
  assert.ok(
    backendStats.outsideFrameCount <= 2,
    `${testCase.name} Pillow 有 ${backendStats.outsideFrameCount} 個框外 alpha pixels`,
  );
  for (const edge of testCase.assert_clip_edges ?? []) {
    assert.ok(
      frontendStats.edgeContacts[edge] > 0,
      `${testCase.name} Chromium ${edge} 邊緣沒有裁切接觸像素`,
    );
    assert.ok(
      backendStats.edgeContacts[edge] > 0,
      `${testCase.name} Pillow ${edge} 邊緣沒有裁切接觸像素`,
    );
  }

  const frontendToBackend = getMaskMatchRatio(
    frontendStats.mask,
    backendStats.mask,
    testCase.canvas_width,
    testCase.canvas_height,
    isEffectCase ? 3 : 2,
  );
  const backendToFrontend = getMaskMatchRatio(
    backendStats.mask,
    frontendStats.mask,
    testCase.canvas_width,
    testCase.canvas_height,
    isEffectCase ? 3 : 2,
  );
  const minimumMaskMatch = isEffectCase ? 0.85 : 0.90;
  assert.ok(
    frontendToBackend >= minimumMaskMatch,
    `${testCase.name} Chromium→Pillow mask match ${frontendToBackend.toFixed(3)}`,
  );
  assert.ok(
    backendToFrontend >= minimumMaskMatch,
    `${testCase.name} Pillow→Chromium mask match ${backendToFrontend.toFixed(3)}`,
  );

  const alphaMassRatio = backendStats.alphaSum / frontendStats.alphaSum;
  const minimumAlphaRatio = isEffectCase ? 0.60 : 0.82;
  const maximumAlphaRatio = isEffectCase ? 1.50 : 1.20;
  assert.ok(
    alphaMassRatio >= minimumAlphaRatio && alphaMassRatio <= maximumAlphaRatio,
    `${testCase.name} alpha mass ratio ${alphaMassRatio.toFixed(3)}`,
  );

  return {
    frontendToBackend,
    backendToFrontend,
    alphaMassRatio,
  };
}

await mkdir(backendOutputDir, { recursive: true });
await mkdir(frontendOutputDir, { recursive: true });
let shouldKeepArtifacts = true;
const parityServer = createParityServer();
let serverIsListening = false;

try {
  const backendResult = spawnSync(
    process.env.PYTHON || "python",
    [
      resolve(repoRoot, "scripts/render_backend_text_rasters.py"),
      fixturePath,
      backendOutputDir,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(
    backendResult.status,
    0,
    backendResult.stderr || "後端 production text raster probe 執行失敗",
  );
  const backendRasters = new Map(
    JSON.parse(backendResult.stdout).map(result => [result.name, result]),
  );

  const baseUrl = await listen(parityServer);
  serverIsListening = true;
  const frontendRasters = await renderFrontendRasters(baseUrl);

  const statsBySideAndName = new Map();
  const comparisonSummaries = [];
  for (const testCase of cases) {
    const frontendResult = frontendRasters.find(
      result => result.name === testCase.name,
    );
    const backendResultForCase = backendRasters.get(testCase.name);
    assert.ok(frontendResult, `Chromium 缺少 ${testCase.name} raster`);
    assert.ok(backendResultForCase, `Pillow 缺少 ${testCase.name} raster`);

    const frontendRaster = await readRaster(
      resolve(frontendOutputDir, `${testCase.name}.png`),
    );
    const backendRaster = await readRaster(backendResultForCase.path);
    assert.equal(frontendRaster.width, backendRaster.width);
    assert.equal(frontendRaster.height, backendRaster.height);
    const frontendStats = analyzeRaster(frontendRaster, testCase);
    const backendStats = analyzeRaster(backendRaster, testCase);
    statsBySideAndName.set(`frontend:${testCase.name}`, frontendStats);
    statsBySideAndName.set(`backend:${testCase.name}`, backendStats);
    comparisonSummaries.push({
      name: testCase.name,
      ...compareRasterStats(testCase, frontendStats, backendStats),
    });
  }

  for (const side of ["frontend", "backend"]) {
    const regularStats = statsBySideAndName.get(`${side}:regular`);
    const boldStats = statsBySideAndName.get(`${side}:bold`);
    const weightRatio = boldStats.alphaSum / regularStats.alphaSum;
    assert.ok(
      weightRatio >= 1.12,
      `${side} bold/regular alpha mass ratio ${weightRatio.toFixed(3)}，疑似字重未生效`,
    );
  }

  for (const summary of comparisonSummaries) {
    console.log(
      `${summary.name}: mask `
      + `${summary.frontendToBackend.toFixed(3)}/`
      + `${summary.backendToFrontend.toFixed(3)}, alpha `
      + `${summary.alphaMassRatio.toFixed(3)}`,
    );
  }
  console.log(
    `text raster parity matches for ${cases.length} production Chromium/Pillow cases`,
  );
  shouldKeepArtifacts = false;
} catch (error) {
  console.error(`text raster parity artifacts: ${outputRoot}`);
  throw error;
} finally {
  if (serverIsListening) await closeServer(parityServer);
  if (!shouldKeepArtifacts) {
    await rm(outputRoot, { recursive: true, force: true });
  }
}
