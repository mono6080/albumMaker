import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(resolve(repoRoot, "frontend/package.json"));
const playwright = (await import(pathToFileURL(frontendRequire.resolve("@playwright/test")).href)).default;
const { chromium } = playwright;

const docsDir = resolve(repoRoot, "docs");
const assetDir = resolve(docsDir, "assets/teacher-guide");
const htmlPath = resolve(docsDir, "teacher-album-guide.html");
const pdfPath = resolve(docsDir, "teacher-album-guide-step-by-step.pdf");
const targetMetaPath = resolve(assetDir, "guide-targets.json");
const baseUrl = "http://127.0.0.1:5173";
const apiUrl = "http://127.0.0.1:8765/api";
const adminPassword = "admin";
const teacherPassword = "teacher-guide-123";
const A4_WIDTH = 794;
const A4_HEIGHT = 1123;
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
  } else if (marker.relativeTo && (marker.rect || marker.templateRect)) {
    const baseBox = await page.locator(marker.relativeTo).first().boundingBox();
    if (baseBox) {
      if (marker.templateRect) {
        rawBox = {
          x: baseBox.x + marker.templateRect.x * baseBox.width / A4_WIDTH,
          y: baseBox.y + marker.templateRect.y * baseBox.height / A4_HEIGHT,
          width: marker.templateRect.width * baseBox.width / A4_WIDTH,
          height: marker.templateRect.height * baseBox.height / A4_HEIGHT,
        };
      } else {
        rawBox = {
          x: baseBox.x + marker.rect.x,
          y: baseBox.y + marker.rect.y,
          width: marker.rect.width,
          height: marker.rect.height,
        };
      }
    }
  }
  return rawBox ? percentBox(rawBox, viewport, marker.padding ?? 4) : null;
}

async function resolveMarkers(page, markers) {
  const resolved = [];
  for (const marker of markers) {
    const box = await resolveTargetBox(page, marker);
    if (box) resolved.push({ n: marker.n, text: marker.text, box });
  }
  return resolved;
}

async function screenshot(page, name, markers = []) {
  const target = resolve(assetDir, name);
  const resolvedMarkers = await resolveMarkers(page, markers);
  await page.screenshot({ path: target, fullPage: false });
  return { path: target, markers: resolvedMarkers };
}

async function waitForPreviewImage(page, selector = '[data-guide="student-page-preview"] img') {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(
    imageSelector => {
      const image = document.querySelector(imageSelector);
      return image && image.complete && image.naturalWidth > 0;
    },
    selector,
    { timeout: 30000 },
  );
  await page.waitForTimeout(250);
}

function markerBoxStyle(box) {
  return `left:${box.x}%;top:${box.y}%;width:${box.width}%;height:${box.height}%;`;
}

function imageDataUri(filePath) {
  const mimeType = filePath.toLowerCase().endsWith(".jpg") || filePath.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";
  return `data:${mimeType};base64,${readFileSync(filePath).toString("base64")}`;
}

function stepFigure(image, caption) {
  const markerFigures = (image.markers ?? []).map(marker => `
    <figure class="shot">
      <div class="shot-frame">
        <img src="${imageDataUri(image.path)}" alt="${caption}">
        <div class="target-box" style="${markerBoxStyle(marker.box)}"></div>
      </div>
      <figcaption><span class="legend-num">${marker.n}</span><span>${marker.text}</span></figcaption>
    </figure>
  `).join("");

  return `
    <div class="shot-set">
      <p class="shot-caption">${caption}</p>
      ${markerFigures}
    </div>
  `;
}

async function createGuideImage(browser, name, title, paletteIndex) {
  const colors = [
    ["#EFF6FF", "#FDE68A", "#93C5FD", "#FCA5A5"],
    ["#F0FDF4", "#BBF7D0", "#FDBA74", "#C4B5FD"],
    ["#FFF7ED", "#FED7AA", "#86EFAC", "#F9A8D4"],
  ][paletteIndex % 3];
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  await page.setContent(`
    <html>
      <body style="margin:0;width:794px;height:1123px;background:${colors[0]};font-family:'Microsoft JhengHei',sans-serif;">
        <div style="position:absolute;inset:0;background:
          radial-gradient(circle at 18% 16%, ${colors[1]}88, transparent 20%),
          radial-gradient(circle at 82% 22%, ${colors[2]}88, transparent 22%),
          radial-gradient(circle at 30% 82%, ${colors[3]}66, transparent 24%),
          linear-gradient(135deg, #ffffff 0%, ${colors[0]} 70%);"></div>
        <div style="position:absolute;left:58px;right:58px;top:58px;height:92px;border:4px solid #f59e0b;border-radius:28px;background:rgba(255,255,255,.78);"></div>
        <div style="position:absolute;left:80px;top:84px;font-size:34px;font-weight:700;color:#334155;">${title}</div>
        <div style="position:absolute;left:80px;top:128px;font-size:18px;color:#64748b;">teacher guide sample</div>
        ${Array.from({ length: 36 }, (_, i) => {
          const x = 44 + (i * 79) % 706;
          const y = 205 + (i * 131) % 805;
          const color = ["#60a5fa", "#34d399", "#fbbf24", "#fb7185"][i % 4];
          return `<div style="position:absolute;left:${x}px;top:${y}px;width:12px;height:12px;border-radius:999px;background:${color};opacity:.48;"></div>`;
        }).join("")}
        <div style="position:absolute;right:70px;bottom:58px;font-size:20px;color:#64748b;">幼兒園相本</div>
      </body>
    </html>
  `);
  const imagePath = resolve(assetDir, name);
  await page.screenshot({ path: imagePath });
  await page.close();
  return imagePath;
}

async function createPhotoImage(browser, name, label, color) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`
    <html>
      <body style="margin:0;width:900px;height:700px;background:${color};font-family:'Microsoft JhengHei',sans-serif;">
        <div style="position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.65),rgba(255,255,255,0));"></div>
        <div style="position:absolute;left:70px;top:70px;width:760px;height:560px;border:18px solid rgba(255,255,255,.75);border-radius:38px;"></div>
        <div style="position:absolute;left:120px;top:260px;font-size:54px;font-weight:800;color:#1f2937;">${label}</div>
      </body>
    </html>
  `);
  const imagePath = resolve(assetDir, name);
  await page.screenshot({ path: imagePath });
  await page.close();
  return imagePath;
}

async function login(context, username, password) {
  await requireOk(
    await context.request.post(`${apiUrl}/auth/login`, { form: { username, password } }),
    `login ${username}`,
  );
}

async function createTemplate(context, browser) {
  await login(context, "admin", adminPassword);
  const background1 = await createGuideImage(browser, "teacher-source-bg-1.png", "我的校園探索", 0);
  const background2 = await createGuideImage(browser, "teacher-source-bg-2.png", "今天的分享", 1);
  const templateName = `2026-05 中班 校園探索`;
  const templateResponse = await requireOk(
    await context.request.post(`${apiUrl}/templates/`, { form: { name: templateName } }),
    "create teacher guide template",
  );
  const template = await templateResponse.json();

  async function addPage(pageNumber, backgroundPath) {
    const pageResponse = await requireOk(
      await context.request.post(`${apiUrl}/templates/${template.id}/pages`),
      `create template page ${pageNumber}`,
    );
    const pageInfo = await pageResponse.json();
    const uploadResponse = await requireOk(
      await context.request.post(`${apiUrl}/templates/${template.id}/pages/${pageInfo.id}/background`, {
        multipart: {
          file: {
            name: `teacher-guide-bg-${pageNumber}.png`,
            mimeType: "image/png",
            buffer: await readFile(backgroundPath),
          },
        },
      }),
      `upload template bg ${pageNumber}`,
    );
    const upload = await uploadResponse.json();
    return { ...pageInfo, backgroundFilename: upload.filename };
  }

  const page1 = await addPage(1, background1);
  const page2 = await addPage(2, background2);
  const commonLayout = {
    canvas_width: 794,
    canvas_height: 1123,
    photo_slots: [
      { id: 1, x: 80, y: 190, width: 280, height: 220, border: true, border_width: 8, border_radius: 18, rotation: -2, z_index: 10 },
      { id: 2, x: 430, y: 210, width: 250, height: 320, border: true, border_width: 8, border_radius: 18, rotation: 3, z_index: 11 },
      { id: 3, x: 100, y: 520, width: 255, height: 200, border: true, border_width: 8, border_radius: 18, rotation: 1, z_index: 12 },
    ],
    text_bubbles: [],
    text_labels: [
      {
        id: 1, x: 96, y: 770, width: 600, height: 96, text: "{name} 的校園探索",
        font_size: 32, font_family: "msjhbd", font_color: "#1F2937", text_align: "center", line_height: 1.25,
        text_shadow_enabled: true, text_shadow_color: "#FFFFFF", text_shadow_opacity: 210,
        text_shadow_offset_x: 2, text_shadow_offset_y: 2, text_shadow_blur: 3, z_index: 40,
      },
    ],
    stickers: [],
    footer: { text: "2026-05 · 中班 · 校園探索", x: 60, y: 1068, font_size: 18, font_color: "#64748B" },
    logo: null,
  };

  await requireOk(
    await context.request.put(`${apiUrl}/templates/${template.id}/pages/${page1.id}/layout`, {
      data: { ...commonLayout, background_filename: page1.backgroundFilename },
    }),
    "save teacher guide page 1",
  );
  await requireOk(
    await context.request.put(`${apiUrl}/templates/${template.id}/pages/${page2.id}/layout`, {
      data: {
        ...commonLayout,
        background_filename: page2.backgroundFilename,
        photo_slots: [
          { id: 1, x: 82, y: 190, width: 280, height: 230, border: true, border_width: 8, border_radius: 18, rotation: 0, z_index: 10 },
          { id: 2, x: 420, y: 205, width: 250, height: 190, border: true, border_width: 8, border_radius: 18, rotation: -4, z_index: 11 },
          { id: 3, x: 106, y: 510, width: 260, height: 205, border: true, border_width: 8, border_radius: 18, rotation: 3, z_index: 12 },
          { id: 4, x: 430, y: 510, width: 250, height: 205, border: true, border_width: 8, border_radius: 18, rotation: 0, z_index: 13 },
        ],
        text_labels: [
          {
            id: 1, x: 110, y: 780, width: 570, height: 98, text: "今天我最喜歡的是：",
            font_size: 30, font_family: "msjhbd", font_color: "#1F2937", text_align: "center", line_height: 1.25, z_index: 40,
          },
        ],
        footer: { text: "觀察 · 探索 · 分享", x: 60, y: 1068, font_size: 18, font_color: "#64748B" },
      },
    }),
    "save teacher guide page 2",
  );
  return { id: template.id, name: templateName };
}

async function createTeacher(context) {
  const suffix = Date.now();
  await login(context, "admin", adminPassword);
  const supervisorResponse = await requireOk(
    await context.request.post(`${apiUrl}/users/`, {
      data: {
        username: `guide-supervisor-${suffix}`,
        display_name: "教學用主管",
        password: teacherPassword,
        role: "supervisor",
      },
    }),
    "create guide supervisor",
  );
  const supervisor = await supervisorResponse.json();
  const teacherResponse = await requireOk(
    await context.request.post(`${apiUrl}/users/`, {
      data: {
        username: `guide-teacher-${suffix}`,
        display_name: "教學用老師",
        password: teacherPassword,
        role: "teacher",
        supervisor_id: supervisor.id,
      },
    }),
    "create guide teacher",
  );
  const teacher = await teacherResponse.json();
  return { supervisor, teacher };
}

async function createProjectAsTeacher(context, templateId) {
  const projectResponse = await requireOk(
    await context.request.post(`${apiUrl}/projects/`, {
      form: { name: "2026-05 中班 校園探索 蘋果班", template_id: templateId },
    }),
    "create guide project",
  );
  const project = await projectResponse.json();
  await requireOk(
    await context.request.post(`${apiUrl}/projects/${project.id}/students/batch`, {
      data: ["小安", "小晴", "小宇"],
    }),
    "add guide students",
  );
  await requireOk(
    await context.request.put(`${apiUrl}/projects/${project.id}/label_texts`, {
      data: {
        "0": { "1": "{name} 的校園探索" },
        "1": { "1": "今天我最喜歡的是：戶外觀察" },
      },
    }),
    "save guide project labels",
  );
  const projectDetail = await (await requireOk(
    await context.request.get(`${apiUrl}/projects/${project.id}`),
    "fetch guide project",
  )).json();
  return projectDetail;
}

async function uploadStudentPhotos(context, browser, projectId, studentId) {
  const photo1 = await createPhotoImage(browser, "teacher-photo-1.png", "校園觀察", "#bae6fd");
  const photo2 = await createPhotoImage(browser, "teacher-photo-2.png", "探索分享", "#bbf7d0");
  for (const [slotId, photoPath] of [[1, photo1], [2, photo2]]) {
    await requireOk(
      await context.request.post(`${apiUrl}/projects/${projectId}/students/${studentId}/pages/0/photos/${slotId}`, {
        multipart: {
          file: {
            name: `guide-photo-${slotId}.png`,
            mimeType: "image/png",
            buffer: await readFile(photoPath),
          },
        },
      }),
      `upload student photo ${slotId}`,
    );
  }
}

const STUDENT_TEXT_TARGET = {
  x: 96,
  y: 770,
  width: 600,
  height: 96,
};

const GUIDE_MARKERS = {
  projectList: [
    { n: 1, selector: '[data-guide="project-create-button"]', text: "新建專案。每個班級每個月建立一個相本專案。" },
    { n: 2, selector: '[data-guide="project-create-form"]', text: "選擇模板與輸入班級補充名稱，系統會組成專案全名。" },
    { n: 3, selector: '[data-guide="project-card"]', text: "專案卡片。檢查學生數與建立日期。" },
    { n: 4, selector: '[data-guide="project-settings-link"]', text: "專案設定。先登記學生與填整班共用文字。" },
    { n: 5, selector: '[data-guide="project-review-link"]', text: "個人編輯。逐位補照片、預覽與輸出。" },
  ],
  batchStudents: [
    { n: 1, selector: '[data-guide="batch-student-input"]', text: "學生名單輸入框。可一行一位，也可用逗號或頓號分隔。" },
    { n: 2, selector: '[data-guide="batch-add-students"]', text: "新增學生。系統會略過空白與重複姓名。" },
    { n: 3, selector: '[data-guide="batch-student-list"]', text: "已登記學生。確認人數、修改姓名或刪除。" },
    { n: 4, selector: '[data-guide="batch-text-tab"]', text: "文字頁籤。填整班共用文案。" },
    { n: 5, selector: '[data-guide="batch-review-link"]', text: "進入個人編輯與輸出總覽。" },
  ],
  batchTexts: [
    { n: 1, selector: '[data-guide="batch-page-nav"]', text: "切換頁面。逐頁檢查需要填的文字。" },
    { n: 2, selector: '[data-guide="batch-text-fields"]', text: "整班共用文字。清空時會恢復模板文字。" },
    { n: 3, selector: '[data-guide="batch-text-insert-name"]', text: "插入 {name}。在游標位置快速加入姓名變數。" },
    { n: 4, selector: '[data-guide="batch-preview-panel"]', text: "樣版預覽。確認文字套入模板後的位置和內容。" },
    { n: 5, selector: '[data-guide="batch-review-link"]', text: "共用文字完成後，進入個人編輯。" },
  ],
  review: [
    { n: 1, selector: '[data-guide="review-progress"]', text: "輸出進度。確認已產生 PDF 的學生數。" },
    { n: 2, selector: '[data-guide="review-student-card"]', text: "學生卡片。可看縮圖與完成狀態。" },
    { n: 3, selector: '[data-guide="review-edit-student"]', text: "編輯。進入單一學生頁面補照片與文字。" },
    { n: 4, selector: '[data-guide="review-preview-student"]', text: "預覽。快速打開此學生頁面預覽。" },
    { n: 5, selector: '[data-guide="review-download-all"]', text: "下載全部 ZIP。所有學生確認後批次輸出。" },
  ],
  studentEdit: [
    { n: 1, selector: '[data-guide="student-preview-panel"]', text: "預覽與頁面。切頁、刪除此頁或還原此頁。" },
    { n: 2, selector: '[data-guide="student-photo-manager"]', text: "照片管理。逐格上傳、檢查與調整照片。" },
    { n: 3, selector: '[data-guide="student-multi-upload"]', text: "多選上傳。一次選多張照片依順序放入空格。" },
    { n: 4, selector: '[data-guide="student-text-panel"]', text: "個別文字。清空時會恢復專案共用文字或模板文字。" },
    { n: 5, selector: '[data-guide="student-text-insert-name"]', text: "插入 {name}。在個別文字中快速加入姓名變數。" },
    { n: 6, selector: '[data-guide="student-download-button"]', text: "產出並下載。完成此學生的 PDF。" },
  ],
  studentPreview: [
    { n: 1, selector: '[data-guide="student-page-nav"]', text: "頁面切換。檢查第 1 頁、第 2 頁等不同頁面。" },
    { n: 2, selector: '[data-guide="student-page-skip"]', text: "刪除此頁。此學生不需要某頁時可跳過。" },
    { n: 3, selector: '[data-guide="student-page-preview"]', text: "單頁預覽。確認照片與文字是否正確套入。" },
    { n: 4, relativeTo: '[data-guide="student-page-preview"]', templateRect: STUDENT_TEXT_TARGET, text: "文字套用結果。{name} 會顯示為學生姓名。" },
  ],
};

async function screenshotsFromDisk() {
  let targetMeta = {};
  try {
    targetMeta = JSON.parse(await readFile(targetMetaPath, "utf8"));
  } catch {
    targetMeta = {};
  }
  const imagePaths = {
    projectList: "01-project-list.png",
    batchStudents: "02-batch-students.png",
    batchTexts: "03-batch-texts.png",
    review: "04-review.png",
    studentEdit: "05-student-edit.png",
    studentPreview: "06-student-preview.png",
  };
  return Object.fromEntries(
    Object.entries(imagePaths).map(([key, fileName]) => [
      key,
      { path: resolve(assetDir, fileName), markers: targetMeta[key] ?? [] },
    ]),
  );
}

function screenshotTargetMeta(screenshots) {
  return Object.fromEntries(
    Object.entries(screenshots).map(([key, image]) => [key, image.markers ?? []]),
  );
}

async function buildPdf(screenshots) {
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <title>老師製作相冊使用教學</title>
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
    .eyebrow { color: #059669; font-size: 13px; font-weight: 700; letter-spacing: .04em; margin-bottom: 12px; }
    .subtitle { font-size: 16px; color: #4b5563; max-width: 620px; }
    .meta { margin-top: 24px; color: #6b7280; font-size: 11px; }
    .toc { margin-top: 30px; padding: 16px 18px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; }
    .toc li { margin: 4px 0; }
    .page-break { page-break-before: always; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .note { padding: 10px 12px; background: #ecfdf5; border-left: 4px solid #10b981; font-size: 11.5px; margin: 10px 0; }
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
    <div class="eyebrow">ALBUM MAKER · TEACHER GUIDE</div>
    <h1>老師製作相冊使用教學</h1>
    <p class="subtitle">給帶班老師使用。這份 PDF 以實際系統截圖說明如何建立相本專案、登記學生、填整班文字、逐位上傳照片、預覽並輸出 PDF。</p>
    <p class="meta">產出檔案：<strong>${docsRelative(pdfPath)}</strong><br>網頁內也可在相本專案、專案設定、個人編輯與輸出頁點「製作教學」查看互動導覽。</p>
    <div class="toc">
      <h3>快速目錄</h3>
      <ol>
        <li>建立相本專案</li>
        <li>登記學生名單</li>
        <li>填整班共用文字</li>
        <li>檢查學生卡片與輸出狀態</li>
        <li>逐位上傳照片與覆寫文字</li>
        <li>預覽、跳過頁面與下載 PDF</li>
        <li>交付前檢查表</li>
      </ol>
    </div>
  </section>

  <section>
    <h2>1. 建立相本專案</h2>
    <p class="step-intro">登入後進入「相本專案」。每個班級每個月份通常建立一個專案，專案會套用設計組完成的模板。</p>
    <ol class="actions">
      <li>點「新建專案」。</li>
      <li>選擇模板，確認模板頁數與照片數符合本月需求。</li>
      <li>輸入班級或月份補充名稱，確認專案全名。</li>
      <li>建立後先進入「專案設定」。</li>
    </ol>
    ${stepFigure(screenshots.projectList, "步驟 1：相本專案列表與建立入口。")}
  </section>

  <section class="page-break">
    <h2>2. 登記學生名單</h2>
    <p class="step-intro">先把本次要製作相冊的學生加入專案。學生順序會影響後續卡片排列與批次輸出檢查。</p>
    <ol class="actions">
      <li>在「新增學生名單」貼上學生姓名。</li>
      <li>可以一行一位，也可以用逗號、頓號分隔。</li>
      <li>點「新增」，系統會自動略過重複名稱。</li>
      <li>在已登記學生清單確認人數與姓名。</li>
    </ol>
    ${stepFigure(screenshots.batchStudents, "步驟 2：專案設定中的學生名單。")}
  </section>

  <section class="page-break">
    <h2>3. 填整班共用文字</h2>
    <p class="step-intro">如果模板有文字欄位，老師可以先填整班共用文字。需要學生姓名的位置使用 <span class="kbd">{name}</span>，輸出時會自動替換成每位學生姓名。</p>
    <ol class="actions">
      <li>切到「文字」頁籤。</li>
      <li>用頁面切換查看每一頁的文字欄位。</li>
      <li>需要學生姓名時，點「插入 {name}」快速放入姓名變數。</li>
      <li>欄位清空時會自動恢復模板文字。</li>
      <li>填好共用文字後，右側預覽會用模板畫面確認文字位置。</li>
      <li>個別學生有不同內容時，可之後到學生個人編輯頁覆寫。</li>
    </ol>
    ${stepFigure(screenshots.batchTexts, "步驟 3：整班共用文字與樣版預覽。")}
  </section>

  <section class="page-break">
    <h2>4. 檢查學生卡片與輸出狀態</h2>
    <p class="step-intro">從「個人編輯」進入輸出總覽。這裡可以看到所有學生、頁面縮圖、PDF 產生狀態與批次下載入口。</p>
    <ol class="actions">
      <li>看上方進度確認已產生幾位學生。</li>
      <li>點學生卡片中的「編輯」進入個別編輯。</li>
      <li>點「預覽」快速檢查畫面。</li>
      <li>全部完成後點「下載全部 ZIP」。</li>
    </ol>
    ${stepFigure(screenshots.review, "步驟 4：學生卡片、預覽與下載入口。")}
  </section>

  <section class="page-break">
    <h2>5. 逐位上傳照片與覆寫文字</h2>
    <p class="step-intro">個別編輯頁是老師主要製作區。左側看預覽，右側管理照片與個別文字。</p>
    <ol class="actions">
      <li>用預覽區切換頁面，確認目前正在編哪一頁。</li>
      <li>在照片管理中點空格上傳照片，或用「多選上傳」一次放入多張照片。</li>
      <li>已有照片時可調整位移縮放、更換、刪除或拖曳換順序。</li>
      <li>需要只改這位學生文字時，在個別文字欄位覆寫。</li>
      <li>需要學生姓名時，點「插入 {name}」快速放入姓名變數。</li>
      <li>個別文字清空時會恢復專案共用文字或模板文字。</li>
    </ol>
    ${stepFigure(screenshots.studentEdit, "步驟 5：學生個別編輯頁。")}
  </section>

  <section class="page-break">
    <h2>6. 預覽、跳過頁面與下載 PDF</h2>
    <p class="step-intro">每位學生完成後，最後要看預覽確認照片、文字與頁面數是否正確，再輸出 PDF。</p>
    <ol class="actions">
      <li>切換每一頁預覽，檢查照片有沒有放反或裁切錯誤。</li>
      <li>若這位學生不需要某一頁，可點「刪除此頁」。</li>
      <li>確認 <span class="kbd">{name}</span> 已正確替換成學生姓名。</li>
      <li>按「產出並下載」產生該學生 PDF。</li>
    </ol>
    ${stepFigure(screenshots.studentPreview, "步驟 6：預覽與頁面跳過控制。")}
  </section>

  <section class="page-break">
    <h2>7. 交付前檢查表</h2>
    <div class="grid">
      <ul>
        <li>□ 專案使用正確模板。</li>
        <li>□ 學生名單完整且沒有重複。</li>
        <li>□ 整班共用文字已填好。</li>
        <li>□ 每位學生照片格都已補齊。</li>
        <li>□ 個別文字沒有漏填或超出畫面。</li>
      </ul>
      <ul>
        <li>□ 每位學生所有頁面都已預覽。</li>
        <li>□ 不需要的頁面已刪除。</li>
        <li>□ PDF 已逐位產生。</li>
        <li>□ 下載全部 ZIP 後可正常開啟。</li>
        <li>□ 審閱意見已確認。</li>
      </ul>
    </div>
    <h2>常見問題</h2>
    <h3>照片放進去後裁切不對</h3>
    <p>在照片格上點調整，重新設定位移與縮放，再回到預覽確認。</p>
    <h3>某位學生少一頁</h3>
    <p>到該學生個別編輯頁檢查是否誤按「刪除此頁」，需要時可按還原。</p>
    <h3>文字沒有帶入姓名</h3>
    <p>整班共用文字或模板文字要使用 <span class="kbd">{name}</span>，不要直接打固定姓名。</p>
    <p class="small">本文件由本機系統截圖產生，截圖素材位於 docs/assets/teacher-guide/。</p>
  </section>
</body>
</html>`;

  await writeFile(htmlPath, html, "utf8");
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30000 });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 60000,
    });
  } finally {
    await browser?.close().catch(() => {});
  }
  return pdfPath;
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
  let adminContext;
  let teacherContext;
  let templateId;
  let projectId;
  let teacherUser;
  let supervisorUser;
  let screenshots;
  try {
    browser = await chromium.launch();
    adminContext = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const template = await createTemplate(adminContext, browser);
    templateId = template.id;
    const users = await createTeacher(adminContext);
    teacherUser = users.teacher;
    supervisorUser = users.supervisor;

    teacherContext = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await login(teacherContext, teacherUser.username, teacherPassword);
    const project = await createProjectAsTeacher(teacherContext, templateId);
    projectId = project.id;
    const firstStudent = project.students[0];
    await uploadStudentPhotos(teacherContext, browser, projectId, firstStudent.id);

    const page = await teacherContext.newPage();
    await page.goto("/projects");
    await page.getByText(project.name).waitFor();
    await page.getByRole("button", { name: "新建專案" }).click();
    const projectList = await screenshot(page, "01-project-list.png", GUIDE_MARKERS.projectList);

    await page.goto(`/projects/${projectId}/batch`);
    await page.getByText("新增學生名單").waitFor();
    const batchStudents = await screenshot(page, "02-batch-students.png", GUIDE_MARKERS.batchStudents);
    await page.getByRole("button", { name: "文字" }).click();
    await page.getByText("樣版預覽").waitFor();
    const batchTexts = await screenshot(page, "03-batch-texts.png", GUIDE_MARKERS.batchTexts);

    await page.goto(`/projects/${projectId}/review`);
    await page.getByText(firstStudent.name).waitFor();
    const review = await screenshot(page, "04-review.png", GUIDE_MARKERS.review);

    await page.goto(`/projects/${projectId}/students/${firstStudent.id}/edit`);
    await page.getByText("照片管理").waitFor();
    await page.getByRole("heading", { name: "第 1 頁文字" }).first().waitFor();
    await waitForPreviewImage(page);
    const studentEdit = await screenshot(page, "05-student-edit.png", GUIDE_MARKERS.studentEdit);
    await waitForPreviewImage(page);
    const studentPreview = await screenshot(page, "06-student-preview.png", GUIDE_MARKERS.studentPreview);

    screenshots = { projectList, batchStudents, batchTexts, review, studentEdit, studentPreview };
    await writeFile(targetMetaPath, JSON.stringify(screenshotTargetMeta(screenshots), null, 2), "utf8");
  } finally {
    if (teacherContext && projectId) {
      await teacherContext.request.delete(`${apiUrl}/projects/${projectId}`).catch(() => {});
    }
    if (adminContext && templateId) {
      await adminContext.request.delete(`${apiUrl}/templates/${templateId}`).catch(() => {});
    }
    if (adminContext && teacherUser?.id) {
      await adminContext.request.delete(`${apiUrl}/users/${teacherUser.id}`).catch(() => {});
    }
    if (adminContext && supervisorUser?.id) {
      await adminContext.request.delete(`${apiUrl}/users/${supervisorUser.id}`).catch(() => {});
    }
    await teacherContext?.close().catch(() => {});
    await adminContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  const writtenPdfPath = await buildPdf(screenshots);
  console.log(`PDF written to ${writtenPdfPath}`);
  console.log(`HTML source written to ${htmlPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
