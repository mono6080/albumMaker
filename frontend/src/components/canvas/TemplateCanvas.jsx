// 模板畫布邊界：唯一擁有 Stage、camera、gesture、Transformer 與 viewport chrome。

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import Konva from "konva";
import toast from "react-hot-toast";
import { Group as KonvaGroup, Layer, Stage, Transformer } from "react-konva";

import CanvasArtwork from "./CanvasArtwork";
import { getCanvasElementRefFromTarget } from "./canvasHover.js";
import useCanvasCamera from "../../hooks/useCanvasCamera";
import { EDITOR_VIEWPORT_MODE } from "../../hooks/useEditorViewportMode";
import { canvasViewportPointToPage } from "../../utils/canvasCamera.js";
import {
  applyPhotoEditorUpdates,
} from "./pageElementNodes";
import {
  getPhotoContentRect,
  getPhotoFrameInsets,
  getPhotoSlotDimensionMode,
  snapPhotoSlotStandardRatio,
} from "../../utils/photoFrameGeometry.js";
import { getLayoutNodeData, getNodeLayerState } from "../../utils/layoutLayerState.js";
import { transformGroup } from "../../utils/layoutGroupCommands.js";
import {
  getMarqueeSelectableRefs,
  normalizeSelectionRect,
  pointIsInsideOrientedBounds,
} from "../../utils/marqueeSelection";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
  CANVAS_SCENE_PIXEL_RATIO,
  ELEMENT_ARRAY_KEY,
  toDisplayCoord,
  toRealCoord,
} from "../../utils/renderLayoutModel";

// Scene backing 固定使用 canonical 密度；Stage 與 hit canvas 仍維持 CSS 邏輯座標。
Konva.pixelRatio = CANVAS_SCENE_PIXEL_RATIO;

const DESKTOP_CANVAS_CAMERA = {
  mode: "manual",
  zoom: 1,
  viewX: 0,
  viewY: 0,
};
const CANVAS_ZOOM_STEP = 1.2;

function refKey(ref) {
  return ref ? `${ref.type}:${String(ref.id)}` : "";
}

function sameRef(left, right) {
  return refKey(left) === refKey(right);
}

function uniqueRefs(refs) {
  const seen = new Set();
  return (refs || []).filter((ref) => {
    const key = refKey(ref);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeDegrees(value) {
  const normalized = ((Number(value) || 0) + 180) % 360;
  return (normalized < 0 ? normalized + 360 : normalized) - 180;
}

function isKeyboardInputTarget(target) {
  const tagName = target?.tagName;
  return target?.isContentEditable
    || tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT";
}

function isPointInsideCanvasPage(point) {
  return point != null
    && point.x >= 0
    && point.x <= CANVAS_DISPLAY_WIDTH
    && point.y >= 0
    && point.y <= CANVAS_DISPLAY_HEIGHT;
}

const TemplateCanvas = forwardRef(function TemplateCanvas({
  layoutModel,
  pageSessionKey,
  templateId,
  pageIndex,
  backgroundUrl,
  viewportMode,
  activeTool,
  isMultiSelectMode,
  selectedRefs,
  isolationGroupId,
  selectionOverlay,
  onSelectRef,
  onReplaceSelection,
  onClearSelection,
  onActivateRef,
  onEnterGroup,
  onExitGroup,
  onRequestInspectorTab,
  onAddAtRealPoint,
  onUpdateElement,
  onCommitLayout,
  onGestureStateChange,
}, forwardedRef) {
  const {
    viewportRef,
    viewportSize,
    viewportSizeRef,
    camera,
    cameraRef,
    isReady: isCameraReady,
    fitToViewport,
    zoomAtPoint,
    panBy,
    applyPinch,
  } = useCanvasCamera();
  const [hoveredRef, setHoveredRef] = useState(null);
  const [marqueeGesture, setMarqueeGesture] = useState(null);
  const [previewResetToken, setPreviewResetToken] = useState(0);

  const stageRef = useRef(null);
  const pageCameraRef = useRef(null);
  const transformerRef = useRef(null);
  const activeGestureRef = useRef(null);
  const cameraGestureRef = useRef(null);
  const touchCandidateTargetRef = useRef(null);
  const isSpacePanPressedRef = useRef(false);
  const suppressNextStageClickRef = useRef(false);
  const multiTransformSnapshotRef = useRef(null);

  const isResponsiveCanvas = viewportMode !== EDITOR_VIEWPORT_MODE.DESKTOP;
  const isPhoneEditor = viewportMode === EDITOR_VIEWPORT_MODE.PHONE;
  const activeCamera = isResponsiveCanvas && isCameraReady
    ? camera
    : DESKTOP_CANVAS_CAMERA;
  const stageSize = isResponsiveCanvas
    ? {
        width: Math.max(1, viewportSize.width),
        height: Math.max(1, viewportSize.height),
      }
    : { width: CANVAS_DISPLAY_WIDTH, height: CANVAS_DISPLAY_HEIGHT };
  const selectedElement = selectedRefs.length === 1 ? selectedRefs[0] : null;
  const selectedLayerStates = selectedRefs.map(ref => layoutModel.getNodeLayerState(ref));
  const canEditSelection = selectedLayerStates.length > 0
    && selectedLayerStates.every(state => state.isVisible && !state.isLocked);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(layoutModel.layout);
  const marqueeDisplayRect = marqueeGesture?.active
    ? normalizeSelectionRect(marqueeGesture.startDisplay, marqueeGesture.currentDisplay)
    : null;

  const beginGesture = useCallback((kind) => {
    activeGestureRef.current = kind;
    setHoveredRef(null);
    onGestureStateChange(kind);
  }, [onGestureStateChange]);

  const endGesture = useCallback(() => {
    activeGestureRef.current = null;
    onGestureStateChange(null);
  }, [onGestureStateChange]);

  const setCameraInteractionListening = useCallback((isListening) => {
    pageCameraRef.current?.listening(isListening);
    transformerRef.current?.listening(isListening);
    stageRef.current?.batchDraw();
  }, []);

  const suppressImmediateStageClick = useCallback(() => {
    suppressNextStageClickRef.current = true;
  }, []);

  const finishCameraGesture = useCallback(({ suppressClick = true } = {}) => {
    const gesture = cameraGestureRef.current;
    if (!gesture || gesture.kind === "touch-blocked") return;
    cameraGestureRef.current = null;
    if (suppressClick) suppressImmediateStageClick();
    setCameraInteractionListening(true);
    const stageContainer = stageRef.current?.container();
    if (stageContainer) stageContainer.style.cursor = "";
    endGesture();
  }, [endGesture, setCameraInteractionListening, suppressImmediateStageClick]);

  const beginCameraGesture = useCallback((gesture, target) => {
    target?.stopDrag?.();
    cameraGestureRef.current = gesture;
    setMarqueeGesture(null);
    setCameraInteractionListening(false);
    beginGesture("camera");
    const stageContainer = stageRef.current?.container();
    if (stageContainer) stageContainer.style.cursor = "grabbing";
  }, [beginGesture, setCameraInteractionListening]);

  const getStageTouchPoints = useCallback((nativeEvent) => {
    const stage = stageRef.current;
    if (!stage) return [];
    stage.setPointersPositions(nativeEvent);
    return stage.getPointersPositions().map(point => ({ x: point.x, y: point.y }));
  }, []);

  const getPointerCoordinates = useCallback(() => {
    const viewportPosition = stageRef.current?.getPointerPosition();
    const displayPosition = pageCameraRef.current?.getRelativePointerPosition();
    if (!viewportPosition || !displayPosition) return null;
    return {
      viewport: viewportPosition,
      display: displayPosition,
      real: {
        x: toRealCoord(displayPosition.x),
        y: toRealCoord(displayPosition.y),
      },
    };
  }, []);

  useImperativeHandle(forwardedRef, () => ({
    fit() {
      if (isResponsiveCanvas) fitToViewport();
    },
    zoomBy(factor) {
      if (!isResponsiveCanvas || !Number.isFinite(factor) || factor <= 0) return;
      zoomAtPoint(cameraRef.current.zoom * factor);
    },
    getViewportCenterPagePoint() {
      if (!isResponsiveCanvas) {
        return { x: CANVAS_DISPLAY_WIDTH / 2, y: CANVAS_DISPLAY_HEIGHT / 2 };
      }
      const size = viewportSizeRef.current;
      if (size.width <= 0 || size.height <= 0) return null;
      return canvasViewportPointToPage({
        x: size.width / 2,
        y: size.height / 2,
      }, cameraRef.current);
    },
    getCameraSnapshot() {
      const current = isResponsiveCanvas ? cameraRef.current : DESKTOP_CANVAS_CAMERA;
      return Object.freeze({ ...current });
    },
  }), [
    cameraRef,
    fitToViewport,
    isResponsiveCanvas,
    viewportSizeRef,
    zoomAtPoint,
  ]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage) return;
    const nodes = selectedRefs
      .filter(ref => {
        const state = layoutModel.getNodeLayerState(ref);
        return state.isVisible && !state.isLocked;
      })
      .map(ref => stage.findOne(candidate => candidate.id() === `${ref.type}-${ref.id}`))
      .filter(Boolean);
    transformer.nodes(nodes);
    transformer.getLayer()?.batchDraw();
  }, [isolationGroupId, layoutModel, selectedRefs]);

  useEffect(() => {
    const redrawFrame = requestAnimationFrame(() => {
      transformerRef.current?.forceUpdate();
      transformerRef.current?.getLayer()?.batchDraw();
    });
    return () => cancelAnimationFrame(redrawFrame);
  }, [activeCamera.zoom, activeCamera.viewX, activeCamera.viewY]);

  useEffect(() => {
    cameraGestureRef.current = null;
    touchCandidateTargetRef.current = null;
    multiTransformSnapshotRef.current = null;
    setHoveredRef(null);
    setMarqueeGesture(null);
    setCameraInteractionListening(true);
    endGesture();
  }, [endGesture, pageSessionKey, setCameraInteractionListening]);

  useEffect(() => {
    if (activeTool !== "select") setHoveredRef(null);
  }, [activeTool]);

  const handleStagePointerDown = useCallback((event) => {
    if (cameraGestureRef.current) return;
    const nativeEvent = event.evt;
    const touchCount = nativeEvent?.touches?.length ?? 0;
    // 新的一指／滑鼠 pointer-down 代表下一個真正操作，可以解除前一個 gesture 的
    // click suppression；相同 gesture 尾端的 Konva 合成 tap 不會再觸發 pointer-down。
    if (touchCount < 2 && suppressNextStageClickRef.current) {
      suppressNextStageClickRef.current = false;
    }
    if (isResponsiveCanvas && touchCount === 1) {
      touchCandidateTargetRef.current = event.target;
    }
    if (isResponsiveCanvas && touchCount >= 2) {
      const isLayoutGesture = activeGestureRef.current != null
        && activeGestureRef.current !== "marquee";
      if (isLayoutGesture || transformerRef.current?.isTransforming()) {
        cameraGestureRef.current = { kind: "touch-blocked" };
        return;
      }
      const touchPoints = getStageTouchPoints(nativeEvent);
      if (touchPoints.length < 2) return;
      if (activeGestureRef.current === "marquee") endGesture();
      touchCandidateTargetRef.current?.stopDrag?.();
      touchCandidateTargetRef.current = null;
      beginCameraGesture({
        kind: "pinch",
        startCamera: { ...cameraRef.current },
        startTouches: touchPoints.slice(0, 2),
      }, event.target);
      nativeEvent.preventDefault?.();
      event.cancelBubble = true;
      return;
    }

    const pointerButton = nativeEvent?.button ?? 0;
    const shouldPanCamera = isResponsiveCanvas
      && (pointerButton === 1 || (pointerButton === 0 && isSpacePanPressedRef.current));
    if (shouldPanCamera) {
      beginCameraGesture({
        kind: "pan",
        lastClientX: nativeEvent.clientX,
        lastClientY: nativeEvent.clientY,
      }, event.target);
      nativeEvent.preventDefault?.();
      event.cancelBubble = true;
      return;
    }

    if (activeTool !== "select" || event.target !== event.target.getStage()) return;
    if (isPhoneEditor && touchCount === 1 && !isMultiSelectMode) return;
    if (pointerButton !== 0) return;
    const pointer = getPointerCoordinates();
    if (!pointer || !isPointInsideCanvasPage(pointer.display)) return;
    onRequestInspectorTab("properties");
    setMarqueeGesture({
      startViewport: pointer.viewport,
      currentViewport: pointer.viewport,
      startDisplay: pointer.display,
      currentDisplay: pointer.display,
      startReal: pointer.real,
      currentReal: pointer.real,
      additive: isMultiSelectMode || !!nativeEvent?.shiftKey,
      baseSelection: isMultiSelectMode || nativeEvent?.shiftKey ? [...selectedRefs] : [],
      active: false,
    });
    beginGesture("marquee");
  }, [
    activeTool,
    beginCameraGesture,
    beginGesture,
    cameraRef,
    endGesture,
    getPointerCoordinates,
    getStageTouchPoints,
    isMultiSelectMode,
    isPhoneEditor,
    isResponsiveCanvas,
    onRequestInspectorTab,
    selectedRefs,
  ]);

  const handleStagePointerMove = useCallback(() => {
    if (cameraGestureRef.current || !marqueeGesture) return;
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    const distance = Math.hypot(
      pointer.viewport.x - marqueeGesture.startViewport.x,
      pointer.viewport.y - marqueeGesture.startViewport.y,
    );
    const active = marqueeGesture.active || distance > 4;
    const nextGesture = {
      ...marqueeGesture,
      currentViewport: pointer.viewport,
      currentDisplay: pointer.display,
      currentReal: pointer.real,
      active,
    };
    setMarqueeGesture(nextGesture);
    if (!active) return;
    const selectionRect = normalizeSelectionRect(nextGesture.startReal, nextGesture.currentReal);
    const hits = getMarqueeSelectableRefs(layoutModel.layout, selectionRect, {
      parentGroupId: isolationGroupId,
    });
    onReplaceSelection(nextGesture.additive
      ? uniqueRefs([...nextGesture.baseSelection, ...hits])
      : hits);
  }, [getPointerCoordinates, isolationGroupId, layoutModel, marqueeGesture, onReplaceSelection]);

  const handleStageHoverMove = useCallback((event) => {
    if (activeTool !== "select" || activeGestureRef.current) {
      setHoveredRef(null);
      return;
    }
    const hitRef = getCanvasElementRefFromTarget(event.target, event.target?.getStage?.());
    const directRef = hitRef?.type === "group"
      ? layoutModel.getScopeNodes(isolationGroupId).find(ref => sameRef(ref, hitRef)) ?? null
      : layoutModel.resolveHitToDirectChild(isolationGroupId, hitRef);
    setHoveredRef(current => (sameRef(current, directRef) ? current : directRef));
  }, [activeTool, isolationGroupId, layoutModel]);

  const handleStagePointerUp = useCallback(() => {
    if (cameraGestureRef.current?.kind === "pan") {
      finishCameraGesture();
      return;
    }
    if (cameraGestureRef.current || !marqueeGesture) return;
    if (marqueeGesture.active) suppressImmediateStageClick();
    setMarqueeGesture(null);
    endGesture();
  }, [endGesture, finishCameraGesture, marqueeGesture, suppressImmediateStageClick]);

  const handleStageTouchMove = useCallback((event) => {
    const gesture = cameraGestureRef.current;
    if (gesture?.kind === "pinch") {
      const touchPoints = getStageTouchPoints(event.evt);
      if (touchPoints.length >= 2) {
        applyPinch(gesture.startCamera, gesture.startTouches, touchPoints.slice(0, 2));
      }
      event.evt.preventDefault?.();
      event.cancelBubble = true;
      return;
    }
    if (gesture?.kind === "touch-blocked") return;
    handleStagePointerMove();
  }, [applyPinch, getStageTouchPoints, handleStagePointerMove]);

  const handleStageTouchEnd = useCallback((event) => {
    const gesture = cameraGestureRef.current;
    if (gesture?.kind === "pinch") {
      if ((event.evt?.touches?.length ?? 0) === 0) {
        touchCandidateTargetRef.current = null;
        finishCameraGesture();
      }
      event.evt.preventDefault?.();
      event.cancelBubble = true;
      return;
    }
    if (gesture?.kind === "touch-blocked") {
      if ((event.evt?.touches?.length ?? 0) === 0) {
        cameraGestureRef.current = null;
        touchCandidateTargetRef.current = null;
      }
      return;
    }
    if ((event.evt?.touches?.length ?? 0) === 0) {
      if (event.evt?.type === "touchcancel") {
        touchCandidateTargetRef.current = null;
      } else {
        const touchTarget = touchCandidateTargetRef.current;
        requestAnimationFrame(() => {
          if (touchCandidateTargetRef.current === touchTarget) {
            touchCandidateTargetRef.current = null;
          }
        });
      }
    }
    handleStagePointerUp();
  }, [finishCameraGesture, handleStagePointerUp]);

  useEffect(() => {
    if (!isResponsiveCanvas) return undefined;
    const handleMouseMove = (mouseEvent) => {
      const gesture = cameraGestureRef.current;
      if (gesture?.kind !== "pan") return;
      const delta = {
        x: mouseEvent.clientX - gesture.lastClientX,
        y: mouseEvent.clientY - gesture.lastClientY,
      };
      gesture.lastClientX = mouseEvent.clientX;
      gesture.lastClientY = mouseEvent.clientY;
      panBy(delta);
      mouseEvent.preventDefault();
    };
    const handleMouseUp = () => {
      if (cameraGestureRef.current?.kind === "pan") {
        finishCameraGesture({ suppressClick: false });
      }
    };
    const recoverCameraInteraction = () => {
      isSpacePanPressedRef.current = false;
      if (cameraGestureRef.current?.kind === "touch-blocked") {
        cameraGestureRef.current = null;
        touchCandidateTargetRef.current = null;
        return;
      }
      if (cameraGestureRef.current) finishCameraGesture({ suppressClick: false });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") recoverCameraInteraction();
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", recoverCameraInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", recoverCameraInteraction);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      recoverCameraInteraction();
    };
  }, [finishCameraGesture, isResponsiveCanvas, panBy]);

  useEffect(() => {
    if (!isResponsiveCanvas) {
      isSpacePanPressedRef.current = false;
      return undefined;
    }
    const handleSpaceDown = (keyboardEvent) => {
      if (keyboardEvent.code !== "Space" || isKeyboardInputTarget(document.activeElement)) return;
      isSpacePanPressedRef.current = true;
      keyboardEvent.preventDefault();
    };
    const handleSpaceUp = (keyboardEvent) => {
      if (keyboardEvent.code === "Space") isSpacePanPressedRef.current = false;
    };
    window.addEventListener("keydown", handleSpaceDown);
    window.addEventListener("keyup", handleSpaceUp);
    return () => {
      window.removeEventListener("keydown", handleSpaceDown);
      window.removeEventListener("keyup", handleSpaceUp);
    };
  }, [isResponsiveCanvas]);

  useEffect(() => {
    if (isResponsiveCanvas || !cameraGestureRef.current) return;
    if (cameraGestureRef.current.kind === "touch-blocked") {
      cameraGestureRef.current = null;
      touchCandidateTargetRef.current = null;
      return;
    }
    finishCameraGesture({ suppressClick: false });
  }, [finishCameraGesture, isResponsiveCanvas]);

  useEffect(() => {
    if (!isResponsiveCanvas) return undefined;
    const stage = stageRef.current;
    const stageContainer = stage?.container();
    if (!stage || !stageContainer) return undefined;
    const handleCameraWheel = (wheelEvent) => {
      if (!wheelEvent.ctrlKey && !wheelEvent.metaKey) return;
      wheelEvent.preventDefault();
      stage.setPointersPositions(wheelEvent);
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const zoomFactor = Math.exp(-wheelEvent.deltaY * 0.002);
      zoomAtPoint(cameraRef.current.zoom * zoomFactor, pointer);
    };
    stageContainer.addEventListener("wheel", handleCameraWheel, { passive: false });
    return () => stageContainer.removeEventListener("wheel", handleCameraWheel);
  }, [cameraRef, isResponsiveCanvas, zoomAtPoint]);

  useEffect(() => {
    if (!marqueeGesture) return undefined;
    window.addEventListener("mouseup", handleStagePointerUp);
    window.addEventListener("touchend", handleStagePointerUp);
    window.addEventListener("touchcancel", handleStagePointerUp);
    return () => {
      window.removeEventListener("mouseup", handleStagePointerUp);
      window.removeEventListener("touchend", handleStagePointerUp);
      window.removeEventListener("touchcancel", handleStagePointerUp);
    };
  }, [handleStagePointerUp, marqueeGesture]);

  const handleStageDoubleClick = useCallback((event) => {
    if (activeTool !== "select" || isolationGroupId == null) return;
    if (event.target !== event.target.getStage()) return;
    const pointer = getPointerCoordinates();
    if (!pointer || !isPointInsideCanvasPage(pointer.display)) return;
    const currentBounds = layoutModel.getGroupBounds(isolationGroupId);
    if (!pointIsInsideOrientedBounds(pointer.real, currentBounds)) {
      event.cancelBubble = true;
      onExitGroup();
    }
  }, [activeTool, getPointerCoordinates, isolationGroupId, layoutModel, onExitGroup]);

  const handleStageClick = useCallback((event) => {
    // Konva 可能在 touchend handler 之前先合成 tap；camera gesture 期間的 tap
    // 只屬於縮放／平移，不得清除既有 selection 或觸發新增工具。
    if (cameraGestureRef.current) return;
    if (suppressNextStageClickRef.current) {
      suppressNextStageClickRef.current = false;
      return;
    }
    const pointer = getPointerCoordinates();
    if (!pointer) return;
    const isInsidePage = isPointInsideCanvasPage(pointer.display);
    if (["addPhotoPortrait", "addPhotoLandscape", "addText"].includes(activeTool)) {
      if (isInsidePage) onAddAtRealPoint(activeTool, pointer.real);
      return;
    }
    const touchStartedOnCanvasControl = touchCandidateTargetRef.current != null
      && touchCandidateTargetRef.current !== stageRef.current;
    if (event.target === stageRef.current
      && !touchStartedOnCanvasControl
      && !event.evt?.shiftKey
      && !isMultiSelectMode) {
      onClearSelection();
    }
  }, [activeTool, getPointerCoordinates, isMultiSelectMode, onAddAtRealPoint, onClearSelection]);

  const getMinimumMultiResizeFactor = useCallback(() => selectedRefs.reduce((minimumFactor, ref) => {
    const targetNode = stageRef.current?.findOne(
      candidate => candidate.id() === `${ref.type}-${ref.id}`,
    );
    if (!targetNode) return minimumFactor;
    const leafRefs = ref.type === "group" ? layoutModel.getDescendantLeafRefs(ref.id) : [ref];
    const scaleX = Math.max(Number.EPSILON, Math.abs(targetNode.scaleX()));
    const scaleY = Math.max(Number.EPSILON, Math.abs(targetNode.scaleY()));
    return leafRefs.reduce((leafMinimum, leafRef) => {
      const leafData = layoutModel.getNodeData(leafRef);
      if (!leafData) return leafMinimum;
      const dimensions = leafRef.type === "photo"
        ? getPhotoContentRect(leafData, { dimensionMode: photoSlotDimensionMode })
        : leafData;
      const width = Math.max(Number.EPSILON, Number(dimensions.width) || 0);
      const height = Math.max(Number.EPSILON, Number(dimensions.height) || 0);
      return Math.max(leafMinimum, 60 / (width * scaleX), 40 / (height * scaleY));
    }, minimumFactor);
  }, 0), [layoutModel, photoSlotDimensionMode, selectedRefs]);

  const handleMultiTransformStart = useCallback(() => {
    if (selectedRefs.length < 2 || !stageRef.current) return;
    const entries = selectedRefs.flatMap(ref => {
      const node = stageRef.current.findOne(
        candidate => candidate.id() === `${ref.type}-${ref.id}`,
      );
      if (!node) return [];
      return [{
        ref: { ...ref },
        node,
        initialNodeState: {
          x: node.x(),
          y: node.y(),
          rotation: node.rotation(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
        },
        bounds: ref.type === "group" ? layoutModel.getNodeBounds(ref) : null,
      }];
    });
    if (entries.length < 2) return;
    multiTransformSnapshotRef.current = { entries };
    beginGesture("multi-transform");
  }, [beginGesture, layoutModel, selectedRefs]);

  const handleMultiTransformEnd = useCallback(() => {
    const snapshot = multiTransformSnapshotRef.current;
    multiTransformSnapshotRef.current = null;
    if (!snapshot) {
      endGesture();
      return;
    }
    try {
      onCommitLayout(currentLayout => snapshot.entries.reduce((nextLayout, entry) => {
        const { ref, node, bounds } = entry;
        const layerState = getNodeLayerState(nextLayout, ref);
        if (!layerState.isVisible || layerState.isLocked) return nextLayout;
        if (ref.type === "group") {
          const scale = (Math.abs(node.scaleX()) + Math.abs(node.scaleY())) / 2;
          return transformGroup(nextLayout, ref.id, {
            dx: toRealCoord(node.x() - toDisplayCoord(bounds.centerX)),
            dy: toRealCoord(node.y() - toDisplayCoord(bounds.centerY)),
            rotationDelta: normalizeDegrees(node.rotation() - (bounds.rotation ?? 0)),
            scale,
          });
        }

        const sourceData = getLayoutNodeData(nextLayout, ref);
        const collectionKey = ELEMENT_ARRAY_KEY[ref.type];
        if (!sourceData || !collectionKey) return nextLayout;
        const scaleX = Math.abs(node.scaleX());
        const scaleY = Math.abs(node.scaleY());
        const sourceWidth = Math.max(Number.EPSILON, Number(sourceData.width) || 0);
        const sourceHeight = Math.max(Number.EPSILON, Number(sourceData.height) || 0);
        const width = Math.max(Math.min(60, sourceWidth), toRealCoord(node.width() * scaleX));
        const height = Math.max(Math.min(40, sourceHeight), toRealCoord(node.height() * scaleY));
        if (ref.type === "photo") {
          const dimensionMode = getPhotoSlotDimensionMode(nextLayout);
          let nextWidth = width;
          let nextHeight = height;
          const snapped = snapPhotoSlotStandardRatio(
            sourceData.width,
            sourceData.height,
            "width",
            nextWidth,
          );
          if (snapped) ({ width: nextWidth, height: nextHeight } = snapped);
          const insets = getPhotoFrameInsets(sourceData);
          const frameCenterX = toRealCoord(node.x());
          const frameCenterY = toRealCoord(node.y());
          const nextSlot = applyPhotoEditorUpdates(sourceData, {
            x: frameCenterX + (insets.left - insets.right) / 2 - nextWidth / 2,
            y: frameCenterY + (insets.top - insets.bottom) / 2 - nextHeight / 2,
            width: nextWidth,
            height: nextHeight,
            rotation: normalizeDegrees(node.rotation()),
          }, dimensionMode);
          return {
            ...nextLayout,
            [collectionKey]: (nextLayout[collectionKey] || []).map(item => (
              String(item.id) === String(ref.id) ? nextSlot : item
            )),
          };
        }
        const updates = {
          x: toRealCoord(node.x()) - width / 2,
          y: toRealCoord(node.y()) - height / 2,
          width,
          height,
          rotation: normalizeDegrees(node.rotation()),
        };
        return {
          ...nextLayout,
          [collectionKey]: (nextLayout[collectionKey] || []).map(item => (
            String(item.id) === String(ref.id) ? { ...item, ...updates } : item
          )),
        };
      }, currentLayout));
      snapshot.entries.forEach(({ ref, node }) => {
        node.scale({ x: 1, y: 1 });
        const visualId = ref.type === "group"
          ? `group-visual-${ref.id}`
          : ref.type === "photo" ? `photo-visual-${ref.id}` : null;
        const visualNode = visualId == null
          ? null
          : node.getLayer()?.findOne(candidate => candidate.id() === visualId);
        if (visualNode) {
          visualNode.position(node.position());
          visualNode.rotation(node.rotation());
          visualNode.scale({ x: 1, y: 1 });
        }
      });
      transformerRef.current?.forceUpdate();
    } catch (error) {
      snapshot.entries.forEach(({ ref, node, initialNodeState }) => {
        node.position({ x: initialNodeState.x, y: initialNodeState.y });
        node.rotation(initialNodeState.rotation);
        node.scale({ x: initialNodeState.scaleX, y: initialNodeState.scaleY });
        const visualId = ref.type === "group"
          ? `group-visual-${ref.id}`
          : ref.type === "photo" ? `photo-visual-${ref.id}` : null;
        const visualNode = visualId == null
          ? null
          : node.getLayer()?.findOne(candidate => candidate.id() === visualId);
        if (visualNode) {
          visualNode.position(node.position());
          visualNode.rotation(node.rotation());
          visualNode.scale(node.scale());
        }
      });
      transformerRef.current?.forceUpdate();
      toast.error(error?.message || "無法變形多選物件");
    } finally {
      setPreviewResetToken(current => current + 1);
      endGesture();
    }
  }, [endGesture, onCommitLayout]);

  const handleCanvasError = useCallback((message) => toast.error(message), []);

  return (
    <>
      <div
        ref={viewportRef}
        style={{
          cursor: activeTool === "select" ? "default" : "crosshair",
          touchAction: isResponsiveCanvas ? "none" : undefined,
        }}
        className={`relative min-h-0 overflow-hidden border border-gray-300 bg-gray-100 select-none ${
          isResponsiveCanvas
            ? isPhoneEditor
              ? "h-full w-full rounded-none border-x-0"
              : "h-full w-full rounded"
            : "h-[752px] w-[532px] bg-white"
        }`}
        data-guide="editor-canvas-viewport"
        data-canvas-viewport={isResponsiveCanvas ? "responsive" : "desktop"}
      >
        <div className="absolute inset-0" data-guide="canvas-frame">
          {selectionOverlay}
          {isResponsiveCanvas && (
            <div
              className="absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-gray-200 bg-white/95 p-1 shadow-lg backdrop-blur"
              role="toolbar"
              aria-label="畫布縮放"
            >
              <button
                type="button"
                data-guide="zoom-out"
                aria-label="縮小畫布"
                disabled={!isCameraReady}
                onClick={() => zoomAtPoint(cameraRef.current.zoom / CANVAS_ZOOM_STEP)}
                className="inline-flex h-11 min-w-11 items-center justify-center rounded-lg text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-40"
              >
                −
              </button>
              <span className="min-w-12 text-center text-xs font-medium text-gray-600" aria-live="polite">
                {Math.round(activeCamera.zoom * 100)}%
              </span>
              <button
                type="button"
                data-guide="zoom-fit"
                disabled={!isCameraReady}
                onClick={fitToViewport}
                className="inline-flex min-h-11 min-w-20 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
              >
                適合畫面
              </button>
              <button
                type="button"
                data-guide="zoom-in"
                aria-label="放大畫布"
                disabled={!isCameraReady}
                onClick={() => zoomAtPoint(cameraRef.current.zoom * CANVAS_ZOOM_STEP)}
                className="inline-flex h-11 min-w-11 items-center justify-center rounded-lg text-lg text-gray-600 hover:bg-gray-100 disabled:opacity-40"
              >
                ＋
              </button>
            </div>
          )}
          <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            onClick={handleStageClick}
            onTap={handleStageClick}
            onMouseDown={handleStagePointerDown}
            onMouseMove={(event) => {
              handleStagePointerMove();
              handleStageHoverMove(event);
            }}
            onMouseUp={handleStagePointerUp}
            onMouseLeave={() => setHoveredRef(null)}
            onTouchStart={handleStagePointerDown}
            onTouchMove={handleStageTouchMove}
            onTouchEnd={handleStageTouchEnd}
            onTouchCancel={handleStageTouchEnd}
            onDblClick={handleStageDoubleClick}
            onDblTap={handleStageDoubleClick}
          >
            <Layer>
              <KonvaGroup
                ref={pageCameraRef}
                id="page-camera"
                x={activeCamera.viewX}
                y={activeCamera.viewY}
                scaleX={activeCamera.zoom}
                scaleY={activeCamera.zoom}
              >
                <KonvaGroup
                  clipX={0}
                  clipY={0}
                  clipWidth={CANVAS_DISPLAY_WIDTH}
                  clipHeight={CANVAS_DISPLAY_HEIGHT}
                >
                  <CanvasArtwork
                    layoutModel={layoutModel}
                    pageSessionKey={pageSessionKey}
                    previewResetToken={previewResetToken}
                    templateId={templateId}
                    pageIndex={pageIndex}
                    backgroundUrl={backgroundUrl}
                    activeTool={activeTool}
                    selectedRefs={selectedRefs}
                    hoveredRef={hoveredRef}
                    isolationGroupId={isolationGroupId}
                    marqueeDisplayRect={marqueeDisplayRect}
                    onUpdateElement={onUpdateElement}
                    onSelectRef={onSelectRef}
                    onActivateRef={onActivateRef}
                    onEnterGroup={onEnterGroup}
                    onCommitLayout={onCommitLayout}
                    onGestureStart={beginGesture}
                    onGestureEnd={endGesture}
                    onError={handleCanvasError}
                  />
                </KonvaGroup>
              </KonvaGroup>

              <Transformer
                ref={transformerRef}
                resizeEnabled={selectedRefs.length > 0 && canEditSelection}
                keepRatio={selectedRefs.length > 1 || selectedElement?.type === "group"
                  || (selectedElement?.type === "photo" && isolationGroupId == null)}
                flipEnabled={false}
                rotateEnabled={selectedRefs.length > 0 && canEditSelection}
                centeredScaling={selectedElement?.type === "group"}
                onTransformStart={selectedRefs.length > 1 ? handleMultiTransformStart : undefined}
                onTransformEnd={selectedRefs.length > 1 ? handleMultiTransformEnd : undefined}
                borderStroke="#4F46E5"
                borderStrokeWidth={1}
                anchorFill="#4F46E5"
                anchorStroke="#ffffff"
                anchorStrokeWidth={1}
                anchorSize={isResponsiveCanvas ? 14 : 8}
                anchorStyleFunc={(anchor) => {
                  anchor.hitStrokeWidth(isResponsiveCanvas ? 44 : 10);
                }}
                rotateAnchorOffset={isResponsiveCanvas ? 28 : 20}
                enabledAnchors={selectedRefs.length === 0 || !canEditSelection
                  ? []
                  : selectedRefs.length > 1
                    || selectedElement?.type === "group"
                    || selectedElement?.type === "photo"
                    ? ["top-left", "top-right", "bottom-left", "bottom-right"]
                    : [
                        "top-left", "top-center", "top-right",
                        "middle-left", "middle-right",
                        "bottom-left", "bottom-center", "bottom-right",
                      ]}
                boundBoxFunc={(oldBox, newBox) => {
                  const isShrinking = Math.abs(newBox.width) < Math.abs(oldBox.width)
                    || Math.abs(newBox.height) < Math.abs(oldBox.height);
                  const minimumScale = activeCamera.zoom;
                  if (isShrinking
                    && (Math.abs(newBox.width) < toDisplayCoord(60) * minimumScale
                      || Math.abs(newBox.height) < toDisplayCoord(40) * minimumScale)) {
                    return oldBox;
                  }
                  if (selectedRefs.length > 1
                    && Math.abs((newBox.rotation ?? 0) - (oldBox.rotation ?? 0)) < 1e-6) {
                    const resizeFactor = Math.min(
                      Math.abs(newBox.width / oldBox.width),
                      Math.abs(newBox.height / oldBox.height),
                    );
                    if (resizeFactor < 1 && resizeFactor < getMinimumMultiResizeFactor()) return oldBox;
                  }
                  return newBox;
                }}
              />
            </Layer>
          </Stage>
        </div>
      </div>
      <p className="mt-1.5 hidden text-xs text-gray-400 md:block">
        提示：點選工具後在畫布上點擊放置；拖曳移動；四角拖曳調整大小；頂部圓點旋轉
      </p>
    </>
  );
});

export default TemplateCanvas;
