// 兩套教學產生器共用的截圖、標記與檔案 metadata 基礎設施。
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const roundPercent = value => Math.round(value * 100) / 100;
const clampPercent = value => Math.max(0, Math.min(100, value));

export function relativeWebPath(rootDir, filePath) {
  return relative(rootDir, filePath).replaceAll("\\", "/");
}

export async function requireOk(response, label) {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
  return response;
}

export function percentBox(rawBox, viewport, padding = 4) {
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

export async function resolveGuideMarkerBox(page, marker, templateSize = null) {
  if (marker.box) return marker.box;

  const viewport = page.viewportSize() ?? { width: 1440, height: 1000 };
  let rawBox = null;
  if (marker.selector) {
    rawBox = await page.locator(marker.selector).first().boundingBox();
  } else if (marker.relativeTo && (marker.rect || marker.templateRect)) {
    const baseBox = await page.locator(marker.relativeTo).first().boundingBox();
    if (baseBox && marker.templateRect && templateSize) {
      rawBox = {
        x: baseBox.x + marker.templateRect.x * baseBox.width / templateSize.width,
        y: baseBox.y + marker.templateRect.y * baseBox.height / templateSize.height,
        width: marker.templateRect.width * baseBox.width / templateSize.width,
        height: marker.templateRect.height * baseBox.height / templateSize.height,
      };
    } else if (baseBox && marker.rect) {
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

export async function resolveGuideMarkers(page, markers, templateSize = null) {
  const resolved = [];
  for (const marker of markers) {
    const box = await resolveGuideMarkerBox(page, marker, templateSize);
    if (box) resolved.push({ n: marker.n, text: marker.text, box });
  }
  return resolved;
}

export async function captureGuideScreenshot({
  page,
  assetDir,
  name,
  markers = [],
  templateSize = null,
  screenshotOptions = {},
}) {
  const target = resolve(assetDir, name);
  const resolvedMarkers = await resolveGuideMarkers(page, markers, templateSize);
  await page.screenshot({ path: target, fullPage: false, ...screenshotOptions });
  return { path: target, markers: resolvedMarkers };
}

export async function loadGuideScreenshots({ assetDir, targetMetaPath, imagePaths }) {
  let targetMeta = {};
  try {
    targetMeta = JSON.parse(await readFile(targetMetaPath, "utf8"));
  } catch {
    targetMeta = {};
  }
  return Object.fromEntries(
    Object.entries(imagePaths).map(([key, fileName]) => [
      key,
      { path: resolve(assetDir, fileName), markers: targetMeta[key] ?? [] },
    ]),
  );
}

export function screenshotTargetMeta(screenshots) {
  return Object.fromEntries(
    Object.entries(screenshots).map(([key, image]) => [key, image.markers ?? []]),
  );
}

export function imagePathOf(image) {
  return typeof image === "string" ? image : image.path;
}

export function markerBoxStyle(box) {
  return `left:${box.x}%;top:${box.y}%;width:${box.width}%;height:${box.height}%;`;
}
