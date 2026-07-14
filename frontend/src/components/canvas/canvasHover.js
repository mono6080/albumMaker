export const OBJECT_HOVER_OUTLINE_NAME = "object-hover-outline";
export const OBJECT_HOVER_STROKE = "#6366F1";
export const OBJECT_HOVER_STROKE_WIDTH = 1.5;

const CANVAS_ELEMENT_ID = /^(photo|text|sticker|group)-(.+)$/;

export function getCanvasElementRefFromTarget(target, stage = target?.getStage?.()) {
  let node = target;

  while (node && node !== stage) {
    const nodeId = typeof node.id === "function" ? node.id() : "";
    const match = CANVAS_ELEMENT_ID.exec(nodeId);
    if (match) return { type: match[1], id: match[2] };
    node = typeof node.getParent === "function" ? node.getParent() : null;
  }

  return null;
}
