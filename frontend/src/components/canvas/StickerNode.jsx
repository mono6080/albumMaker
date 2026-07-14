// StickerNode — 貼圖素材 Konva 節點（非同步載入圖片）

import { useState, useEffect } from "react";
import { Group, Image as KonvaImage, Rect } from "react-konva";

import { buildStickerUrl } from "../../api/urls";
import {
  OBJECT_HOVER_OUTLINE_NAME,
  OBJECT_HOVER_STROKE,
  OBJECT_HOVER_STROKE_WIDTH,
} from "./canvasHover.js";

export default function StickerNode({
  sticker,
  templateId,
  isHovered = false,
  isSelected,
  groupProps,
  suppressSelectedStroke = false,
}) {
  const [image, setImage] = useState(null);
  const displayW = groupProps.width;
  const displayH = groupProps.height;
  const showHoverOutline = isHovered && !isSelected;

  useEffect(() => {
    const img = new window.Image();
    img.src = buildStickerUrl(templateId, sticker.filename);
    img.onload = () => setImage(img);
    img.onerror = () => setImage(null);
  }, [sticker.filename, templateId]);

  return (
    <Group {...groupProps}>
      {image && (
        <KonvaImage image={image} width={displayW} height={displayH} listening={false} />
      )}
      {(showHoverOutline || (isSelected && !suppressSelectedStroke)) && (
        <Rect
          name={showHoverOutline ? OBJECT_HOVER_OUTLINE_NAME : undefined}
          width={displayW} height={displayH}
          fill="transparent"
          stroke={showHoverOutline ? OBJECT_HOVER_STROKE : "#4F46E5"}
          strokeWidth={showHoverOutline ? OBJECT_HOVER_STROKE_WIDTH : 2}
          listening={false}
        />
      )}
      {/* 透明矩形作為點擊感應區 */}
      <Rect width={displayW} height={displayH} fill="transparent" />
    </Group>
  );
}
