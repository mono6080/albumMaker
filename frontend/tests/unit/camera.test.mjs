import assert from "node:assert/strict";
import { getCanvasElementRefFromTarget } from "../../src/components/canvas/canvasHover.js";
import {
  canvasPagePointToViewport,
  canvasViewportPointToPage,
  clampCanvasCamera,
  createCanvasFitCamera,
  getCanvasCameraZoomRange,
  getCanvasFitZoom,
  resizeCanvasCamera,
  updateCanvasCameraFromPinch,
  zoomCanvasCameraAtPoint,
} from "../../src/utils/canvasCamera.js";
import { test } from "./harness.mjs";


test("canvas hover resolves the nearest selectable Konva ancestor", () => {
  const stage = {};
  const groupNode = {
    id: () => "group-family-a",
    getParent: () => stage,
  };
  const elementNode = {
    id: () => "text-label-42",
    getParent: () => groupNode,
  };
  const hitRect = {
    id: () => "",
    getParent: () => elementNode,
    getStage: () => stage,
  };

  assert.deepEqual(getCanvasElementRefFromTarget(hitRect), { type: "text", id: "label-42" });
  assert.deepEqual(getCanvasElementRefFromTarget(groupNode, stage), { type: "group", id: "family-a" });
  assert.equal(getCanvasElementRefFromTarget(stage, stage), null);
});


test("canvas camera fit keeps the full page inside a 12px viewport gutter", () => {
  const portraitViewport = { width: 390, height: 844 };
  const portraitFitZoom = (390 - 24) / 530;
  assert.equal(getCanvasFitZoom(portraitViewport), portraitFitZoom);
  assert.deepEqual(createCanvasFitCamera(portraitViewport), {
    mode: "fit",
    zoom: portraitFitZoom,
    viewX: 12,
    viewY: (844 - 750 * portraitFitZoom) / 2,
  });

  const landscapeViewport = { width: 844, height: 390 };
  const landscapeFitZoom = (390 - 24) / 750;
  assert.equal(getCanvasFitZoom(landscapeViewport), landscapeFitZoom);
  assert.deepEqual(createCanvasFitCamera(landscapeViewport), {
    mode: "fit",
    zoom: landscapeFitZoom,
    viewX: (844 - 530 * landscapeFitZoom) / 2,
    viewY: 12,
  });

  assert.equal(getCanvasFitZoom({ width: 1000, height: 1000 }), 1);
});


test("canvas camera zoom uses an absolute dynamic minimum and maximum of three", () => {
  const portraitViewport = { width: 390, height: 844 };
  assert.deepEqual(getCanvasCameraZoomRange(portraitViewport), {
    fitZoom: (390 - 24) / 530,
    minimumZoom: 0.5,
    maximumZoom: 3,
  });
  const landscapeViewport = { width: 844, height: 390 };
  const landscapeFitZoom = (390 - 24) / 750;
  assert.deepEqual(getCanvasCameraZoomRange(landscapeViewport), {
    fitZoom: landscapeFitZoom,
    minimumZoom: landscapeFitZoom,
    maximumZoom: 3,
  });
});


test("canvas camera clamp centers small content and keeps large page edges reachable", () => {
  const viewportSize = { width: 390, height: 500 };
  assert.deepEqual(clampCanvasCamera({
    mode: "manual",
    zoom: 0.5,
    viewX: -999,
    viewY: 999,
  }, viewportSize), {
    mode: "manual",
    zoom: 0.5,
    viewX: (390 - 530 * 0.5) / 2,
    viewY: (500 - 750 * 0.5) / 2,
  });
  assert.deepEqual(clampCanvasCamera({
    mode: "manual",
    zoom: 1,
    viewX: -999,
    viewY: 999,
  }, viewportSize), {
    mode: "manual",
    zoom: 1,
    viewX: 390 - 530 - 12,
    viewY: 12,
  });
});


test("canvas camera viewport and page point conversions round trip", () => {
  const camera = { mode: "manual", zoom: 1.75, viewX: -123, viewY: 48 };
  const pagePoint = { x: 284.25, y: 619.5 };
  const viewportPoint = canvasPagePointToViewport(pagePoint, camera);
  const roundTripPoint = canvasViewportPointToPage(viewportPoint, camera);
  assert.ok(Math.abs(roundTripPoint.x - pagePoint.x) < 1e-9);
  assert.ok(Math.abs(roundTripPoint.y - pagePoint.y) < 1e-9);
});


test("canvas camera zoom keeps its viewport anchor over the same page point", () => {
  const viewportSize = { width: 390, height: 500 };
  const camera = { mode: "manual", zoom: 1, viewX: -100, viewY: -200 };
  const anchorPoint = { x: 100, y: 100 };
  const pagePointBefore = canvasViewportPointToPage(anchorPoint, camera);
  const zoomed = zoomCanvasCameraAtPoint(camera, 2, anchorPoint, viewportSize);
  const pagePointAfter = canvasViewportPointToPage(anchorPoint, zoomed);
  assert.deepEqual(zoomed, {
    mode: "manual",
    zoom: 2,
    viewX: -300,
    viewY: -500,
  });
  assert.deepEqual(pagePointAfter, pagePointBefore);
});


test("canvas camera pinch preserves the start page anchor while zooming and panning", () => {
  const viewportSize = { width: 390, height: 500 };
  const startCamera = { mode: "manual", zoom: 1, viewX: -100, viewY: -200 };
  const startTouches = [{ x: 80, y: 100 }, { x: 120, y: 100 }];
  const currentTouches = [{ x: 100, y: 120 }, { x: 180, y: 120 }];
  const startPageAnchor = canvasViewportPointToPage({ x: 100, y: 100 }, startCamera);
  const pinched = updateCanvasCameraFromPinch(
    startCamera,
    startTouches,
    currentTouches,
    viewportSize,
  );
  assert.deepEqual(pinched, {
    mode: "manual",
    zoom: 2,
    viewX: -260,
    viewY: -480,
  });
  assert.deepEqual(
    canvasViewportPointToPage({ x: 140, y: 120 }, pinched),
    startPageAnchor,
  );
});


test("canvas camera manual resize preserves the old center page point", () => {
  const previousViewportSize = { width: 390, height: 500 };
  const nextViewportSize = { width: 500, height: 700 };
  const camera = { mode: "manual", zoom: 2, viewX: -300, viewY: -500 };
  const pagePointBefore = canvasViewportPointToPage({ x: 195, y: 250 }, camera);
  const resized = resizeCanvasCamera(camera, previousViewportSize, nextViewportSize);
  const pagePointAfter = canvasViewportPointToPage({ x: 250, y: 350 }, resized);
  assert.deepEqual(resized, {
    mode: "manual",
    zoom: 2,
    viewX: -245,
    viewY: -400,
  });
  assert.deepEqual(pagePointAfter, pagePointBefore);

  const fitResized = resizeCanvasCamera(
    createCanvasFitCamera(previousViewportSize),
    previousViewportSize,
    nextViewportSize,
  );
  assert.deepEqual(fitResized, createCanvasFitCamera(nextViewportSize));
});
