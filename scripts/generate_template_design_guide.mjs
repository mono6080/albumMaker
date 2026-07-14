import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(resolve(repoRoot, "frontend/package.json"));
const playwright = (await import(pathToFileURL(frontendRequire.resolve("@playwright/test")).href)).default;
const { chromium } = playwright;
const docsDir = resolve(repoRoot, "docs");
const assetDir = resolve(docsDir, "assets/template-guide");
const htmlPath = resolve(docsDir, "template-design-guide-print.html");
const pdfPath = resolve(docsDir, "template-design-guide-step-by-step-dom.pdf");
const targetMetaPath = resolve(assetDir, "guide-targets.json");
const baseUrl = "http://127.0.0.1:5173";
const apiUrl = "http://127.0.0.1:8765/api";
const adminPassword = process.env.GUIDE_ADMIN_PASSWORD ?? "admin";

const realToDisplay = value => Math.round(value * 530 / 794);
const roundPercent = value => Math.round(value * 100) / 100;
const clampPercent = value => Math.max(0, Math.min(100, value));

function docsRelative(filePath) {
  return relative(docsDir, filePath).replaceAll("\\", "/");
}

async function requireOk(response, label) {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
  return response;
}

async function createBackgroundImage(browser) {
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  await page.setContent(`
    <html>
      <body style="margin:0;width:794px;height:1123px;background:#fff7ed;font-family:'Microsoft JhengHei',sans-serif;">
        <div style="position:absolute;inset:0;background:
          radial-gradient(circle at 15% 15%, rgba(255,209,220,.9), transparent 18%),
          radial-gradient(circle at 85% 20%, rgba(200,230,255,.9), transparent 22%),
          radial-gradient(circle at 25% 82%, rgba(181,213,197,.85), transparent 20%),
          linear-gradient(135deg,#fff7ed 0%,#f8fafc 55%,#eef2ff 100%);"></div>
        <div style="position:absolute;left:56px;right:56px;top:54px;height:92px;border:4px solid #f59e0b;border-radius:28px;background:rgba(255,255,255,.72);"></div>
        <div style="position:absolute;left:76px;top:78px;font-size:38px;font-weight:700;color:#334155;">感官世界探索</div>
        <div style="position:absolute;left:76px;top:124px;font-size:18px;color:#64748b;">template sample background</div>
        <div style="position:absolute;right:72px;bottom:54px;font-size:20px;color:#64748b;">幼兒園相本</div>
        ${Array.from({ length: 36 }, (_, i) => {
          const x = 40 + (i * 83) % 720;
          const y = 190 + (i * 137) % 820;
          const color = ["#fbbf24", "#60a5fa", "#34d399", "#fb7185"][i % 4];
          return `<div style="position:absolute;left:${x}px;top:${y}px;width:12px;height:12px;border-radius:50%;background:${color};opacity:.5;"></div>`;
        }).join("")}
      </body>
    </html>
  `);
  const backgroundPath = resolve(assetDir, "source-background.png");
  await page.screenshot({ path: backgroundPath });
  await page.close();
  return backgroundPath;
}

async function createDemoTemplate(context, backgroundPath) {
  await requireOk(
    await context.request.post(`${apiUrl}/auth/login`, {
      form: { username: "admin", password: adminPassword },
    }),
    "login",
  );

  const templateName = "2026-05 中班 感官世界";
  const templateResponse = await requireOk(
    await context.request.post(`${apiUrl}/templates/`, {
      form: { name: templateName },
    }),
    "create template",
  );
  const template = await templateResponse.json();

  async function addPage(pageNumber) {
    const pageResponse = await requireOk(
      await context.request.post(`${apiUrl}/templates/${template.id}/pages`),
      `create page ${pageNumber}`,
    );
    const pageInfo = await pageResponse.json();
    const uploadResponse = await requireOk(
      await context.request.post(`${apiUrl}/templates/${template.id}/pages/${pageInfo.id}/background`, {
        multipart: {
          file: {
            name: `guide-background-${pageNumber}.png`,
            mimeType: "image/png",
            buffer: await readFile(backgroundPath),
          },
        },
      }),
      `upload background ${pageNumber}`,
    );
    const upload = await uploadResponse.json();
    return { ...pageInfo, backgroundFilename: upload.filename };
  }

  const page1 = await addPage(1);
  const page2 = await addPage(2);

  const page1Layout = {
    canvas_width: 794,
    canvas_height: 1123,
    background_filename: page1.backgroundFilename,
    photo_slots: [
      { id: 1, x: 68, y: 188, width: 260, height: 210, border: true, border_width: 8, border_radius: 16, rotation: -3, z_index: 10 },
      { id: 2, x: 452, y: 172, width: 255, height: 330, border: true, border_width: 8, border_radius: 16, rotation: 4, z_index: 11 },
      { id: 3, x: 112, y: 520, width: 240, height: 180, border: true, border_width: 8, border_radius: 14, rotation: 2, z_index: 12 },
    ],
    text_labels: [
      {
        id: 1, x: 84, y: 760, width: 620, height: 110, text: "{name} 的感官探索紀錄",
        font_size: 32, font_family: "msjhbd", font_color: "#1F2937", text_align: "center", line_height: 1.25,
        text_shadow_enabled: true, text_shadow_color: "#FFFFFF", text_shadow_opacity: 210,
        text_shadow_offset_x: 2, text_shadow_offset_y: 2, text_shadow_blur: 3, z_index: 40,
      },
    ],
    stickers: [],
    footer: { text: "2026-05 · 中班 · 感官世界", x: 60, y: 1068, font_size: 18, font_color: "#64748B" },
    logo: null,
  };

  const page2Layout = {
    ...page1Layout,
    background_filename: page2.backgroundFilename,
    photo_slots: [
      { id: 1, x: 82, y: 190, width: 280, height: 230, border: true, border_width: 8, border_radius: 18, rotation: 0, z_index: 10 },
      { id: 2, x: 420, y: 205, width: 250, height: 190, border: true, border_width: 8, border_radius: 18, rotation: -4, z_index: 11 },
      { id: 3, x: 106, y: 510, width: 260, height: 205, border: true, border_width: 8, border_radius: 18, rotation: 3, z_index: 12 },
      { id: 4, x: 430, y: 510, width: 250, height: 205, border: true, border_width: 8, border_radius: 18, rotation: 0, z_index: 13 },
    ],
    text_labels: [
      {
        id: 1, x: 110, y: 780, width: 570, height: 98, text: "今天我最喜歡的活動是：",
        font_size: 30, font_family: "msjhbd", font_color: "#1F2937", text_align: "center", line_height: 1.25, z_index: 40,
      },
    ],
    footer: { text: "觀察 · 探索 · 分享", x: 60, y: 1068, font_size: 18, font_color: "#64748B" },
  };

  await requireOk(
    await context.request.put(`${apiUrl}/templates/${template.id}/pages/${page1.id}/layout`, { data: page1Layout }),
    "save page 1 layout",
  );
  await requireOk(
    await context.request.put(`${apiUrl}/templates/${template.id}/pages/${page2.id}/layout`, { data: page2Layout }),
    "save page 2 layout",
  );

  return { templateId: template.id, templateName };
}

function percentBox(rawBox, viewport, padding = 4) {
  const paddedX = Math.max(0, rawBox.x - padding);
  const paddedY = Math.max(0, rawBox.y - padding);
  const paddedRight = Math.min(viewport.width, rawBox.x + rawBox.width + padding);
  const paddedBottom = Math.min(viewport.height, rawBox.y + rawBox.height + padding);

  return {
    x: roundPercent(clampPercent(paddedX / viewport.width * 100)),
    y: roundPercent(clampPercent(paddedY / viewport.height * 100)),
    width: roundPercent(clampPercent((paddedRight - paddedX) / viewport.width * 100)),
    height: roundPercent(clampPercent((paddedBottom - paddedY) / viewport.height * 100)),
  };
}

async function resolveTargetBox(page, marker) {
  if (marker.box) return marker.box;

  const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
  let rawBox = null;

  if (marker.selector) {
    rawBox = await page.locator(marker.selector).first().boundingBox();
  } else if (marker.relativeTo && marker.rect) {
    const baseBox = await page.locator(marker.relativeTo).first().boundingBox();
    if (baseBox) {
      rawBox = {
        x: baseBox.x + marker.rect.x,
        y: baseBox.y + marker.rect.y,
        width: marker.rect.width,
        height: marker.rect.height,
      };
    }
  }

  return rawBox ? percentBox(rawBox, viewport, marker.padding ?? 4) : null;
}

async function resolveMarkers(page, markers) {
  const resolved = [];
  for (const marker of markers) {
    const box = await resolveTargetBox(page, marker);
    if (box) {
      resolved.push({ n: marker.n, text: marker.text, box });
    }
  }
  return resolved;
}

async function screenshot(page, name, options = {}) {
  const { markers = [], ...screenshotOptions } = options;
  const target = resolve(assetDir, name);
  const resolvedMarkers = await resolveMarkers(page, markers);
  await page.screenshot({ path: target, fullPage: false, ...screenshotOptions });
  return { path: target, markers: resolvedMarkers };
}

async function screenshotsFromDisk() {
  let targetMeta = {};
  try {
    targetMeta = JSON.parse(await readFile(targetMetaPath, "utf8"));
  } catch {
    targetMeta = {};
  }

  const imagePaths = {
    list: "01-template-list.png",
    editor: "02-editor-overview.png",
    pages: "03-page-tools.png",
    photoTool: "04-photo-tool.png",
    photo: "05-photo-properties.png",
    textContent: "06-text-content.png",
    text: "07-text-shadow.png",
    spread: "08-spread-preview.png",
  };

  return Object.fromEntries(
    Object.entries(imagePaths).map(([key, fileName]) => [
      key,
      {
        path: resolve(assetDir, fileName),
        markers: targetMeta[key] ?? [],
      },
    ]),
  );
}

function screenshotTargetMeta(screenshots) {
  return Object.fromEntries(
    Object.entries(screenshots).map(([key, image]) => [key, image.markers ?? []]),
  );
}

function imagePathOf(image) {
  return typeof image === "string" ? image : image.path;
}

function markerBoxStyle(box) {
  return `left:${box.x}%;top:${box.y}%;width:${box.width}%;height:${box.height}%;`;
}

function stepFigure(image, caption, markers = image.markers ?? []) {
  const imagePath = imagePathOf(image);
  const markerFigures = markers.map(marker => `
    <figure class="shot">
      <div class="shot-frame">
        <img src="${docsRelative(imagePath)}" alt="${caption}">
        <div class="target-box" style="${markerBoxStyle(marker.box)}"></div>
      </div>
      <figcaption>
        <span class="legend-num">${marker.n}</span>
        <span>${marker.text}</span>
      </figcaption>
    </figure>
  `).join("");

  return `
    <div class="shot-set">
      <p class="shot-caption">${caption}</p>
      ${markerFigures}
    </div>
  `;
}

const CANVAS_TARGETS = {
  photoSlot1: {
    x: realToDisplay(68),
    y: realToDisplay(188),
    width: realToDisplay(260),
    height: realToDisplay(210),
  },
  textLabel1: {
    x: realToDisplay(84),
    y: realToDisplay(760),
    width: realToDisplay(620),
    height: realToDisplay(110),
  },
  addPhotoPoint: {
    x: realToDisplay(160),
    y: realToDisplay(240),
    width: realToDisplay(150),
    height: realToDisplay(120),
  },
};

const GUIDE_MARKERS = {
  list: [
    { n: 1, selector: '[data-guide="template-name-input"]', text: "模板名稱輸入框。固定使用 YYYY-MM {年級} {主題名稱}。" },
    { n: 2, selector: '[data-guide="template-create-button"]', text: "建立按鈕。點擊後會建立一份空模板。" },
    { n: 3, selector: '[data-guide="template-card"]', text: "新模板卡片。確認你要編輯的是最新建立的模板。" },
    { n: 4, selector: '[data-guide="template-card-counts"]', text: "頁數與照片數。完成前要與企劃需求一致。" },
    { n: 5, selector: '[data-guide="template-edit-link"]', text: "編輯模板入口。點進去開始放背景、照片格與文字。" },
  ],
  editor: [
    { n: 1, selector: '[data-guide="tool-panel"]', text: "工具列。先選工具，再到畫布操作。" },
    { n: 2, selector: '[data-guide="template-photo-count"]', text: "照片總計。用來核對整份模板的照片格數量。" },
    { n: 3, selector: '[data-guide="canvas-frame"]', text: "A4 畫布。背景、照片格、文字與貼圖都在這裡排版。" },
    { n: 4, selector: '[data-guide="top-actions"]', text: "製作教學、復原、重做、雙頁預覽、儲存。這些是製作時最常用的操作。" },
    { n: 5, selector: '[data-guide="property-region"]', text: "屬性面板。點選不同元素後，這裡會顯示對應設定。" },
  ],
  pages: [
    { n: 1, selector: '[data-guide="upload-background"]', text: "上傳背景。每一頁都要各自上傳對應背景。" },
    { n: 2, selector: '[data-guide="page-list"]', text: "頁面列表。切換不同頁面後，再編輯該頁內容。" },
    { n: 3, selector: '[data-guide="add-page"]', text: "新增頁。頁數不足時從這裡補頁。" },
    { n: 4, selector: '[data-guide="template-photo-count"]', text: "照片總計。切換頁面後也會維持整份模板統計。" },
  ],
  photoTool: [
    { n: 1, selector: '[data-guide="tool-add-photo"]', text: "照片格工具。選取後會保持在新增照片格模式。" },
    { n: 2, relativeTo: '[data-guide="canvas-frame"]', rect: CANVAS_TARGETS.addPhotoPoint, text: "畫布點擊位置。每點一次會新增一個照片格。" },
    { n: 3, selector: '[data-guide="template-photo-count"]', text: "照片總計。新增後要用這裡核對總數。" },
    { n: 4, selector: '[data-guide="tool-select"]', text: "調整照片格前切回選取工具，避免誤新增。" },
  ],
  photo: [
    { n: 1, relativeTo: '[data-guide="canvas-frame"]', rect: CANVAS_TARGETS.photoSlot1, text: "照片格選取框。被選取的元素會出現藍色框與控制點。" },
    { n: 2, selector: '[data-guide="property-position-size"]', text: "位置與尺寸。可直接輸入數字，方便對齊多個照片格。" },
    { n: 3, selector: '[data-guide="flip-size"]', padding: 3, text: "翻轉長寬。快速把橫式格改成直式格，或反過來。" },
    { n: 4, selector: '[data-guide="photo-visual-style"]', text: "外框、圓角、陰影。用來控制照片放進來後的視覺效果。" },
  ],
  textContent: [
    { n: 1, selector: '[data-guide="tool-add-text"]', text: "純文字工具。新增標題、日期、頁尾等可替換文字。" },
    { n: 2, relativeTo: '[data-guide="canvas-frame"]', rect: CANVAS_TARGETS.textLabel1, text: "文字框位置。新增後切回選取工具，再點文字框調整內容。" },
    { n: 3, selector: '[data-guide="text-content"]', text: "文字內容輸入框。固定文案和 {name} 都在這裡編輯。" },
    { n: 4, selector: '[data-guide="text-content-insert-name"]', padding: 3, text: "插入 {name}。點一下就會在游標位置插入姓名變數。" },
  ],
  text: [
    { n: 1, relativeTo: '[data-guide="canvas-frame"]', rect: CANVAS_TARGETS.textLabel1, text: "被選取的文字框。可拖曳位置，也可調整寬高。" },
    { n: 2, selector: '[data-guide="text-font-picker"]', text: "字體與字級。先把文字大小調到版面合適。" },
    { n: 3, selector: '[data-guide="text-color"]', text: "文字顏色。先選主文字顏色，再決定陰影顏色。" },
    { n: 4, selector: '[data-guide="text-shadow-controls"]', text: "文字陰影開關。勾選後才會顯示陰影細項。" },
    { n: 5, selector: '[data-guide="text-shadow-controls"]', text: "偏移與模糊。數值過大會讓文字變糊，交付前要檢查。" },
  ],
  spread: [
    { n: 1, selector: '[data-guide="spread-page-range"]', text: "頁碼範圍。確認目前看的是第幾頁到第幾頁。" },
    { n: 2, selector: '[data-guide="spread-preview-image"]', text: "左右頁合併預覽。用這裡檢查整體節奏。" },
    { n: 3, selector: '[data-guide="spread-prev"]', text: "上一組。回到前兩頁做比較。" },
    { n: 4, selector: '[data-guide="spread-next"]', text: "下一組。查看後兩頁。" },
    { n: 5, selector: '[data-guide="spread-close"]', text: "關閉。檢查完回到編輯器繼續調整。" },
  ],
};

async function buildPdf(screenshots) {
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>設計組模板製作使用教學</title>
  <style>
    @page { size: A4; margin: 14mm 13mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1f2937; font-family: "Microsoft JhengHei", "Noto Sans CJK TC", Arial, sans-serif; line-height: 1.55; }
    h1 { font-size: 30px; margin: 0 0 10px; color: #111827; }
    h2 { font-size: 19px; margin: 18px 0 8px; color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 4px; }
    h3 { font-size: 14px; margin: 12px 0 6px; color: #374151; }
    p, li { font-size: 11.2px; }
    ul, ol { padding-left: 20px; }
    .cover { min-height: 245mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
    .eyebrow { color: #4f46e5; font-size: 13px; font-weight: 700; letter-spacing: .04em; margin-bottom: 12px; }
    .subtitle { font-size: 16px; color: #4b5563; max-width: 620px; }
    .meta { margin-top: 24px; color: #6b7280; font-size: 11px; }
    .toc { margin-top: 30px; padding: 16px 18px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; }
    .toc li { margin: 4px 0; }
    .page-break { page-break-before: always; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .note { padding: 10px 12px; background: #fff7ed; border-left: 4px solid #f59e0b; font-size: 11.5px; margin: 10px 0; }
    .checklist li { margin-bottom: 4px; }
    .step-intro { margin: 0 0 8px; color: #475569; }
    .actions { margin-top: 6px; margin-bottom: 10px; }
    .actions li { margin-bottom: 3px; }
    .shot-set { margin: 10px 0 16px; }
    .shot-caption { margin: 0 0 8px; font-size: 10.5px; color: #64748b; }
    .shot { margin: 10px 0 14px; page-break-inside: avoid; }
    .shot-frame { position: relative; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; background: #f8fafc; }
    .shot img { display: block; width: 100%; height: auto; }
    .target-box { position: absolute; border: 3px solid #dc2626; border-radius: 8px; box-shadow: 0 0 0 2px rgba(255,255,255,.92), 0 0 0 5px rgba(220,38,38,.18); pointer-events: none; }
    figcaption { display: flex; align-items: flex-start; gap: 6px; font-size: 10.8px; color: #334155; margin-top: 6px; padding: 7px 9px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; }
    .legend-num { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 999px; background: #dc2626; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; font-size: 10px; line-height: 1; }
    .kbd { font-family: Consolas, monospace; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px; padding: 1px 4px; }
    .small { font-size: 10.5px; color: #64748b; }
  </style>
</head>
<body>
  <section class="cover">
    <div class="eyebrow">ALBUM MAKER · DESIGN TEAM GUIDE</div>
    <h1>設計組模板製作使用教學</h1>
    <p class="subtitle">給負責版型與美術素材的設計人員使用。這份 PDF 以實際系統截圖說明如何建立模板、放置照片格、設定文字、使用雙頁預覽，並在交付前完成檢查。</p>
    <p class="meta">產出檔案：<strong>${docsRelative(pdfPath)}</strong><br>建議搭配系統中的「模板編輯器」同步操作。</p>
    <div class="toc">
      <h3>快速目錄</h3>
      <ol>
        <li>建立模板並確認照片總計</li>
        <li>進入模板編輯器並認識工作區</li>
        <li>設定頁面、背景與新增頁</li>
        <li>連續新增照片格</li>
        <li>調整照片格與翻轉長寬</li>
        <li>新增文字與姓名變數</li>
        <li>設定文字陰影</li>
        <li>用雙頁預覽檢查左右頁</li>
        <li>交付前檢查表</li>
      </ol>
    </div>
  </section>

  <section>
    <h2>1. 建立模板並確認照片總計</h2>
    <p class="step-intro">先在模板管理建立一個新的模板。模板卡片會顯示頁數與照片總數，設計完成前要用這裡確認規格是否正確。</p>
    <ol class="actions">
      <li>在「模板管理」輸入模板名稱，格式固定為 <span class="kbd">YYYY-MM {年級} {主題名稱}</span>，例如 <span class="kbd">2026-05 中班 感官世界</span>。</li>
      <li>點「建立」後，系統會新增一張模板卡片。</li>
      <li>看卡片上的「頁」與「張照片」數字，這是交付前檢查照片格數量的第一個位置。</li>
      <li>點「編輯模板」進入模板編輯器。</li>
    </ol>
    ${stepFigure(screenshots.list, "步驟 1：模板管理頁的建立入口與模板卡片。")}
  </section>

  <section class="page-break">
    <h2>2. 進入模板編輯器並認識工作區</h2>
    <p class="step-intro">模板編輯器是主要工作區。製作順序建議固定為：頁面與背景、照片格、文字、貼圖、雙頁預覽、儲存。</p>
    <ol class="actions">
      <li>左側選工具與切換頁面；中央畫布負責排版；右側面板負責精準調整。</li>
      <li>上方「照片總計」會統計整份模板，不只目前頁面。</li>
      <li>做大幅調整前可以用「復原 / 重做」，完成一段後按「儲存」。</li>
    </ol>
    ${stepFigure(screenshots.editor, "步驟 2：模板編輯器主要區塊。")}
  </section>

  <section class="page-break">
    <h2>3. 設定頁面、背景與新增頁</h2>
    <p class="step-intro">每一頁都要有自己的背景。背景建議使用 A4 直式比例，避免重要圖案太靠近邊界。</p>
    <ol class="actions">
      <li>在左側「素材」點「上傳背景」，選擇該頁背景圖。</li>
      <li>在裁切視窗調整背景位置與縮放，讓主要圖案完整落在 A4 範圍。</li>
      <li>在左側「頁面」切換第 1 頁、第 2 頁；需要更多頁時點「新增頁」。</li>
      <li>背景不要直接寫死學生姓名；會變動的姓名用文字元素 <span class="kbd">{name}</span>。</li>
    </ol>
    ${stepFigure(screenshots.pages, "步驟 3：頁面、背景與新增頁的位置。")}
  </section>

  <section class="page-break">
    <h2>4. 連續新增照片格</h2>
    <p class="step-intro">照片格是老師之後放照片的位置。現在選一次「照片格」後，可以在畫布上連續點擊新增，不需要每新增一個就重新選工具。</p>
    <ol class="actions">
      <li>左側工具選「照片格」。</li>
      <li>在畫布上點擊要放照片的位置，點一次新增一個照片格。</li>
      <li>同一頁需要多張照片時，繼續在畫布上點擊即可。</li>
      <li>照片格放完後，切回「選取」再開始調整位置與尺寸。</li>
    </ol>
    ${stepFigure(screenshots.photoTool, "步驟 4：選擇照片格工具並在畫布連續新增。")}
    <div class="note">建議：照片格先粗放位置，再一次選取調整尺寸與旋轉。這樣比每放一格就精修更快。</div>
  </section>

  <section class="page-break">
    <h2>5. 調整照片格與翻轉長寬</h2>
    <p class="step-intro">照片格選取後，可以用畫布拖曳快速調整，也可以用右側屬性面板輸入精準數字。</p>
    <ol class="actions">
      <li>切回「選取」，點照片格。</li>
      <li>拖曳照片格移動位置；拖曳角落調整大小；拖曳上方圓點旋轉。</li>
      <li>右側 X / Y / 寬 / 高適合做精準對齊。</li>
      <li>需要直式與橫式互換時，點「翻轉長寬」，系統會直接交換寬高。</li>
      <li>最後調整外框、圓角與陰影，讓照片格在背景上清楚可見。</li>
    </ol>
    ${stepFigure(screenshots.photo, "步驟 5：照片格選取框與右側屬性面板。")}
  </section>

  <section class="page-break">
    <h2>6. 新增文字與姓名變數</h2>
    <p class="step-intro">純文字適合標題、日期、頁尾、短句與說明文字。需要自動帶入學生姓名時，請使用 <span class="kbd">{name}</span>。</p>
    <ol class="actions">
      <li>左側工具選「純文字」。</li>
      <li>在畫布上點擊新增文字框。</li>
      <li>切回「選取」後點文字框，右側會出現文字屬性。</li>
      <li>文字內容可輸入固定文案，也可使用 <span class="kbd">{name}</span> 代入學生姓名。</li>
      <li>點「插入 {name}」可在目前游標位置一鍵插入姓名變數；選取文字時會直接取代選取範圍。</li>
      <li>標題文字建議先確認是否會超出文字框，再調整字級與行距。</li>
    </ol>
    ${stepFigure(screenshots.textContent, "步驟 6：文字內容與姓名變數插入。")}
  </section>

  <section class="page-break">
    <h2>7. 設定文字陰影</h2>
    <p class="step-intro">背景較花、顏色較淡或文字壓在照片附近時，建議開啟文字陰影。陰影要讓文字更清楚，不要搶過文字本身。</p>
    <ol class="actions">
      <li>選取文字框。</li>
      <li>在右側確認字體、字級、顏色與對齊。</li>
      <li>勾選「文字陰影」。</li>
      <li>調整陰影顏色、偏移 X/Y、模糊與不透明度。一般建議偏移 1 到 3、模糊 2 到 4。</li>
      <li>確認陰影在背景上清楚，但不會讓字看起來髒或太重。</li>
    </ol>
    ${stepFigure(screenshots.text, "步驟 7：文字屬性與文字陰影設定。")}
  </section>

  <section class="page-break">
    <h2>8. 用雙頁預覽檢查左右頁</h2>
    <p class="step-intro">單頁排好不代表整本好看。雙頁預覽可以看到左右頁放在一起的節奏、留白、照片數與主色是否平衡。</p>
    <ol class="actions">
      <li>點右上角「雙頁預覽」。</li>
      <li>系統會先儲存目前草稿，再開啟左右頁合併預覽。</li>
      <li>檢查左右頁照片數、主色、字級、留白、元素密度是否平衡。</li>
      <li>使用「上一組」「下一組」切換第 1-2 頁、第 3-4 頁。</li>
      <li>最後一頁若沒有下一頁，右側會以空白頁補齊。</li>
    </ol>
    ${stepFigure(screenshots.spread, "步驟 8：雙頁預覽檢查左右頁效果。")}
  </section>

  <section class="page-break">
    <h2>9. 交付前檢查表</h2>
    <div class="grid">
      <ul class="checklist">
        <li>□ 模板名稱正確，格式為 YYYY-MM {年級} {主題名稱}。</li>
        <li>□ 每頁背景都已上傳。</li>
        <li>□ 照片總計符合企劃需求。</li>
        <li>□ 每個照片格尺寸、位置、旋轉角度合理。</li>
        <li>□ 純文字沒有超出框線。</li>
        <li>□ 需要帶學生姓名的地方都有使用 {name}。</li>
      </ul>
      <ul class="checklist">
        <li>□ 文字顏色與背景對比足夠。</li>
        <li>□ 文字陰影不會太重或太模糊。</li>
        <li>□ 貼圖沒有遮住照片格主要區域。</li>
        <li>□ 層次正確，文字不會被照片或貼圖蓋住。</li>
        <li>□ 已用雙頁預覽檢查每組左右頁。</li>
        <li>□ 最後已按「儲存」。</li>
      </ul>
    </div>
    <h2>常見問題</h2>
    <h3>照片總計不對</h3>
    <p>逐頁檢查是否多放或少放照片格。刪除多餘照片格後記得儲存。</p>
    <h3>背景看起來被裁掉</h3>
    <p>重新上傳背景，在裁切視窗調整位置與縮放。背景原圖若不是 A4 比例，一定會有局部裁切。</p>
    <h3>文字在背景上不清楚</h3>
    <p>調整文字顏色、位置或字級，必要時開啟文字陰影。</p>
    <h3>照片格方向放反</h3>
    <p>選取照片格，在右側「位置與尺寸」點「翻轉長寬」。</p>
    <p class="small">本文件由本機系統截圖產生，截圖素材位於 docs/assets/template-guide/。</p>
  </section>
</body>
</html>`;

  await writeFile(htmlPath, html, "utf8");

  let browser;
  let writtenPdfPath = pdfPath;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30000 });
    const pdfOptions = {
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 60000,
    };
    try {
      await page.pdf({ path: pdfPath, ...pdfOptions });
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
      writtenPdfPath = resolve(docsDir, "template-design-guide-step-by-step-dom-fallback.pdf");
      await page.pdf({ path: writtenPdfPath, ...pdfOptions });
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  return writtenPdfPath;
}

async function main() {
  await mkdir(assetDir, { recursive: true });

  if (process.argv.includes("--pdf-only")) {
    const writtenPdfPath = await buildPdf(await screenshotsFromDisk());
    console.log(`PDF written to ${writtenPdfPath}`);
    console.log(`HTML source written to ${htmlPath}`);
    return;
  }

  let browser;
  let context;
  let templateId;
  let screenshots;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1,
    });

    const backgroundPath = await createBackgroundImage(browser);
    const demoTemplate = await createDemoTemplate(context, backgroundPath);
    templateId = demoTemplate.templateId;
    const { templateName } = demoTemplate;
    const page = await context.newPage();

    await page.goto("/templates");
    await page.getByText(templateName).waitFor();
    await page.getByRole("button", { name: "建立模板" }).click();
    await page.locator('[data-guide="template-name-input"]').waitFor();
    const list = await screenshot(page, "01-template-list.png", { markers: GUIDE_MARKERS.list });

    await page.goto(`/templates/${templateId}/edit`);
    await page.getByText("模板編輯器").waitFor();
    await page.locator(".konvajs-content canvas").first().waitFor();
    const editor = await screenshot(page, "02-editor-overview.png", { markers: GUIDE_MARKERS.editor });
    const pages = await screenshot(page, "03-page-tools.png", { markers: GUIDE_MARKERS.pages });

    const canvas = page.locator(".konvajs-content canvas").first();
    await page.getByRole("button", { name: "＋ 照片格 3:4 直式", exact: true }).click();
    const photoTool = await screenshot(page, "04-photo-tool.png", { markers: GUIDE_MARKERS.photoTool });
    await page.getByRole("button", { name: "↖ 選取", exact: true }).click();
    await canvas.click({ position: { x: realToDisplay(198), y: realToDisplay(292) } });
    await page.getByText("照片格屬性").waitFor();
    const photo = await screenshot(page, "05-photo-properties.png", { markers: GUIDE_MARKERS.photo });

    await page.getByRole("button", { name: "↖ 選取", exact: true }).click();
    await canvas.click({ position: { x: realToDisplay(390), y: realToDisplay(816) } });
    await page.getByText("純文字屬性").waitFor();
    const textContent = await screenshot(page, "06-text-content.png", { markers: GUIDE_MARKERS.textContent });
    await page.getByText("文字陰影").scrollIntoViewIfNeeded();
    const text = await screenshot(page, "07-text-shadow.png", { markers: GUIDE_MARKERS.text });

    const spreadResponse = page.waitForResponse(response => (
      response.url().includes(`/templates/${templateId}/spread-preview/`) && response.status() === 200
    ));
    await page.getByRole("button", { name: "雙頁預覽" }).click();
    await page.getByRole("dialog", { name: "雙頁預覽" }).waitFor();
    await spreadResponse;
    await page.locator('img[alt="雙頁合併預覽"]').waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const img = document.querySelector('img[alt="雙頁合併預覽"]');
      return img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    });
    const spread = await screenshot(page, "08-spread-preview.png", { markers: GUIDE_MARKERS.spread });
    screenshots = { list, editor, pages, photoTool, photo, textContent, text, spread };
  } finally {
    if (context && templateId) {
      await context.request.delete(`${apiUrl}/templates/${templateId}`).catch(() => {});
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  await writeFile(targetMetaPath, JSON.stringify(screenshotTargetMeta(screenshots), null, 2), "utf8");
  const writtenPdfPath = await buildPdf(screenshots);

  console.log(`PDF written to ${writtenPdfPath}`);
  console.log(`HTML source written to ${htmlPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
