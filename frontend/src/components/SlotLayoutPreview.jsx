// 版型預覽縮圖：顯示模板頁面背景與所有照片格位置，目標格用靛藍高亮
// 供 ClassEdit 共用照片面板與 BatchPhotoWizard 內使用

import { getPhotoFrameRect, getPhotoSlotDimensionMode } from "../utils/photoFrameGeometry.js";
import { CANVAS_REAL_WIDTH, CANVAS_REAL_HEIGHT } from "../utils/renderLayoutModel";
import { getVisibleLayoutElements } from "../utils/layoutLayerState.js";

export default function SlotLayoutPreview({
  page,
  templateId,
  slotId,
  height = 200,
  className = "",
}) {
  if (!page) return null;
  const layout = page.layout || {};
  const canvasW = layout.canvas_width || CANVAS_REAL_WIDTH;
  const canvasH = layout.canvas_height || CANVAS_REAL_HEIGHT;
  const slots = getVisibleLayoutElements(layout, "photo");
  const photoSlotDimensionMode = getPhotoSlotDimensionMode(layout);
  const scale = height / canvasH;
  const previewW = Math.round(canvasW * scale);
  const previewH = Math.round(canvasH * scale);
  const bgUrl = page.background_filename && templateId
    ? `/api/templates/${templateId}/pages/${page.id}/background`
    : null;

  return (
    <div
      className={`relative overflow-hidden rounded border border-gray-300 bg-white ${className}`}
      style={{ width: previewW, height: previewH }}
    >
      {bgUrl && (
        <img
          src={bgUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      )}
      {slots.map((slot) => {
        const isTarget = slotId != null && String(slot.id) === String(slotId);
        const frameRect = getPhotoFrameRect(slot, { dimensionMode: photoSlotDimensionMode });
        return (
          <div
            key={slot.id}
            className={`absolute ${
              isTarget
                ? "bg-indigo-500/40 border-2 border-indigo-600"
                : "border border-dashed border-gray-400/70"
            }`}
            style={{
              left: Math.round(frameRect.x * scale),
              top: Math.round(frameRect.y * scale),
              width: Math.round(frameRect.width * scale),
              height: Math.round(frameRect.height * scale),
            }}
          />
        );
      })}
    </div>
  );
}
