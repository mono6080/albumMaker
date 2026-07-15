import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
} from "./renderLayoutModel.js";

export const CANVAS_CAMERA_GUTTER = 12;
export const CANVAS_CAMERA_MAX_ZOOM = 3;
export const CANVAS_CAMERA_PREFERRED_MIN_ZOOM = 0.5;

function clampValue(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function getPointBetween(firstPoint, secondPoint) {
  return {
    x: (firstPoint.x + secondPoint.x) / 2,
    y: (firstPoint.y + secondPoint.y) / 2,
  };
}

function getPointDistance(firstPoint, secondPoint) {
  return Math.hypot(
    secondPoint.x - firstPoint.x,
    secondPoint.y - firstPoint.y,
  );
}

function clampCameraAxis(position, viewportSize, contentSize) {
  if (contentSize + CANVAS_CAMERA_GUTTER * 2 <= viewportSize) {
    return (viewportSize - contentSize) / 2;
  }
  return clampValue(
    position,
    viewportSize - contentSize - CANVAS_CAMERA_GUTTER,
    CANVAS_CAMERA_GUTTER,
  );
}

export function getCanvasFitZoom(viewportSize) {
  return Math.min(
    1,
    (viewportSize.width - CANVAS_CAMERA_GUTTER * 2) / CANVAS_DISPLAY_WIDTH,
    (viewportSize.height - CANVAS_CAMERA_GUTTER * 2) / CANVAS_DISPLAY_HEIGHT,
  );
}

export function getCanvasCameraZoomRange(viewportSize) {
  const fitZoom = getCanvasFitZoom(viewportSize);
  return {
    fitZoom,
    minimumZoom: Math.min(fitZoom, CANVAS_CAMERA_PREFERRED_MIN_ZOOM),
    maximumZoom: CANVAS_CAMERA_MAX_ZOOM,
  };
}

export function clampCanvasCamera(camera, viewportSize) {
  const { minimumZoom, maximumZoom } = getCanvasCameraZoomRange(viewportSize);
  const zoom = clampValue(camera.zoom, minimumZoom, maximumZoom);
  return {
    ...camera,
    zoom,
    viewX: clampCameraAxis(
      camera.viewX,
      viewportSize.width,
      CANVAS_DISPLAY_WIDTH * zoom,
    ),
    viewY: clampCameraAxis(
      camera.viewY,
      viewportSize.height,
      CANVAS_DISPLAY_HEIGHT * zoom,
    ),
  };
}

export function createCanvasFitCamera(viewportSize) {
  const zoom = getCanvasFitZoom(viewportSize);
  return clampCanvasCamera({
    mode: "fit",
    zoom,
    viewX: (viewportSize.width - CANVAS_DISPLAY_WIDTH * zoom) / 2,
    viewY: (viewportSize.height - CANVAS_DISPLAY_HEIGHT * zoom) / 2,
  }, viewportSize);
}

export function canvasViewportPointToPage(point, camera) {
  return {
    x: (point.x - camera.viewX) / camera.zoom,
    y: (point.y - camera.viewY) / camera.zoom,
  };
}

export function canvasPagePointToViewport(point, camera) {
  return {
    x: camera.viewX + point.x * camera.zoom,
    y: camera.viewY + point.y * camera.zoom,
  };
}

export function zoomCanvasCameraAtPoint(camera, nextZoom, anchorPoint, viewportSize) {
  const pageAnchor = canvasViewportPointToPage(anchorPoint, camera);
  const { minimumZoom, maximumZoom } = getCanvasCameraZoomRange(viewportSize);
  const zoom = clampValue(nextZoom, minimumZoom, maximumZoom);
  return clampCanvasCamera({
    mode: "manual",
    zoom,
    viewX: anchorPoint.x - pageAnchor.x * zoom,
    viewY: anchorPoint.y - pageAnchor.y * zoom,
  }, viewportSize);
}

export function panCanvasCameraBy(camera, delta, viewportSize) {
  return clampCanvasCamera({
    ...camera,
    mode: "manual",
    viewX: camera.viewX + delta.x,
    viewY: camera.viewY + delta.y,
  }, viewportSize);
}

export function updateCanvasCameraFromPinch(
  startCamera,
  startTouches,
  currentTouches,
  viewportSize,
) {
  const startCenter = getPointBetween(startTouches[0], startTouches[1]);
  const currentCenter = getPointBetween(currentTouches[0], currentTouches[1]);
  const startDistance = getPointDistance(startTouches[0], startTouches[1]);
  const currentDistance = getPointDistance(currentTouches[0], currentTouches[1]);
  const zoomRatio = startDistance > 0 ? currentDistance / startDistance : 1;
  const pageAnchor = canvasViewportPointToPage(startCenter, startCamera);
  const { minimumZoom, maximumZoom } = getCanvasCameraZoomRange(viewportSize);
  const zoom = clampValue(
    startCamera.zoom * zoomRatio,
    minimumZoom,
    maximumZoom,
  );

  return clampCanvasCamera({
    mode: "manual",
    zoom,
    viewX: currentCenter.x - pageAnchor.x * zoom,
    viewY: currentCenter.y - pageAnchor.y * zoom,
  }, viewportSize);
}

export function resizeCanvasCamera(camera, previousViewportSize, nextViewportSize) {
  if (camera.mode === "fit") return createCanvasFitCamera(nextViewportSize);

  const previousCenter = {
    x: previousViewportSize.width / 2,
    y: previousViewportSize.height / 2,
  };
  const nextCenter = {
    x: nextViewportSize.width / 2,
    y: nextViewportSize.height / 2,
  };
  const centerPagePoint = canvasViewportPointToPage(previousCenter, camera);
  const { minimumZoom, maximumZoom } = getCanvasCameraZoomRange(nextViewportSize);
  const zoom = clampValue(camera.zoom, minimumZoom, maximumZoom);

  return clampCanvasCamera({
    mode: "manual",
    zoom,
    viewX: nextCenter.x - centerPagePoint.x * zoom,
    viewY: nextCenter.y - centerPagePoint.y * zoom,
  }, nextViewportSize);
}
