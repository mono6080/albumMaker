// 模板畫布內容：只依賴 immutable editor layout model，不接收 camera state。

import { memo, useEffect, useMemo, useState } from "react";
import {
  Group as KonvaGroup,
  Image as KonvaImage,
  Rect,
  Text as KonvaText,
} from "react-konva";

import CanvasNode from "./CanvasNode";
import { renderFooterNode } from "./pageElementNodes";
import { getPhotoSlotDimensionMode } from "../../utils/photoFrameGeometry.js";
import {
  CANVAS_DISPLAY_HEIGHT,
  CANVAS_DISPLAY_WIDTH,
} from "../../utils/renderLayoutModel";

function refKey(ref) {
  return ref ? `${ref.type}:${String(ref.id)}` : "";
}

function CanvasArtwork({
  layoutModel,
  pageSessionKey,
  previewResetToken,
  templateId,
  pageIndex,
  backgroundUrl,
  activeTool,
  selectedRefs,
  hoveredRef,
  isolationGroupId,
  marqueeDisplayRect,
  onUpdateElement,
  onSelectRef,
  onActivateRef,
  onEnterGroup,
  onCommitLayout,
  onGestureStart,
  onGestureEnd,
  onError,
}) {
  const [backgroundImage, setBackgroundImage] = useState(null);
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(layoutModel.layout);
  const visiblePhotoOrdinals = layoutModel.getVisibleElementOrdinals("photo");

  useEffect(() => {
    if (!backgroundUrl) {
      setBackgroundImage(null);
      return;
    }
    const image = new window.Image();
    image.src = backgroundUrl;
    image.onload = () => setBackgroundImage(image);
    image.onerror = () => setBackgroundImage(null);
  }, [backgroundUrl]);

  const scene = useMemo(() => {
    const activeScopeRefs = layoutModel.getScopeNodes(isolationGroupId);
    const activeScopeCanvasNodes = activeScopeRefs
      .map(ref => layoutModel.getRenderNode(ref, { visibleOnly: true }))
      .filter(Boolean);
    const flattenedSceneLeaves = layoutModel.visibleFlattenedLeaves;
    const activeLeafKeys = new Set(
      isolationGroupId == null
        ? []
        : layoutModel.getDescendantLeafRefs(isolationGroupId).map(refKey),
    );
    const activeLeafIndices = flattenedSceneLeaves
      .map((node, index) => (activeLeafKeys.has(refKey(node)) ? index : -1))
      .filter(index => index >= 0);
    const activeSceneStart = activeLeafIndices.length ? activeLeafIndices[0] : 0;
    const activeSceneEnd = activeLeafIndices.length
      ? activeLeafIndices[activeLeafIndices.length - 1]
      : -1;
    return {
      activeScopeCanvasNodes,
      passiveSceneBefore: isolationGroupId == null
        ? []
        : flattenedSceneLeaves.slice(0, activeSceneStart),
      passiveSceneAfter: isolationGroupId == null
        ? []
        : flattenedSceneLeaves.slice(activeSceneEnd + 1),
    };
  }, [isolationGroupId, layoutModel]);

  const nodeProps = {
    layoutModel,
    pageSessionKey,
    previewResetToken,
    activeTool,
    selectedRefs,
    hoveredRef,
    templateId,
    pageIndex,
    photoSlotDimensionMode,
    visiblePhotoOrdinals,
    onUpdateElement,
    onSelectRef,
    onActivateRef,
    onEnterGroup,
    onCommitLayout,
    onGestureStart,
    onGestureEnd,
    onError,
  };

  const renderActiveNode = node => (
    <CanvasNode key={`active-${node.type}-${node.id}`} node={node} {...nodeProps} />
  );
  const renderPassiveLeaf = node => (
    <KonvaGroup key={`passive-${node.type}-${node.id}`} opacity={0.25} listening={false}>
      <CanvasNode node={node} disabled {...nodeProps} />
    </KonvaGroup>
  );

  return (
    <>
      <Rect
        x={0}
        y={0}
        width={CANVAS_DISPLAY_WIDTH}
        height={CANVAS_DISPLAY_HEIGHT}
        fill="#ffffff"
        listening={false}
      />

      {backgroundImage ? (
        <KonvaImage
          image={backgroundImage}
          x={0}
          y={0}
          width={CANVAS_DISPLAY_WIDTH}
          height={CANVAS_DISPLAY_HEIGHT}
          listening={false}
        />
      ) : (
        <KonvaText
          x={0}
          y={CANVAS_DISPLAY_HEIGHT / 2 - 10}
          width={CANVAS_DISPLAY_WIDTH}
          text="請上傳背景圖"
          fontSize={14}
          fill="#CCCCCC"
          align="center"
          listening={false}
        />
      )}

      {isolationGroupId == null ? (
        scene.activeScopeCanvasNodes.map(renderActiveNode)
      ) : (
        <>
          {scene.passiveSceneBefore.map(renderPassiveLeaf)}
          {scene.activeScopeCanvasNodes.map(renderActiveNode)}
          {scene.passiveSceneAfter.map(renderPassiveLeaf)}
        </>
      )}

      {renderFooterNode(layoutModel.layout?.footer)}

      {marqueeDisplayRect && (
        <Rect
          x={marqueeDisplayRect.x}
          y={marqueeDisplayRect.y}
          width={marqueeDisplayRect.width}
          height={marqueeDisplayRect.height}
          fill="rgba(79,70,229,0.08)"
          stroke="#4F46E5"
          strokeWidth={1}
          strokeScaleEnabled={false}
          dash={[5, 3]}
          listening={false}
        />
      )}
    </>
  );
}

export default memo(CanvasArtwork);
