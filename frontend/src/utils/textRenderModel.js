import { getFontCss, isFontBold } from "../constants/fonts.js";
import { DESIGN_TOKENS } from "../constants/designTokens.js";
import { CANVAS_SCALE } from "./renderLayoutModel.js";
import { resolveTemplatePreviewTextVariables } from "./textVariables.js";

export const TEXT_LAYOUT_MEASUREMENT_SCALE = DESIGN_TOKENS.text_layout.measurement_scale;
export const TEXT_CAPACITY_SAMPLE_CHARACTER = "字";

export function getTextLabelRenderModel(data, typographyScale = 1) {
  const safeTypographyScale = Number.isFinite(typographyScale) && typographyScale > 0
    ? typographyScale
    : 1;
  const fontFamily = data.font_family ?? "msjh";
  const shadowEnabled = !!(data.text_shadow_enabled ?? false);
  return {
    canvasScale: CANVAS_SCALE,
    width: Math.max(1, Number(data.width)),
    height: Math.max(1, Number(data.height)),
    text: data.text ?? "",
    fontSize: Number(data.font_size ?? 24) / safeTypographyScale,
    fontColor: data.font_color ?? "#333333",
    fontFamily: getFontCss(fontFamily),
    fontStyle: isFontBold(fontFamily) ? "bold" : "normal",
    align: data.text_align ?? "center",
    lineHeight: data.line_height ?? 1.4,
    letterSpacing: Number(data.letter_spacing ?? 0) / safeTypographyScale,
    shadowProps: shadowEnabled
      ? {
          shadowEnabled: true,
          shadowColor: data.text_shadow_color ?? "#000000",
          shadowOpacity: (data.text_shadow_opacity ?? 120) / 255,
          shadowOffsetX: (data.text_shadow_offset_x ?? 3) / safeTypographyScale,
          shadowOffsetY: (data.text_shadow_offset_y ?? 3) / safeTypographyScale,
          shadowBlur: (data.text_shadow_blur ?? 4) * 1.74 / safeTypographyScale,
        }
      : {},
  };
}

export function getTemplateTextLabelRenderModel(data, typographyScale = 1) {
  return getTextLabelRenderModel({
    ...data,
    text: resolveTemplatePreviewTextVariables(data.text),
  }, typographyScale);
}

export function measureTextLabelRenderLayout(textModel, KonvaText) {
  const measurementScale = TEXT_LAYOUT_MEASUREMENT_SCALE;
  const commonProps = {
    text: textModel.text,
    width: textModel.width * measurementScale,
    fontSize: textModel.fontSize * measurementScale,
    fontFamily: textModel.fontFamily,
    fontStyle: textModel.fontStyle,
    align: textModel.align,
    verticalAlign: "middle",
    wrap: "word",
    lineHeight: textModel.lineHeight,
    letterSpacing: textModel.letterSpacing * measurementScale,
  };
  const visibleNode = new KonvaText({
    ...commonProps,
    height: textModel.height * measurementScale,
  });
  const fullNode = new KonvaText({
    ...commonProps,
    height: Math.max(
      textModel.height,
      (textModel.text.length + 1) * textModel.fontSize * textModel.lineHeight,
    ) * measurementScale,
  });
  const lineHeightPx = textModel.fontSize * textModel.lineHeight;
  const measurementLineHeight = lineHeightPx * measurementScale;
  const measurementMetrics = visibleNode.measureSize("M");
  const measurementAscent = (
    measurementMetrics.fontBoundingBoxAscent
    ?? measurementMetrics.actualBoundingBoxAscent
  );
  const measurementDescent = (
    measurementMetrics.fontBoundingBoxDescent
    ?? measurementMetrics.actualBoundingBoxDescent
  );
  const measurementBlockTop = (
    textModel.height * measurementScale
    - visibleNode.textArr.length * measurementLineHeight
  ) / 2;
  const firstMeasurementBaseline = measurementBlockTop
    + (measurementLineHeight + measurementAscent - measurementDescent) / 2;

  const actualProbe = new KonvaText({
    ...commonProps,
    text: "M",
    width: textModel.width,
    height: lineHeightPx,
    fontSize: textModel.fontSize,
    letterSpacing: textModel.letterSpacing,
    align: "left",
    wrap: "none",
  });
  const actualMetrics = actualProbe.measureSize("M");
  const actualAscent = (
    actualMetrics.fontBoundingBoxAscent
    ?? actualMetrics.actualBoundingBoxAscent
  );
  const actualDescent = (
    actualMetrics.fontBoundingBoxDescent
    ?? actualMetrics.actualBoundingBoxDescent
  );
  const actualBaselineOffset = (
    lineHeightPx + actualAscent - actualDescent
  ) / 2;

  return {
    fullLines: fullNode.textArr.map(line => line.text),
    visibleLines: visibleNode.textArr.map(line => line.text),
    lineXPositions: visibleNode.textArr.map(line => {
      if (textModel.align === "right") {
        return (visibleNode.width() - line.width) / measurementScale;
      }
      if (textModel.align === "center") {
        return (visibleNode.width() - line.width) / 2 / measurementScale;
      }
      return 0;
    }),
    lineBaselines: visibleNode.textArr.map(
      (_, lineIndex) => (
        firstMeasurementBaseline + lineIndex * measurementLineHeight
      ) / measurementScale,
    ),
    lineYPositions: visibleNode.textArr.map(
      (_, lineIndex) => (
        firstMeasurementBaseline + lineIndex * measurementLineHeight
      ) / measurementScale - actualBaselineOffset,
    ),
    lineHeightPx,
  };
}

export function measureTextLabelCjkCapacity(data, KonvaText) {
  const width = Number(data.width);
  const height = Number(data.height);
  const fontSize = Number(data.font_size ?? 24);
  const lineHeight = Number(data.line_height ?? 1.4);
  const letterSpacing = Number(data.letter_spacing ?? 0);
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || !Number.isFinite(fontSize)
    || !Number.isFinite(lineHeight)
    || !Number.isFinite(letterSpacing)
    || width < 0
    || height < 0
    || fontSize <= 0
    || lineHeight <= 0
  ) {
    return null;
  }
  if (width === 0 || height === 0) return 0;

  const baseModel = getTextLabelRenderModel({
    ...data,
    text: "",
  });
  const measurementScale = TEXT_LAYOUT_MEASUREMENT_SCALE;
  const characterProbe = new KonvaText({
    text: TEXT_CAPACITY_SAMPLE_CHARACTER,
    fontSize: baseModel.fontSize * measurementScale,
    fontFamily: baseModel.fontFamily,
    fontStyle: baseModel.fontStyle,
    lineHeight: baseModel.lineHeight,
    letterSpacing: baseModel.letterSpacing * measurementScale,
    wrap: "none",
  });
  const characterWidth = Number(characterProbe.textArr?.[0]?.width);
  characterProbe.destroy?.();
  if (!Number.isFinite(characterWidth) || characterWidth <= 0) return null;

  const scaledFrameWidth = baseModel.width * measurementScale;
  const lineHeightPx = baseModel.fontSize * baseModel.lineHeight;
  const charactersPerLine = Math.floor(
    (scaledFrameWidth + Number.EPSILON * scaledFrameWidth) / characterWidth,
  );
  const visibleLineCount = Math.floor(
    (baseModel.height + Number.EPSILON * baseModel.height) / lineHeightPx,
  );
  if (charactersPerLine <= 0 || visibleLineCount <= 0) return 0;
  return charactersPerLine * visibleLineCount;
}

export function getTextLabelClipGroupProps(textModel) {
  return {
    scaleX: textModel.canvasScale,
    scaleY: textModel.canvasScale,
    clipX: 0,
    clipY: 0,
    clipWidth: textModel.width,
    clipHeight: textModel.height,
    listening: false,
  };
}

export function getTextLabelLineRenderProps(textModel, textLayout, lineIndex) {
  return {
    x: textLayout.lineXPositions[lineIndex],
    y: textLayout.lineYPositions[lineIndex],
    height: textLayout.lineHeightPx,
    text: textLayout.visibleLines[lineIndex],
    fontSize: textModel.fontSize,
    fill: textModel.fontColor,
    fontFamily: textModel.fontFamily,
    fontStyle: textModel.fontStyle,
    align: "left",
    verticalAlign: "middle",
    wrap: "none",
    lineHeight: textModel.lineHeight,
    letterSpacing: textModel.letterSpacing,
    ...textModel.shadowProps,
    listening: false,
  };
}
