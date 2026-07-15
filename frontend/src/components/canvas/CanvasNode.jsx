// 模板畫布節點：封裝 leaf / group 的即時預覽與 gesture-end commit 生命週期。

import { Fragment, memo, useEffect, useState } from "react";
import { Group as KonvaGroup, Rect } from "react-konva";

import {
  makeGroupProps,
  makePhotoControlProps,
  renderPhotoSlotNode,
  renderTextLabelNode,
} from "./pageElementNodes";
import StickerNode from "./StickerNode";
import {
  OBJECT_HOVER_OUTLINE_NAME,
  OBJECT_HOVER_STROKE,
  OBJECT_HOVER_STROKE_WIDTH,
} from "./canvasHover.js";
import { flattenRenderNodes } from "../../utils/layoutGroupContractGraph.js";
import { transformGroup } from "../../utils/layoutGroupCommands.js";
import { toDisplayCoord, toRealCoord } from "../../utils/renderLayoutModel";

function refKey(ref) {
  return ref ? `${ref.type}:${String(ref.id)}` : "";
}

function sameRef(left, right) {
  return refKey(left) === refKey(right);
}

function normalizeDegrees(value) {
  const normalized = ((Number(value) || 0) + 180) % 360;
  return (normalized < 0 ? normalized + 360 : normalized) - 180;
}

function CanvasNode({
  node,
  owningGroup = null,
  disabled = false,
  typographyScale = 1,
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
}) {
  const [transientTypographyScale, setTransientTypographyScale] = useState(1);

  useEffect(() => {
    setTransientTypographyScale(1);
  }, [pageSessionKey, previewResetToken]);

  const isRefSelected = ref => selectedRefs.some(selectedRef => sameRef(selectedRef, ref));
  const isRefHovered = ref => hoveredRef != null && sameRef(hoveredRef, ref);

  if (node.kind !== "group") {
    const { type, data, index: elementIndex } = node;
    const elementRef = { type, id: data.id };
    const isInteractionDisabled = disabled
      || (owningGroup == null && layoutModel.getNodeLayerState(elementRef).isLocked);
    const isSelected = isRefSelected(elementRef);
    const isMultiTransformTarget = selectedRefs.length > 1 && isSelected && owningGroup == null;
    const isHovered = !isInteractionDisabled && owningGroup == null && isRefHovered(elementRef);
    const nodeContext = {
      isSelectMode: activeTool === "select",
      photoSlotDimensionMode,
      currentPageIndex: pageIndex,
      updateElement: onUpdateElement,
      onSelectElement: onSelectRef,
      onActivateElement: onActivateRef,
      onGestureStart,
      onGestureEnd,
    };

    if (type === "photo") {
      const visiblePhotoIndex = (
        visiblePhotoOrdinals.get(String(data.id)) ?? (elementIndex + 1)
      ) - 1;
      const controlProps = makePhotoControlProps(data, nodeContext);
      if (isInteractionDisabled) Object.assign(controlProps, { draggable: false, listening: false });
      if (isMultiTransformTarget) {
        Object.assign(controlProps, { onTransformStart: undefined, onTransformEnd: undefined });
      }
      if (owningGroup) {
        Object.assign(controlProps, {
          draggable: false,
          listening: activeTool === "select" && !disabled,
          onClick: (event) => {
            event.cancelBubble = true;
            onSelectRef({ type: "group", id: owningGroup.id }, {
              additive: !!event.evt?.shiftKey,
            });
          },
          onTap: (event) => {
            event.cancelBubble = true;
            onSelectRef({ type: "group", id: owningGroup.id }, {
              additive: !!event.evt?.shiftKey,
            });
          },
          onDblClick: (event) => {
            event.cancelBubble = true;
            onEnterGroup(owningGroup.id, elementRef);
          },
          onDblTap: (event) => {
            event.cancelBubble = true;
            onEnterGroup(owningGroup.id, elementRef);
          },
        });
      }
      return renderPhotoSlotNode(
        data,
        visiblePhotoIndex,
        isSelected,
        isHovered,
        controlProps,
        nodeContext,
      );
    }

    const groupProps = makeGroupProps(type, data, nodeContext);
    if (isInteractionDisabled) Object.assign(groupProps, { draggable: false, listening: false });
    if (isMultiTransformTarget) {
      Object.assign(groupProps, { onTransformStart: undefined, onTransformEnd: undefined });
    }
    if (owningGroup) {
      Object.assign(groupProps, {
        draggable: false,
        listening: activeTool === "select" && !disabled,
        onClick: (event) => {
          event.cancelBubble = true;
          onSelectRef({ type: "group", id: owningGroup.id }, {
            additive: !!event.evt?.shiftKey,
          });
        },
        onTap: (event) => {
          event.cancelBubble = true;
          onSelectRef({ type: "group", id: owningGroup.id }, {
            additive: !!event.evt?.shiftKey,
          });
        },
        onDblClick: (event) => {
          event.cancelBubble = true;
          onEnterGroup(owningGroup.id, elementRef);
        },
        onDblTap: (event) => {
          event.cancelBubble = true;
          onEnterGroup(owningGroup.id, elementRef);
        },
      });
    }

    if (type === "text") return renderTextLabelNode(
      data,
      isSelected,
      groupProps,
      {
        isHovered,
        suppressSelectedStroke: selectedRefs.length === 1,
        typographyScale,
      },
    );
    if (type === "sticker") return (
      <StickerNode
        sticker={data}
        templateId={templateId}
        isHovered={isHovered}
        isSelected={isSelected}
        suppressSelectedStroke={selectedRefs.length === 1}
        groupProps={groupProps}
      />
    );
    return null;
  }

  const group = node.data;
  const groupRef = { type: "group", id: group.id };
  const groupLayerState = layoutModel.getNodeLayerState(groupRef);
  const isSelected = isRefSelected(groupRef);
  const isHovered = !groupLayerState.isLocked && isRefHovered(groupRef);
  const bounds = layoutModel.getNodeBounds(groupRef);
  const center = {
    x: toDisplayCoord(bounds.centerX),
    y: toDisplayCoord(bounds.centerY),
  };
  const displayWidth = toDisplayCoord(bounds.width);
  const displayHeight = toDisplayCoord(bounds.height);
  const baseRotation = bounds.rotation ?? group.selection_rotation ?? 0;

  const syncGroupVisualNode = (controlNode) => {
    const visualNode = controlNode.getLayer()?.findOne(
      candidate => candidate.id() === `group-visual-${group.id}`,
    );
    if (!visualNode) return;
    visualNode.position(controlNode.position());
    visualNode.rotation(controlNode.rotation());
    visualNode.scale({ x: controlNode.scaleX(), y: controlNode.scaleY() });
    visualNode.getLayer()?.batchDraw();
  };
  const resetTransientTransform = (konvaNode) => {
    konvaNode.position(center);
    konvaNode.rotation(baseRotation);
    konvaNode.scale({ x: 1, y: 1 });
    syncGroupVisualNode(konvaNode);
    setTransientTypographyScale(1);
  };
  const commitGroupTransform = (konvaNode, { includeScaleAndRotation }) => {
    const dx = toRealCoord(konvaNode.x() - center.x);
    const dy = toRealCoord(konvaNode.y() - center.y);
    const scale = includeScaleAndRotation
      ? (Math.abs(konvaNode.scaleX()) + Math.abs(konvaNode.scaleY())) / 2
      : 1;
    const rotationDelta = includeScaleAndRotation
      ? normalizeDegrees(konvaNode.rotation() - baseRotation)
      : 0;
    resetTransientTransform(konvaNode);
    try {
      onCommitLayout(currentLayout => transformGroup(currentLayout, group.id, {
        dx,
        dy,
        rotationDelta,
        scale,
      }));
    } catch (error) {
      onError(error?.message || "無法變形群組");
    } finally {
      onGestureEnd();
    }
  };

  return (
    <Fragment>
      <KonvaGroup
        id={`group-visual-${group.id}`}
        x={center.x}
        y={center.y}
        rotation={baseRotation}
        listening={false}
      >
        <KonvaGroup rotation={-baseRotation}>
          <KonvaGroup x={-center.x} y={-center.y}>
            {flattenRenderNodes([node], { visibleOnly: true }).map(childNode => (
              <CanvasNode
                key={`group-leaf-${childNode.type}-${childNode.id}`}
                node={childNode}
                owningGroup={group}
                disabled={disabled}
                typographyScale={transientTypographyScale}
                layoutModel={layoutModel}
                pageSessionKey={pageSessionKey}
                previewResetToken={previewResetToken}
                activeTool={activeTool}
                selectedRefs={selectedRefs}
                hoveredRef={hoveredRef}
                templateId={templateId}
                pageIndex={pageIndex}
                photoSlotDimensionMode={photoSlotDimensionMode}
                visiblePhotoOrdinals={visiblePhotoOrdinals}
                onUpdateElement={onUpdateElement}
                onSelectRef={onSelectRef}
                onActivateRef={onActivateRef}
                onEnterGroup={onEnterGroup}
                onCommitLayout={onCommitLayout}
                onGestureStart={onGestureStart}
                onGestureEnd={onGestureEnd}
                onError={onError}
              />
            ))}
          </KonvaGroup>
        </KonvaGroup>
      </KonvaGroup>
      <KonvaGroup
        id={`group-${group.id}`}
        x={center.x}
        y={center.y}
        width={displayWidth}
        height={displayHeight}
        rotation={baseRotation}
        scaleX={1}
        scaleY={1}
        draggable={activeTool === "select" && !groupLayerState.isLocked}
        listening={activeTool === "select" && !groupLayerState.isLocked}
        onClick={(event) => {
          event.cancelBubble = true;
          onSelectRef(groupRef, { additive: !!event.evt?.shiftKey });
        }}
        onTap={(event) => {
          event.cancelBubble = true;
          onSelectRef(groupRef, { additive: !!event.evt?.shiftKey });
        }}
        onDblClick={(event) => {
          event.cancelBubble = true;
          onEnterGroup(group.id);
        }}
        onDblTap={(event) => {
          event.cancelBubble = true;
          onEnterGroup(group.id);
        }}
        onDragStart={() => onGestureStart("group-drag")}
        onDragMove={event => syncGroupVisualNode(event.currentTarget)}
        onDragEnd={event => commitGroupTransform(event.currentTarget, {
          includeScaleAndRotation: false,
        })}
        onTransformStart={selectedRefs.length > 1
          ? undefined
          : () => onGestureStart("group-transform")}
        onTransform={(event) => {
          syncGroupVisualNode(event.currentTarget);
          const nodeScale = (
            Math.abs(event.currentTarget.scaleX()) + Math.abs(event.currentTarget.scaleY())
          ) / 2;
          const safeScale = Number.isFinite(nodeScale) && nodeScale > 0 ? nodeScale : 1;
          setTransientTypographyScale(current => (current === safeScale ? current : safeScale));
        }}
        onTransformEnd={selectedRefs.length > 1
          ? undefined
          : event => commitGroupTransform(event.currentTarget, {
              includeScaleAndRotation: true,
            })}
      >
        <Rect
          x={-displayWidth / 2}
          y={-displayHeight / 2}
          width={displayWidth}
          height={displayHeight}
          fill="rgba(255,255,255,0.001)"
        />
        {isHovered && !isSelected && (
          <Rect
            name={OBJECT_HOVER_OUTLINE_NAME}
            x={-displayWidth / 2}
            y={-displayHeight / 2}
            width={displayWidth}
            height={displayHeight}
            fill="transparent"
            stroke={OBJECT_HOVER_STROKE}
            strokeWidth={OBJECT_HOVER_STROKE_WIDTH}
            listening={false}
          />
        )}
      </KonvaGroup>
    </Fragment>
  );
}

export default memo(CanvasNode);
