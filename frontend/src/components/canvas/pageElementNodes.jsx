// 模板編輯器畫布元素的 Konva 節點渲染函式
// 從 TemplateEditor 抽出；依賴的頁面 state（選取工具、頁碼、照片格尺寸模式、
// 更新與選取回呼）一律以 ctx 參數傳入，不建立額外 context。

import { Fragment } from "react";
import { Group, Rect, Text as KonvaText } from "react-konva";

import { getFontCss, isFontBold } from "../../constants/fonts";
import {
  CANVAS_REAL_HEIGHT,
  CANVAS_REAL_WIDTH,
  getFooterModel,
  toDisplayCoord,
  toRealCoord,
} from "../../utils/renderLayoutModel";
import {
  PHOTO_CONTENT_MIN_WIDTH,
  buildPhotoSlotFromContentRect,
  getPhotoContentRect,
  getPhotoFrameInsets,
  getPhotoFrameRect,
  snapPhotoSlotStandardRatio,
} from "../../utils/photoFrameGeometry.js";
import { isFillableTextLabel } from "../../utils/textLabelRoles";
import {
  OBJECT_HOVER_OUTLINE_NAME,
  OBJECT_HOVER_STROKE,
  OBJECT_HOVER_STROKE_WIDTH,
} from "./canvasHover.js";

const PHOTO_CONTENT_MIN_HEIGHT = 40;

function clampValue(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

export function clampPhotoContentRect(contentRect) {
  const width = Math.max(PHOTO_CONTENT_MIN_WIDTH, Math.round(Number(contentRect.width) || PHOTO_CONTENT_MIN_WIDTH));
  const height = Math.max(PHOTO_CONTENT_MIN_HEIGHT, Math.round(Number(contentRect.height) || PHOTO_CONTENT_MIN_HEIGHT));
  const maxX = Math.max(0, CANVAS_REAL_WIDTH - width);
  const maxY = Math.max(0, CANVAS_REAL_HEIGHT - height);

  return {
    x: clampValue(Math.round(Number(contentRect.x) || 0), 0, maxX),
    y: clampValue(Math.round(Number(contentRect.y) || 0), 0, maxY),
    width,
    height,
  };
}

export function applyPhotoEditorUpdates(slot, updates, dimensionMode) {
  const currentContent = getPhotoContentRect(slot, { dimensionMode });
  const nextStyleSlot = { ...slot, ...updates };
  const nextContent = clampPhotoContentRect({
    x: updates.x ?? currentContent.x,
    y: updates.y ?? currentContent.y,
    width: updates.width ?? currentContent.width,
    height: updates.height ?? currentContent.height,
  });

  return buildPhotoSlotFromContentRect(nextStyleSlot, nextContent, { dimensionMode });
}

// ── 元素 Group 共用 Konva 屬性 ──────────────────────────────────────────────

export function makeGroupProps(type, data, {
  isSelectMode,
  updateElement,
  setSelectedElement,
  onSelectElement,
  onActivateElement,
  onGestureStart,
  onGestureEnd,
}) {
  const displayX = toDisplayCoord(data.x);
  const displayY = toDisplayCoord(data.y);
  const displayW = toDisplayCoord(data.width);
  const displayH = toDisplayCoord(data.height);

  return {
    id: `${type}-${data.id}`,
    x: displayX + displayW / 2,
    y: displayY + displayH / 2,
    offsetX: displayW / 2,
    offsetY: displayH / 2,
    width: displayW,
    height: displayH,
    rotation: data.rotation ?? 0,
    scaleX: 1,
    scaleY: 1,
    draggable: isSelectMode,
    listening: isSelectMode,
    onDragStart: () => onGestureStart?.("element-drag"),
    onDragEnd: (e) => {
      try {
        const node = e.target;
        updateElement(type, data.id, {
          x: clampValue(toRealCoord(node.x() - node.offsetX()), 0, CANVAS_REAL_WIDTH - data.width),
          y: clampValue(toRealCoord(node.y() - node.offsetY()), 0, CANVAS_REAL_HEIGHT - data.height),
        });
      } finally {
        onGestureEnd?.();
      }
    },
    onTransformStart: () => onGestureStart?.("element-transform"),
    onTransformEnd: (e) => {
      try {
        const node = e.target;
        const newDisplayW = Math.max(toDisplayCoord(60), node.width() * Math.abs(node.scaleX()));
        const newDisplayH = Math.max(toDisplayCoord(40), node.height() * Math.abs(node.scaleY()));
        // 正規化 scale 並更新 offset，保持中心旋轉軸正確
        node.scaleX(1); node.scaleY(1);
        node.offsetX(newDisplayW / 2); node.offsetY(newDisplayH / 2);
        node.width(newDisplayW); node.height(newDisplayH);
        updateElement(type, data.id, {
          x: toRealCoord(node.x() - node.offsetX()),
          y: toRealCoord(node.y() - node.offsetY()),
          width: Math.max(60, toRealCoord(newDisplayW)),
          height: Math.max(40, toRealCoord(newDisplayH)),
          rotation: node.rotation(),
        });
      } finally {
        onGestureEnd?.();
      }
    },
    onClick: (e) => {
      e.cancelBubble = true;
      const element = { type, id: data.id };
      if (onSelectElement) {
        onSelectElement(element, {
          additive: !!e.evt?.shiftKey,
          sourceEvent: e.evt,
        });
      } else {
        setSelectedElement?.(element);
      }
    },
    onTap: (e) => {
      e.cancelBubble = true;
      const element = { type, id: data.id };
      if (onSelectElement) {
        onSelectElement(element, {
          additive: !!e.evt?.shiftKey,
          sourceEvent: e.evt,
        });
      } else {
        setSelectedElement?.(element);
      }
    },
    onDblClick: (e) => {
      e.cancelBubble = true;
      onActivateElement?.({ type, id: data.id }, { sourceEvent: e.evt });
    },
    onDblTap: (e) => {
      e.cancelBubble = true;
      onActivateElement?.({ type, id: data.id }, { sourceEvent: e.evt });
    },
  };
}

export function makePhotoControlProps(data, {
  isSelectMode,
  photoSlotDimensionMode,
  updateElement,
  setSelectedElement,
  onSelectElement,
  onActivateElement,
  onGestureStart,
  onGestureEnd,
}) {
  const frameRect = getPhotoFrameRect(data, { dimensionMode: photoSlotDimensionMode });
  const contentRect = getPhotoContentRect(data, { dimensionMode: photoSlotDimensionMode });
  const insets = getPhotoFrameInsets(data);
  const displayContentW = toDisplayCoord(contentRect.width);
  const displayContentH = toDisplayCoord(contentRect.height);

  return {
    id: `photo-${data.id}`,
    x: toDisplayCoord(frameRect.x + frameRect.width / 2),
    y: toDisplayCoord(frameRect.y + frameRect.height / 2),
    offsetX: toDisplayCoord(frameRect.width / 2 - insets.left),
    offsetY: toDisplayCoord(frameRect.height / 2 - insets.top),
    width: displayContentW,
    height: displayContentH,
    rotation: data.rotation ?? 0,
    scaleX: 1,
    scaleY: 1,
    draggable: isSelectMode,
    listening: isSelectMode,
    onDragStart: () => onGestureStart?.("photo-drag"),
    onDragEnd: (e) => {
      try {
        const node = e.target;
        const nextSlot = applyPhotoEditorUpdates(data, {
          x: toRealCoord(node.x() - node.offsetX()),
          y: toRealCoord(node.y() - node.offsetY()),
        }, photoSlotDimensionMode);
        updateElement("photo", data.id, {
          x: nextSlot.x,
          y: nextSlot.y,
          width: nextSlot.width,
          height: nextSlot.height,
        });
      } finally {
        onGestureEnd?.();
      }
    },
    onTransformStart: () => onGestureStart?.("photo-transform"),
    onTransformEnd: (e) => {
      try {
        const node = e.target;
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        // 觸及最小尺寸時等比放大兩邊，維持照片格長寬比例不變
        let newDisplayW = node.width() * Math.abs(scaleX);
        let newDisplayH = node.height() * Math.abs(scaleY);
        const minRatioScale = Math.max(
          toDisplayCoord(PHOTO_CONTENT_MIN_WIDTH) / newDisplayW,
          toDisplayCoord(PHOTO_CONTENT_MIN_HEIGHT) / newDisplayH,
          1,
        );
        newDisplayW *= minRatioScale;
        newDisplayH *= minRatioScale;
        // 標準比例照片格縮放後 snap 回整數精確的 3:4 / 4:3，避免捨入誤差累積
        let nextRealW = toRealCoord(newDisplayW);
        let nextRealH = toRealCoord(newDisplayH);
        const snapped = snapPhotoSlotStandardRatio(data.width, data.height, "width", nextRealW);
        if (snapped) ({ width: nextRealW, height: nextRealH } = snapped);
        const nextSlot = applyPhotoEditorUpdates(data, {
          x: toRealCoord(node.x() - node.offsetX() * scaleX),
          y: toRealCoord(node.y() - node.offsetY() * scaleY),
          width: nextRealW,
          height: nextRealH,
          rotation: node.rotation(),
        }, photoSlotDimensionMode);

        node.scaleX(1); node.scaleY(1);
        node.width(newDisplayW); node.height(newDisplayH);
        updateElement("photo", data.id, {
          x: nextSlot.x,
          y: nextSlot.y,
          width: nextSlot.width,
          height: nextSlot.height,
          rotation: nextSlot.rotation,
        });
      } finally {
        onGestureEnd?.();
      }
    },
    onClick: (e) => {
      e.cancelBubble = true;
      const element = { type: "photo", id: data.id };
      if (onSelectElement) {
        onSelectElement(element, {
          additive: !!e.evt?.shiftKey,
          sourceEvent: e.evt,
        });
      } else {
        setSelectedElement?.(element);
      }
    },
    onTap: (e) => {
      e.cancelBubble = true;
      const element = { type: "photo", id: data.id };
      if (onSelectElement) {
        onSelectElement(element, {
          additive: !!e.evt?.shiftKey,
          sourceEvent: e.evt,
        });
      } else {
        setSelectedElement?.(element);
      }
    },
    onDblClick: (e) => {
      e.cancelBubble = true;
      onActivateElement?.({ type: "photo", id: data.id }, { sourceEvent: e.evt });
    },
    onDblTap: (e) => {
      e.cancelBubble = true;
      onActivateElement?.({ type: "photo", id: data.id }, { sourceEvent: e.evt });
    },
  };
}

// ── 各元素節點渲染 ──────────────────────────────────────────────────────────

export function getTextShadowProps(data, typographyScale = 1) {
  const shadowEnabled = !!(data.text_shadow_enabled ?? false);
  if (!shadowEnabled) return {};
  const safeScale = Number.isFinite(typographyScale) && typographyScale > 0 ? typographyScale : 1;

  return {
    shadowEnabled: true,
    shadowColor: data.text_shadow_color ?? "#000000",
    shadowOpacity: (data.text_shadow_opacity ?? 120) / 255,
    shadowOffsetX: toDisplayCoord(data.text_shadow_offset_x ?? 3) / safeScale,
    shadowOffsetY: toDisplayCoord(data.text_shadow_offset_y ?? 3) / safeScale,
    shadowBlur: toDisplayCoord(data.text_shadow_blur ?? 4) * 1.74 / safeScale,
  };
}

export function renderPhotoSlotNode(
  data,
  elemIndex,
  isSelected,
  isHovered,
  controlProps,
  { photoSlotDimensionMode, currentPageIndex },
) {
  const frameRect = getPhotoFrameRect(data, { dimensionMode: photoSlotDimensionMode });
  const contentRect = getPhotoContentRect(data, { dimensionMode: photoSlotDimensionMode });
  const insets = getPhotoFrameInsets(data);
  const displayW = toDisplayCoord(frameRect.width);
  const displayH = toDisplayCoord(frameRect.height);
  const contentDisplayW = toDisplayCoord(contentRect.width);
  const contentDisplayH = toDisplayCoord(contentRect.height);
  const contentDisplayX = toDisplayCoord(contentRect.x - frameRect.x);
  const contentDisplayY = toDisplayCoord(contentRect.y - frameRect.y);
  const hasBorder = data.border !== false;
  const borderDisplayW = toDisplayCoord(insets.borderWidth);
  const slotRadius = toDisplayCoord(data.border_radius ?? 0);
  const shadowEnabled = data.shadow_enabled ?? hasBorder;
  const shadowX = shadowEnabled ? toDisplayCoord(data.shadow_offset_x ?? 5) : 0;
  const shadowY = shadowEnabled ? toDisplayCoord(data.shadow_offset_y ?? 8) : 0;
  // HTML Canvas2D shadowBlur 的 sigma = shadowBlur/2，PIL GaussianBlur(radius) 的實測 sigma ≈ radius*0.87
  // 量測換算：需要 Canvas2D shadowBlur = toDisplayCoord(pil_blur) * 1.74 使兩者視覺一致
  const shadowBlur = shadowEnabled ? toDisplayCoord(data.shadow_blur ?? 14) * 1.74 : 0;
  const shadowOpacity = shadowEnabled ? (data.shadow_opacity ?? 120) / 255 : 0;
  return (
    <Fragment key={`photo-${data.id}`}>
      <Group
        key={`photo-visual-${data.id}`}
        x={toDisplayCoord(frameRect.x + frameRect.width / 2)}
        y={toDisplayCoord(frameRect.y + frameRect.height / 2)}
        offsetX={displayW / 2}
        offsetY={displayH / 2}
        rotation={data.rotation ?? 0}
        listening={false}
      >
        <Rect
          width={displayW} height={displayH}
          fill={hasBorder ? "#ffffff" : "#EEEEEE"}
          cornerRadius={slotRadius}
          stroke={hasBorder ? "#e2e8f0" : "#CCCCCC"}
          strokeWidth={1}
          shadowColor="black"
          shadowOpacity={shadowOpacity}
          shadowOffsetX={shadowX}
          shadowOffsetY={shadowY}
          shadowBlur={shadowBlur}
          listening={false}
        />
        {hasBorder && (
          <Rect
            x={contentDisplayX}
            y={contentDisplayY}
            width={contentDisplayW}
            height={contentDisplayH}
            fill="#EEEEEE"
            cornerRadius={Math.max(0, slotRadius - borderDisplayW)}
            listening={false}
          />
        )}
        <KonvaText
          x={contentDisplayX} y={contentDisplayY}
          width={contentDisplayW} height={contentDisplayH}
          text={`P${currentPageIndex + 1}·${elemIndex + 1}`}
          fontSize={10}
          fill="#AAAAAA"
          align="center"
          verticalAlign="middle"
          listening={false}
        />
      </Group>
      <Group key={`photo-control-${data.id}`} {...controlProps}>
        <Rect
          name={isHovered && !isSelected ? OBJECT_HOVER_OUTLINE_NAME : undefined}
          width={contentDisplayW}
          height={contentDisplayH}
          fill={isSelected ? "rgba(79,70,229,0.03)" : "rgba(255,255,255,0.01)"}
          stroke={isHovered && !isSelected ? OBJECT_HOVER_STROKE : undefined}
          strokeWidth={isHovered && !isSelected ? OBJECT_HOVER_STROKE_WIDTH : 0}
        />
      </Group>
    </Fragment>
  );
}

export function renderTextLabelNode(
  data,
  isSelected,
  groupProps,
  { isHovered = false, suppressSelectedStroke = false, typographyScale = 1 } = {},
) {
  const displayW = toDisplayCoord(data.width);
  const displayH = toDisplayCoord(data.height);
  const safeTypographyScale = Number.isFinite(typographyScale) && typographyScale > 0
    ? typographyScale
    : 1;
  const fontSize = Math.max(8, toDisplayCoord(data.font_size ?? 24)) / safeTypographyScale;
  const textInset = 4 / safeTypographyScale;
  const isFillable = isFillableTextLabel(data);
  const showHoverOutline = isHovered && !isSelected;
  return (
    <Group key={`text-${data.id}`} {...groupProps}>
      <Rect
        name={showHoverOutline ? OBJECT_HOVER_OUTLINE_NAME : undefined}
        width={displayW} height={displayH}
        fill="transparent"
        stroke={showHoverOutline
          ? OBJECT_HOVER_STROKE
          : isSelected && suppressSelectedStroke
          ? "transparent"
          : isSelected ? "#4F46E5" : isFillable ? "transparent" : "#6B7280"}
        strokeWidth={showHoverOutline
          ? OBJECT_HOVER_STROKE_WIDTH
          : isSelected && suppressSelectedStroke ? 0 : isSelected ? 2 : isFillable ? 0 : 1}
        dash={[]}
        listening={false}
      />
      <KonvaText
        name="typography-content"
        x={textInset} y={0}
        width={Math.max(1, displayW - textInset * 2)} height={displayH}
        text={(data.text ?? "").substring(0, 60)}
        fontSize={fontSize}
        fill={data.font_color ?? "#333333"}
        fontFamily={getFontCss(data.font_family)}
        fontStyle={isFontBold(data.font_family) ? "bold" : "normal"}
        align={data.text_align ?? "center"}
        verticalAlign="middle"
        wrap="word"
        lineHeight={data.line_height ?? 1.4}
        letterSpacing={toDisplayCoord(data.letter_spacing ?? 0) / safeTypographyScale}
        {...getTextShadowProps(data, safeTypographyScale)}
        listening={false}
      />
      {/* 透明點擊感應區 */}
      <Rect width={displayW} height={displayH} fill="transparent" />
    </Group>
  );
}

export function renderFooterNode(footer) {
  if (!footer?.text) return null;
  const footerModel = getFooterModel(footer);
  return (
    <KonvaText
      key="footer"
      x={footerModel.box.x}
      y={footerModel.box.y}
      width={footerModel.box.width}
      height={footerModel.box.height}
      text={footerModel.text}
      fontSize={footerModel.fontSize}
      fill={footerModel.fontColor}
      fontFamily={getFontCss(footer.font_family)}
      fontStyle={isFontBold(footer.font_family) ? "bold" : "normal"}
      verticalAlign="middle"
      listening={false}
    />
  );
}
