import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  clampCanvasCamera,
  createCanvasFitCamera,
  panCanvasCameraBy,
  resizeCanvasCamera,
  updateCanvasCameraFromPinch,
  zoomCanvasCameraAtPoint,
} from "../utils/canvasCamera.js";

const EMPTY_VIEWPORT_SIZE = { width: 0, height: 0 };
const INITIAL_CAMERA = {
  mode: "fit",
  zoom: 1,
  viewX: 0,
  viewY: 0,
};

function hasViewportArea(viewportSize) {
  return viewportSize.width > 0 && viewportSize.height > 0;
}

export default function useCanvasCamera() {
  const [viewportElement, setViewportElement] = useState(null);
  const [viewportSize, setViewportSize] = useState(EMPTY_VIEWPORT_SIZE);
  const [camera, setCamera] = useState(INITIAL_CAMERA);
  const cameraRef = useRef(INITIAL_CAMERA);
  const viewportSizeRef = useRef(EMPTY_VIEWPORT_SIZE);
  const previousViewportSizeRef = useRef(null);

  const viewportRef = useCallback((element) => {
    setViewportElement(element);
  }, []);

  const commitCamera = useCallback((nextCamera) => {
    cameraRef.current = nextCamera;
    setCamera(nextCamera);
    return nextCamera;
  }, []);

  useLayoutEffect(() => {
    if (!viewportElement) return undefined;

    const updateViewportSize = (width, height) => {
      if (width <= 0 || height <= 0) return;
      setViewportSize(currentSize => (
        currentSize.width === width && currentSize.height === height
          ? currentSize
          : { width, height }
      ));
    };
    updateViewportSize(viewportElement.clientWidth, viewportElement.clientHeight);

    const observer = new ResizeObserver((entries) => {
      const contentRect = entries[0]?.contentRect;
      if (contentRect) updateViewportSize(contentRect.width, contentRect.height);
    });
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, [viewportElement]);

  useLayoutEffect(() => {
    if (!hasViewportArea(viewportSize)) return;
    const previousViewportSize = previousViewportSizeRef.current;
    const nextCamera = previousViewportSize == null
      ? createCanvasFitCamera(viewportSize)
      : resizeCanvasCamera(cameraRef.current, previousViewportSize, viewportSize);
    viewportSizeRef.current = viewportSize;
    previousViewportSizeRef.current = viewportSize;
    commitCamera(nextCamera);
  }, [commitCamera, viewportSize]);

  const fitToViewport = useCallback(() => {
    if (!hasViewportArea(viewportSizeRef.current)) return cameraRef.current;
    return commitCamera(createCanvasFitCamera(viewportSizeRef.current));
  }, [commitCamera]);

  const setManualCamera = useCallback((cameraUpdater) => {
    if (!hasViewportArea(viewportSizeRef.current)) return cameraRef.current;
    const currentCamera = cameraRef.current;
    const requestedCamera = typeof cameraUpdater === "function"
      ? cameraUpdater(currentCamera)
      : cameraUpdater;
    return commitCamera(clampCanvasCamera({
      ...requestedCamera,
      mode: "manual",
    }, viewportSizeRef.current));
  }, [commitCamera]);

  const zoomAtPoint = useCallback((nextZoom, anchorPoint = null) => {
    if (!hasViewportArea(viewportSizeRef.current)) return cameraRef.current;
    const resolvedAnchor = anchorPoint ?? {
      x: viewportSizeRef.current.width / 2,
      y: viewportSizeRef.current.height / 2,
    };
    return commitCamera(zoomCanvasCameraAtPoint(
      cameraRef.current,
      nextZoom,
      resolvedAnchor,
      viewportSizeRef.current,
    ));
  }, [commitCamera]);

  const panBy = useCallback((delta) => {
    if (!hasViewportArea(viewportSizeRef.current)) return cameraRef.current;
    return commitCamera(panCanvasCameraBy(
      cameraRef.current,
      delta,
      viewportSizeRef.current,
    ));
  }, [commitCamera]);

  const applyPinch = useCallback((startCamera, startTouches, currentTouches) => {
    if (!hasViewportArea(viewportSizeRef.current)) return cameraRef.current;
    return commitCamera(updateCanvasCameraFromPinch(
      startCamera,
      startTouches,
      currentTouches,
      viewportSizeRef.current,
    ));
  }, [commitCamera]);

  return {
    viewportRef,
    viewportSize,
    viewportSizeRef,
    camera,
    cameraRef,
    isReady: hasViewportArea(viewportSize),
    fitToViewport,
    setManualCamera,
    zoomAtPoint,
    panBy,
    applyPinch,
  };
}
