import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(repoRoot, "frontend");
const frontendRequire = createRequire(resolve(frontendRoot, "package.json"));
const playwrightModule = await import(
  pathToFileURL(frontendRequire.resolve("@playwright/test")).href
);
const { chromium } = playwrightModule.default ?? playwrightModule;
const konvaBrowserPath = resolve(
  dirname(frontendRequire.resolve("konva")),
  "..",
  "konva.min.js",
);
const fixturePath = process.argv[2]
  ? resolve(repoRoot, process.argv[2])
  : resolve(repoRoot, "tests/fixtures/text_layout_parity_cases.json");
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

async function measureFrontendLayouts(baseUrl) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/parity.html`, { waitUntil: "load" });
    return await page.evaluate(async testCases => {
      const {
        getTextLabelRenderModel,
        measureTextLabelRenderLayout,
      } = await import("/frontend/src/utils/textRenderModel.js");

      await Promise.all([
        document.fonts.load('400 1536px "Album Noto Sans TC"'),
        document.fonts.load('700 1536px "Album Noto Sans TC"'),
        document.fonts.load('400 1536px "Album Noto Serif TC"'),
      ]);
      if (
        !document.fonts.check('400 1536px "Album Noto Sans TC"')
        || !document.fonts.check('700 1536px "Album Noto Sans TC"')
        || !document.fonts.check('400 1536px "Album Noto Serif TC"')
      ) {
        throw new Error("Chromium 未完成 production bundled fonts 載入");
      }

      return testCases.map(testCase => {
        const textModel = getTextLabelRenderModel(testCase);
        const layout = measureTextLabelRenderLayout(
          textModel,
          window.Konva.Text,
        );
        return {
          name: testCase.name,
          fontFamily: textModel.fontFamily,
          fontStyle: textModel.fontStyle,
          fullLines: layout.fullLines,
          visibleLines: layout.visibleLines,
          lineXPositions: layout.lineXPositions,
          lineBaselines: layout.lineBaselines,
          lineHeightPx: layout.lineHeightPx,
        };
      });
    }, cases);
  } finally {
    await browser.close();
  }
}

function assertClose(actual, expected, tolerance, context) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${context}: ${actual} 與 ${expected} 差距超過 ${tolerance}`,
  );
}

const pythonResult = spawnSync(
  process.env.PYTHON || "python",
  [
    resolve(repoRoot, "scripts/measure_backend_text_layout.py"),
    fixturePath,
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
assert.equal(
  pythonResult.status,
  0,
  pythonResult.stderr || "後端文字排版 probe 執行失敗",
);
const backendByName = new Map(
  JSON.parse(pythonResult.stdout).map(result => [result.name, result]),
);

const parityServer = createParityServer();
let serverIsListening = false;
try {
  const baseUrl = await listen(parityServer);
  serverIsListening = true;
  const frontendLayouts = await measureFrontendLayouts(baseUrl);

  for (const testCase of cases) {
    const frontendLayout = frontendLayouts.find(
      result => result.name === testCase.name,
    );
    const backend = backendByName.get(testCase.name);
    assert.ok(frontendLayout, `Chromium 缺少 ${testCase.name} 排版結果`);
    assert.ok(backend, `Pillow 缺少 ${testCase.name} 排版結果`);
    assert.match(
      frontendLayout.fontFamily,
      /^"Album Noto (Sans|Serif) TC"/,
      `${testCase.name} 必須優先使用 bundled production font`,
    );
    if (testCase.font_family === "msjhbd") {
      assert.equal(frontendLayout.fontStyle, "bold");
      assert.match(backend.font_name[1], /Bold/i);
    } else {
      assert.equal(frontendLayout.fontStyle, "normal");
      assert.match(backend.font_name[1], /Regular/i);
    }

    assert.deepEqual(
      frontendLayout.fullLines,
      backend.full_lines,
      `${testCase.name} 完整換行不一致`,
    );
    assert.deepEqual(
      frontendLayout.visibleLines,
      backend.visible_lines,
      `${testCase.name} 可見行不一致`,
    );
    assert.equal(
      frontendLayout.visibleLines.length,
      Math.min(backend.max_visible_lines, backend.full_lines.length),
      `${testCase.name} 可見行數不一致`,
    );

    assert.equal(
      frontendLayout.lineXPositions.length,
      backend.line_x_positions.length,
    );
    assert.equal(
      frontendLayout.lineBaselines.length,
      backend.line_baselines.length,
    );
    for (
      let lineIndex = 0;
      lineIndex < frontendLayout.lineXPositions.length;
      lineIndex += 1
    ) {
      assertClose(
        frontendLayout.lineXPositions[lineIndex],
        backend.line_x_positions[lineIndex],
        0.25,
        `${testCase.name} line ${lineIndex + 1} x`,
      );
      assertClose(
        frontendLayout.lineBaselines[lineIndex],
        backend.line_baselines[lineIndex],
        0.25,
        `${testCase.name} line ${lineIndex + 1} baseline`,
      );
    }
    assertClose(
      frontendLayout.lineHeightPx,
      backend.line_height_px,
      0.000001,
      `${testCase.name} lineHeight`,
    );
  }

  console.log(
    `text layout parity matches for ${cases.length} production Chromium/Pillow cases`,
  );
} finally {
  if (serverIsListening) await closeServer(parityServer);
}
