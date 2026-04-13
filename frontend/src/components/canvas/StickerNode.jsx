// StickerNode — 貼圖素材 Konva 節點（非同步載入圖片）

import { useState, useEffect } from "react";
import { Group, Image as KonvaImage, Rect } from "react-konva";

import { buildStickerUrl } from "../../api/urls";

export default function StickerNode({ sticker, templateId, isSelected, groupProps }) {
  const [image, setImage] = useState(null);
  const displayW = groupProps.width;
  const displayH = groupProps.height;

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
      {isSelected && (
        <Rect
          width={displayW} height={displayH}
          fill="transparent"
          stroke="#4F46E5" strokeWidth={2}
          listening={false}
        />
      )}
      {/* 透明矩形作為點擊感應區 */}
      <Rect width={displayW} height={displayH} fill="transparent" />
    </Group>
  );
}
