import { getNodeBounds, getScopeNodes } from "./layoutGroups.js";
import { getNodeLayerState } from "./layoutLayerState.js";

const EPSILON = 1e-6;

function rotatePoint(point, center, degrees) {
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

export function normalizeSelectionRect(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function rectCorners(rect) {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < (
        (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)
        / ((previousPoint.y - currentPoint.y) || EPSILON)
        + currentPoint.x
      );
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(first, second, third) {
  const value = (second.y - first.y) * (third.x - second.x)
    - (second.x - first.x) * (third.y - second.y);
  if (Math.abs(value) <= EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

function pointOnSegment(first, point, second) {
  return point.x <= Math.max(first.x, second.x) + EPSILON
    && point.x + EPSILON >= Math.min(first.x, second.x)
    && point.y <= Math.max(first.y, second.y) + EPSILON
    && point.y + EPSILON >= Math.min(first.y, second.y);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  if (firstOrientation !== secondOrientation && thirdOrientation !== fourthOrientation) return true;
  return (firstOrientation === 0 && pointOnSegment(firstStart, secondStart, firstEnd))
    || (secondOrientation === 0 && pointOnSegment(firstStart, secondEnd, firstEnd))
    || (thirdOrientation === 0 && pointOnSegment(secondStart, firstStart, secondEnd))
    || (fourthOrientation === 0 && pointOnSegment(secondStart, firstEnd, secondEnd));
}

function polygonsIntersect(firstPolygon, secondPolygon) {
  if (firstPolygon.some(point => pointInPolygon(point, secondPolygon))) return true;
  if (secondPolygon.some(point => pointInPolygon(point, firstPolygon))) return true;
  for (let firstIndex = 0; firstIndex < firstPolygon.length; firstIndex += 1) {
    const firstStart = firstPolygon[firstIndex];
    const firstEnd = firstPolygon[(firstIndex + 1) % firstPolygon.length];
    for (let secondIndex = 0; secondIndex < secondPolygon.length; secondIndex += 1) {
      const secondStart = secondPolygon[secondIndex];
      const secondEnd = secondPolygon[(secondIndex + 1) % secondPolygon.length];
      if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return true;
    }
  }
  return false;
}

export function getMarqueeSelectableRefs(
  layout,
  selectionRect,
  { parentGroupId = null } = {},
) {
  if (!selectionRect || selectionRect.width <= 0 || selectionRect.height <= 0) return [];
  const selectionPolygon = rectCorners(selectionRect);
  return getScopeNodes(layout || {}, parentGroupId).filter(ref => {
    try {
      const layerState = getNodeLayerState(layout, ref);
      if (!layerState.isVisible || layerState.isLocked) return false;
      return polygonsIntersect(selectionPolygon, getNodeBounds(layout, ref).corners);
    } catch {
      return false;
    }
  });
}

export function pointIsInsideOrientedBounds(point, bounds) {
  if (!point || !bounds) return false;
  const center = { x: Number(bounds.centerX) || 0, y: Number(bounds.centerY) || 0 };
  const localPoint = rotatePoint(point, center, -(Number(bounds.rotation) || 0));
  return Math.abs(localPoint.x - center.x) <= Number(bounds.width) / 2 + EPSILON
    && Math.abs(localPoint.y - center.y) <= Number(bounds.height) / 2 + EPSILON;
}
