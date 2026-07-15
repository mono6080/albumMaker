import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  captureGuideScreenshot,
  loadGuideScreenshots,
  markerBoxStyle,
  relativeWebPath,
  requireOk,
  screenshotTargetMeta,
} from "./guide_artifacts.mjs";

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
const adminPassword = process.env.GUIDE_ADMIN_PASSWORD ?? "admin";
const teacherPassword = "teacher-guide-123";
const A4_WIDTH = 794;
const A4_HEIGHT = 1123;
function docsRelative(filePath) {
  return relativeWebPath(docsDir, filePath);
}

async function screenshot(page, name, markers = []) {
  return captureGuideScreenshot({
    page,
    assetDir,
    name,
    markers,
    templateSize: { width: A4_WIDTH, height: A4_HEIGHT },
  });
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

// 模板一定隸屬期別，而且老師建專案只能用「使用中」期別的模板；
// 沒有現成 active 期別就補建一個（新建的才在收尾時封存，避免動到現場資料）
async function ensureActivePeriod(context) {
  const listResponse = await requireOk(
    await context.request.get(`${apiUrl}/templates/periods?status=active`),
    "list active template periods",
  );
  const periods = await listResponse.json();
  if (periods.length > 0) return { period: periods[0], created: false };
  const createResponse = await requireOk(
    await context.request.post(`${apiUrl}/templates/periods`, {
      form: { name: `教學示範期別 ${Date.now()}`, department: "infant", status: "active" },
    }),
    "create guide template period",
  );
  return { period: await createResponse.json(), created: true };
}

async function createTemplate(context, browser, periodId) {
  const background1 = await createGuideImage(browser, "teacher-source-bg-1.png", "我的校園探索", 0);
  const background2 = await createGuideImage(browser, "teacher-source-bg-2.png", "今天的分享", 1);
  const templateName = `2026-05 中班 校園探索`;
  const templateResponse = await requireOk(
    await context.request.post(`${apiUrl}/templates/`, {
      form: { name: templateName, period_id: periodId },
    }),
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

// 與 createTemplate 的版面同步：每頁的照片格 id 清單（改版面時記得一起改）
const TEMPLATE_PHOTO_SLOTS = { 0: [1, 2, 3], 1: [1, 2, 3, 4] };

async function createTeacher(context) {
  const suffix = Date.now();
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

// 用「全班同一張」端點把所有照片格補齊，讓班級總覽進到階段 2（可標記全班完成、出現交件下載）
async function fillAllSharedPhotos(context, browser, projectId) {
  const groupPhoto = await createPhotoImage(browser, "teacher-photo-group.png", "全班合照", "#fde68a");
  const buffer = await readFile(groupPhoto);
  for (const [pageIndex, slotIds] of Object.entries(TEMPLATE_PHOTO_SLOTS)) {
    for (const slotId of slotIds) {
      await requireOk(
        await context.request.post(`${apiUrl}/projects/${projectId}/photos/shared/pages/${pageIndex}/slots/${slotId}`, {
          multipart: {
            file: {
              name: `guide-shared-${pageIndex}-${slotId}.png`,
              mimeType: "image/png",
              buffer,
            },
          },
        }),
        `upload shared photo p${pageIndex} slot ${slotId}`,
      );
    }
  }
}

const GUIDE_MARKERS = {
  projectList: [
    { n: 1, selector: '[data-guide="project-create-button"]', text: "「新建專案」。每個班級每一期建立一個相本專案。" },
    { n: 2, selector: '[data-guide="project-card"]', text: "專案卡片。可以看到學生數、建立日期與完成狀態。" },
    { n: 3, selector: '[data-guide="project-edit-link"]', text: "「編輯相本」。放照片、填文字都從這裡進去。" },
    { n: 4, selector: '[data-guide="project-review-link"]', text: "「班級總覽」。看進度、管名單、標記完成與下載交件。" },
  ],
  projectCreate: [
    { n: 1, selector: '[data-guide="project-create-form"]', text: "選部門與期別、挑設計組做好的模板，補上分校或班級名稱；也可以從上一期專案複製學生名單。" },
  ],
  reviewWorkbench: [
    { n: 1, selector: '[data-guide="review-progress"]', text: "工作台橫幅。左邊看階段（1 製作 → 2 全班完成 → 3 交件）、中間看照片進度、右邊是這個階段的下一步按鈕。" },
    { n: 2, selector: '[data-guide="review-roster-button"]', text: "「學生名單」。批次新增、改名或刪除學生。" },
    { n: 3, selector: 'a:has-text("繼續製作")', text: "階段 1 的下一步：「繼續製作」，會帶你進編輯相本。" },
    { n: 4, selector: '[data-guide="review-student-card"]', text: "學生卡片。照片進度一目了然，點名字或鉛筆進個別編輯。" },
    { n: 5, selector: '[data-guide="review-preview-student"]', text: "點頁面縮圖直接放大預覽，不用進編輯頁。" },
  ],
  rosterModal: [
    { n: 1, selector: '[data-guide="roster-add-input"]', text: "把學生姓名貼進來：一行一位，或用逗號、頓號分隔。" },
    { n: 2, selector: '[data-guide="roster-add-button"]', text: "「新增」。重複的名字會自動略過。" },
    { n: 3, selector: '[data-guide="roster-modal"]', text: "已登記學生清單。可以行內改名、刪除，也看得到每位的照片進度。" },
  ],
  classEdit: [
    { n: 1, selector: '[data-guide="scope-switcher"]', text: "編輯範圍：「全班」＝改的內容套用到所有學生；「個別」＝只改單一學生。" },
    { n: 2, selector: '[data-guide="scope-switcher"]', text: "編輯範圍切換。「全班／個別」兩顆按鈕，同一個編輯器不用換頁。" },
    { n: 3, selector: '[data-guide="class-page-nav"]', text: "頁碼導航。預覽、照片、文字三個面板會一起換頁。" },
    { n: 4, selector: '[data-guide="class-photo-panel"]', text: "照片管理（全班）。點一個照片格開始放全班照片；右上「依檔名整批匯入」給已命名好的整批檔案。" },
    { n: 5, selector: '[data-guide="class-text-panel"]', text: "全班文字。{name} 會自動代入每位學生的姓名。" },
    { n: 6, selector: '[data-guide="class-preview-panel"]', text: "頁面預覽。確認文字套上模板後的位置與內容，可按重新整理預覽。" },
  ],
  classPhotoModal: [
    { n: 1, selector: '[data-guide="class-photo-strategies"]', text: "先選分配方式：「每人不同張」一次上傳多張、自動分給每位學生；「全班同一張」把團體照套用到全班同一格。" },
    { n: 2, selector: '[data-guide="class-slot-photo-modal"]', text: "選好方式後，第二步就在下方選照片上傳。" },
  ],
  studentEdit: [
    { n: 1, selector: '[data-guide="scope-switcher"]', text: "用「上一位／下一位」或下拉切換學生；按「全班」可回到全班共用內容。" },
    { n: 2, selector: '[data-guide="student-page-nav"]', text: "頁碼導航。一頁做完換下一頁。" },
    { n: 3, selector: '[data-guide="student-preview-panel"]', text: "頁面預覽。頁尾可「刪除此頁」，刪錯了也能還原。" },
    { n: 4, selector: '[data-guide="student-photo-manager"]', text: "照片管理。點空格上傳；已有照片可調整裁切、更換、刪除或拖曳交換。" },
    { n: 5, selector: '[data-guide="student-photo-scope"]', text: "「本頁／整本」檢視切換。切到整本可一次看所有頁的照片格。" },
    { n: 6, selector: '[data-guide="student-multi-upload"]', text: "多選上傳。一次選多張照片，自動填入剩餘空格。" },
    { n: 7, selector: '[data-guide="student-text-panel"]', text: "個別文字。只想改這位學生時在這裡覆寫；按恢復預設可回到全班文字。" },
  ],
  reviewComplete: [
    { n: 1, selector: '[data-guide="review-progress"]', text: "照片備齊後，階段自動跳到「2 全班完成」。" },
    { n: 2, selector: 'button:has-text("全班完成")', text: "「全班完成」。標記後內容鎖定，需要主管或管理員退回才能再修改。" },
    { n: 3, selector: '[data-guide="review-download-all"]', text: "交件下載。批次下載全班「PDF ZIP」，旁邊是「全部圖片」。" },
    { n: 4, selector: '[data-guide="review-download-student"]', text: "也可以只下載單一學生的 PDF 或圖片。" },
  ],
};

async function screenshotsFromDisk() {
  return loadGuideScreenshots({
    assetDir,
    targetMetaPath,
    imagePaths: {
      projectList: "01-project-list.png",
      projectCreate: "02-project-create.png",
      reviewWorkbench: "03-review-workbench.png",
      rosterModal: "04-roster-modal.png",
      classEdit: "05-class-edit.png",
      classPhotoModal: "06-class-photo-modal.png",
      studentEdit: "07-student-edit.png",
      reviewComplete: "08-review-complete.png",
    },
  });
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
    <p class="subtitle">給帶班老師使用。這份 PDF 以實際系統截圖說明整個流程：建立相本專案、在班級總覽管理學生名單、先編輯全班共用的照片與文字、再逐位微調，最後標記全班完成並下載交件。</p>
    <p class="meta">產出檔案：<strong>${docsRelative(pdfPath)}</strong><br>網頁內也可在相本專案、班級總覽與編輯相本頁點「製作教學」查看互動導覽。</p>
    <div class="toc">
      <h3>快速目錄</h3>
      <ol>
        <li>建立相本專案</li>
        <li>班級總覽：老師的工作台</li>
        <li>登記學生名單</li>
        <li>編輯全班共用內容（照片與文字）</li>
        <li>個別學生微調</li>
        <li>全班完成與交件下載</li>
        <li>交付前檢查表</li>
      </ol>
    </div>
  </section>

  <section>
    <h2>1. 建立相本專案</h2>
    <p class="step-intro">登入後進入「相本專案」。每個班級每一期建立一個專案，專案會套用設計組完成的模板。專案卡片下方有兩個入口：「編輯相本」做內容、「班級總覽」看進度與交件。</p>
    <ol class="actions">
      <li>點右上「新建專案」。</li>
      <li>選部門與期別，再選這一期要用的模板（會顯示頁數與照片格數）。</li>
      <li>補上分校或班級名稱，確認專案全名後點「建立專案」。</li>
      <li>上一期已經建過名單的話，可直接選「複製學生名單」帶入全班。</li>
    </ol>
    ${stepFigure(screenshots.projectList, "步驟 1：相本專案列表與專案卡片的兩個入口。")}
    ${stepFigure(screenshots.projectCreate, "步驟 1-2：新建專案視窗。")}
  </section>

  <section class="page-break">
    <h2>2. 班級總覽：老師的工作台</h2>
    <p class="step-intro">「班級總覽」是整本相冊的指揮台。最上方的橫幅一條看完：目前階段（1 製作 → 2 全班完成 → 3 交件）、全班照片進度，以及依階段建議的下一步按鈕。</p>
    <ol class="actions">
      <li>階段 1 製作中：按「繼續製作」進編輯相本補照片。</li>
      <li>點「缺照片 N 位」會直接篩選出還缺照片的學生。</li>
      <li>點學生卡片的名字或鉛筆，可進入該學生的個別編輯。</li>
      <li>點卡片上的頁面縮圖可直接放大預覽。</li>
    </ol>
    ${stepFigure(screenshots.reviewWorkbench, "步驟 2：班級總覽工作台（製作階段）。")}
  </section>

  <section class="page-break">
    <h2>3. 登記學生名單</h2>
    <p class="step-intro">名單在班級總覽右上的「學生名單」按鈕裡管理，不用換頁。先把本次要製作相冊的學生加齊，再開始放照片。</p>
    <ol class="actions">
      <li>在班級總覽點右上「學生名單」。</li>
      <li>在批次新增框貼上姓名：一行一位，或用逗號、頓號分隔。</li>
      <li>點「新增」，系統會自動略過重複名稱。</li>
      <li>在下方清單確認人數；需要時可行內改名或刪除。</li>
    </ol>
    ${stepFigure(screenshots.rosterModal, "步驟 3：學生名單視窗。")}
  </section>

  <section class="page-break">
    <h2>4. 編輯全班共用內容（照片與文字）</h2>
    <p class="step-intro">從專案卡片或班級總覽的「繼續製作」進入編輯相本，預設是「全班」範圍：這裡做的事會套用到所有學生，最省力的做法是先把全班共用的內容一次做完。畫面分三欄：頁面預覽｜照片管理｜頁面文字，和個別編輯同一套版面。</p>
    <ol class="actions">
      <li>用頁碼導航切頁，三個面板會一起換頁。</li>
      <li>點一個照片格，會開「放照片」視窗選分配方式：<strong>每人不同張</strong>（一次上傳多張、自動分給每位學生）或<strong>全班同一張</strong>（團體照套用到全班同一格）。</li>
      <li>行政已經照「姓名＋頁格」命名好的整批檔案，用照片面板右上的「依檔名整批匯入」。</li>
      <li>在全班文字填共用文案；需要學生姓名的位置用 <span class="kbd">{name}</span>，輸出時自動替換。</li>
      <li>清空欄位會輸出空白；按「恢復預設」可回到模板文字。</li>
    </ol>
    ${stepFigure(screenshots.classEdit, "步驟 4：編輯相本（全班範圍）三欄工作台。")}
    ${stepFigure(screenshots.classPhotoModal, "步驟 4-3：點照片格後的「放照片」視窗。")}
  </section>

  <section class="page-break">
    <h2>5. 個別學生微調</h2>
    <p class="step-intro">全班共用的部分做完後，用編輯範圍切換按「個別」，逐位補上每位學生自己的照片、覆寫個別文字。用「上一位／下一位」一位一位輪著做，不用回列表。</p>
    <ol class="actions">
      <li>在編輯相本按「個別」，或從班級總覽點某位學生進來。</li>
      <li>用頁碼導航切頁；照片管理點空格上傳，已有照片可調整裁切、更換、刪除或拖曳交換。</li>
      <li>照片管理右上可切「本頁／整本」：整本檢視能一次上傳整本照片、跨頁調換。</li>
      <li>「多選上傳」一次選多張，自動填入剩餘空格。</li>
      <li>只想改這位學生的文字時，在個別文字覆寫；按恢復預設可回到全班文字。</li>
      <li>這位學生不需要某一頁時，在預覽區頁尾點「刪除此頁」，之後也能還原。</li>
      <li>做完按右上角的「班級總覽」回工作台。下載都在班級總覽，個別編輯頁沒有下載按鈕。</li>
    </ol>
    ${stepFigure(screenshots.studentEdit, "步驟 5：個別學生編輯頁。")}
  </section>

  <section class="page-break">
    <h2>6. 全班完成與交件下載</h2>
    <p class="step-intro">全班照片備齊後，回到班級總覽，橫幅會自動跳到階段 2。先逐位點縮圖預覽確認，再標記全班完成、下載交件。</p>
    <ol class="actions">
      <li>確認照片進度顯示「全班照片齊」。</li>
      <li>逐位點學生卡片縮圖，確認照片與 <span class="kbd">{name}</span> 文字都正確。</li>
      <li>按「全班完成」。標記後內容鎖定，之後需要主管或管理員退回才能修改。</li>
      <li>用「PDF ZIP」批次下載全班 PDF；「全部圖片」下載每頁圖片（手機會開啟系統分享）。</li>
      <li>也可以在學生卡片上只下載單一學生的 PDF 或圖片。</li>
      <li>主管或設計組留了審閱意見時，會顯示在頁面下方的「審閱意見」。</li>
    </ol>
    ${stepFigure(screenshots.reviewComplete, "步驟 6：照片備齊後的班級總覽（可標記完成與交件下載）。")}
  </section>

  <section class="page-break">
    <h2>7. 交付前檢查表</h2>
    <div class="grid">
      <ul>
        <li>□ 專案使用正確期別與模板。</li>
        <li>□ 學生名單完整且沒有重複。</li>
        <li>□ 全班共用照片與文字已填好。</li>
        <li>□ 每位學生照片格都已補齊（橫幅顯示全班照片齊）。</li>
        <li>□ 個別文字沒有漏填或超出畫面。</li>
      </ul>
      <ul>
        <li>□ 每位學生的每一頁都已預覽。</li>
        <li>□ 不需要的頁面已刪除。</li>
        <li>□ 已按「全班完成」標記。</li>
        <li>□ PDF ZIP 下載後可正常開啟。</li>
        <li>□ 審閱意見已確認。</li>
      </ul>
    </div>
    <h2>常見問題</h2>
    <h3>照片放進去後裁切不對</h3>
    <p>到該學生的個別編輯頁，在照片格上點調整，重新設定位置與縮放，再回預覽確認。</p>
    <h3>怕改到全班／怕只改到一個人</h3>
    <p>看編輯範圍切換列：「全班」＝改的內容套用到所有學生；「個別」＝只改目前這位。</p>
    <h3>某位學生少一頁</h3>
    <p>到該學生個別編輯頁檢查是否按過「刪除此頁」，需要時在預覽區按「還原此頁」。</p>
    <h3>文字沒有帶入姓名</h3>
    <p>全班文字或模板文字要使用 <span class="kbd">{name}</span>，不要直接打固定姓名。</p>
    <h3>標記全班完成後想再修改</h3>
    <p>內容已鎖定，請主管或管理員在班級總覽按「退回修改」。</p>
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
  let createdPeriodId;
  let screenshots;
  try {
    browser = await chromium.launch();
    adminContext = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await login(adminContext, "admin", adminPassword);
    const { period, created: periodCreated } = await ensureActivePeriod(adminContext);
    if (periodCreated) createdPeriodId = period.id;
    const template = await createTemplate(adminContext, browser, period.id);
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

    // 1. 專案列表：卡片與兩個入口
    await page.goto("/projects");
    await page.getByText(project.name).first().waitFor();
    const projectList = await screenshot(page, "01-project-list.png", GUIDE_MARKERS.projectList);

    // 1-2. 新建專案 Modal
    await page.getByRole("button", { name: "新建專案" }).click();
    await page.getByText("新建相本專案").waitFor();
    const projectCreate = await screenshot(page, "02-project-create.png", GUIDE_MARKERS.projectCreate);
    await page.keyboard.press("Escape");

    // 2. 班級總覽工作台（階段 1 製作中：一位學生已有部分照片）
    await page.goto(`/projects/${projectId}/review`);
    await page.getByText(firstStudent.name).first().waitFor();
    await page.getByText("照片進度").waitFor();
    const reviewWorkbench = await screenshot(page, "03-review-workbench.png", GUIDE_MARKERS.reviewWorkbench);

    // 3. 學生名單 Modal
    await page.locator('[data-guide="review-roster-button"]').click();
    await page.getByText("批次新增").waitFor();
    const rosterModal = await screenshot(page, "04-roster-modal.png", GUIDE_MARKERS.rosterModal);
    await page.keyboard.press("Escape");

    // 4. 編輯相本（全班範圍）：橫幅、切換列、三欄工作台
    await page.goto(`/projects/${projectId}/edit`);
    await page.locator('[data-guide="class-photo-panel"]').waitFor();
    await page.locator('[data-guide="class-preview-panel"]').waitFor();
    await waitForPreviewImage(page, '[data-guide="class-preview-panel"] img');
    const classEdit = await screenshot(page, "05-class-edit.png", GUIDE_MARKERS.classEdit);

    // 4-3. 點照片格 → 放照片 Modal（選「每人不同張」讓兩個步驟都入鏡）
    await page.locator('[data-guide="class-shared-photo-slots"] button').first().click();
    await page.getByText("選擇分配方式").waitFor();
    await page.locator('[data-guide="class-photo-strategies"] button').first().click();
    await page.getByText("選擇照片並開始分配").waitFor();
    const classPhotoModal = await screenshot(page, "06-class-photo-modal.png", GUIDE_MARKERS.classPhotoModal);
    await page.keyboard.press("Escape");

    // 5. 個別學生編輯頁
    await page.goto(`/projects/${projectId}/students/${firstStudent.id}/edit`);
    await page.getByText("照片管理").waitFor();
    await waitForPreviewImage(page);
    const studentEdit = await screenshot(page, "07-student-edit.png", GUIDE_MARKERS.studentEdit);

    // 6. 補齊全班照片 → 班級總覽進入階段 2（全班完成＋交件下載）
    await fillAllSharedPhotos(teacherContext, browser, projectId);
    await page.goto(`/projects/${projectId}/review`);
    await page.getByRole("button", { name: "全班完成" }).waitFor();
    await page.getByText("全班照片齊").waitFor();
    const reviewComplete = await screenshot(page, "08-review-complete.png", GUIDE_MARKERS.reviewComplete);

    screenshots = {
      projectList,
      projectCreate,
      reviewWorkbench,
      rosterModal,
      classEdit,
      classPhotoModal,
      studentEdit,
      reviewComplete,
    };
    await writeFile(targetMetaPath, JSON.stringify(screenshotTargetMeta(screenshots), null, 2), "utf8");
  } finally {
    if (teacherContext && projectId) {
      await teacherContext.request.delete(`${apiUrl}/projects/${projectId}`).catch(() => {});
    }
    if (adminContext && templateId) {
      await adminContext.request.delete(`${apiUrl}/templates/${templateId}`).catch(() => {});
    }
    if (adminContext && createdPeriodId) {
      // 期別沒有刪除端點：本次新建的改為封存，避免留在「使用中」清單干擾現場
      await adminContext.request
        .patch(`${apiUrl}/templates/periods/${createdPeriodId}`, { form: { status: "archived" } })
        .catch(() => {});
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
